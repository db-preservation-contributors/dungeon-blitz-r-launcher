//! The damage meter: its window, and what the meter running in it asks of this side.
//!
//! The meter itself is lib/damageMeter's JavaScript, run in the window by
//! src/damage_meter_host.js. This side gives it the game session (server and device token),
//! fetches for it (only from that session's server), keeps its files in the data folder, and
//! answers the save dialog, clipboard and "show in folder". Closing the window hides it, so the
//! last fight is still there when it is opened again, as in the Electron launcher.

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use crate::config::{env_off, read_json};
use crate::{Bus, L};

pub const WINDOW: &str = "damage-meter";
const HOST: &str = include_str!("damage_meter_host.js");
const BUNDLE: &str = include_str!(concat!(env!("OUT_DIR"), "/damage_meter_bundle.js"));
/// The meter's own files in the data folder: settings, and the game data it last fetched.
const OWN_FILES: [&str; 3] = ["damage-meter.json", "damage-meter-powers.json", "damage-meter-bosses.json"];
const DEFAULT_SIZE: (f64, f64) = (620.0, 760.0);
const MIN_SIZE: (f64, f64) = (420.0, 420.0);
const MAX_DATA_BYTES: usize = 64 * 1024 * 1024;
const MAX_SWZ_XML_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Default)]
struct Inner {
    server_url: Option<String>,
    open: bool,
    summary: Option<Value>,
    export_path: Option<PathBuf>,
}

pub struct DamageMeter {
    data_dir: PathBuf,
    version: String,
    bus: Bus,
    inner: Mutex<Inner>,
}

impl DamageMeter {
    pub fn new(data_dir: PathBuf, version: String, bus: Bus) -> Self {
        Self { data_dir, version, bus, inner: Mutex::default() }
    }

    pub fn enabled() -> bool {
        !env_off("DUNGEON_BLITZ_DAMAGE_METER")
    }

    /// What the launcher window shows about the meter.
    pub fn summary(&self) -> Value {
        let inner = self.inner.lock().unwrap();
        let mut summary = inner.summary.clone().unwrap_or_else(|| {
            json!({ "running": false, "supported": null, "live": false, "character": "", "lastError": "" })
        });
        summary["enabled"] = json!(Self::enabled());
        summary["open"] = json!(inner.open);
        summary["session"] = json!(inner.server_url.is_some());
        summary
    }

    fn session_json(&self, token: &str) -> Value {
        match &self.inner.lock().unwrap().server_url {
            Some(url) => json!({ "serverUrl": url, "token": token }),
            None => Value::Null,
        }
    }

    /// A game session started (Some) or ended (None). The window keeps the last fight.
    pub fn set_session(&self, app: &AppHandle, server_url: Option<String>, token: &str) {
        let server_url = server_url.filter(|_| Self::enabled());
        self.inner.lock().unwrap().server_url = server_url;
        if let Some(window) = app.get_webview_window(WINDOW) {
            let _ = window.emit("damage-meter:session", self.session_json(token));
        }
        (self.bus)();
    }

    fn own_file(&self, path: &str) -> bool {
        let wanted = normalize(path);
        OWN_FILES.iter().any(|name| normalize(&self.data_dir.join(name).to_string_lossy()) == wanted)
    }

    fn config_script(&self) -> String {
        let mut files = serde_json::Map::new();
        for name in OWN_FILES {
            let file = self.data_dir.join(name);
            if let Ok(text) = std::fs::read_to_string(&file) {
                files.insert(file.to_string_lossy().into_owned(), json!(text));
            }
        }
        let config = json!({
            "dataDir": self.data_dir.to_string_lossy(),
            "documentsDir": dirs::document_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default(),
            "version": self.version,
            "sep": std::path::MAIN_SEPARATOR.to_string(),
            "bundledDir": "/bundled",
            "files": files,
        });
        format!("window.__DM_CONFIG__ = {config};\n")
    }

    /// Opens the window, or brings it back.
    pub fn open(&self, app: &AppHandle) -> bool {
        if !Self::enabled() {
            return false;
        }
        if let Some(window) = app.get_webview_window(WINDOW) {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            self.inner.lock().unwrap().open = true;
            let _ = window.emit("damage-meter:watch", true);
            (self.bus)();
            return true;
        }
        let settings = read_json(&self.data_dir.join("damage-meter.json")).unwrap_or(Value::Null);
        let pinned = settings.get("pinned").and_then(Value::as_bool).unwrap_or(false);
        let bounds = settings.get("bounds");
        let num = |key: &str| bounds.and_then(|b| b.get(key)).and_then(Value::as_f64);
        let size = match (num("width"), num("height")) {
            (Some(w), Some(h)) if w > 0.0 && h > 0.0 => (w.max(MIN_SIZE.0), h.max(MIN_SIZE.1)),
            _ => DEFAULT_SIZE,
        };
        let script = format!("{}{HOST}\n{BUNDLE}\nwindow.__dmStart();\n", self.config_script());
        let mut builder = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("damage-meter/index.html".into()))
            .title("Damage Meter")
            .inner_size(size.0, size.1)
            .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
            .always_on_top(pinned)
            .initialization_script(&script)
            .on_navigation(|url| {
                matches!(url.scheme(), "tauri" | "asset")
                    || url.host_str() == Some("tauri.localhost")
                    || (cfg!(debug_assertions) && url.host_str() == Some("localhost"))
            });
        if let (Some(x), Some(y)) = (num("x"), num("y")) {
            if on_screen(app, x, y) {
                builder = builder.position(x, y);
            }
        }
        let window = match builder.build() {
            Ok(window) => window,
            Err(error) => {
                println!("[Damage meter] The window could not be opened: {error}");
                return false;
            }
        };
        let handle = app.clone();
        window.on_window_event(move |event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                // Hidden, not closed: its page holds the last fight.
                api.prevent_close();
                if let Some(window) = handle.get_webview_window(WINDOW) {
                    let _ = window.hide();
                    let _ = window.emit("damage-meter:watch", false);
                }
                if let Some(l) = handle.try_state::<L>() {
                    l.meter.inner.lock().unwrap().open = false;
                    l.push();
                }
            }
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                if let Some(window) = handle.get_webview_window(WINDOW) {
                    if let Some(bounds) = logical_bounds(&window) {
                        let _ = window.emit("damage-meter:bounds", bounds);
                    }
                }
            }
            _ => {}
        });
        self.inner.lock().unwrap().open = true;
        (self.bus)();
        true
    }
}

fn normalize(path: &str) -> String {
    let unified = path.replace('\\', "/");
    if cfg!(windows) { unified.to_lowercase() } else { unified }
}

fn on_screen(app: &AppHandle, x: f64, y: f64) -> bool {
    app.available_monitors().unwrap_or_default().iter().any(|m| {
        let scale = m.scale_factor();
        let (mx, my) = (m.position().x as f64 / scale, m.position().y as f64 / scale);
        let (mw, mh) = (m.size().width as f64 / scale, m.size().height as f64 / scale);
        x < mx + mw - 40.0 && x + 100.0 > mx && y >= my - 10.0 && y < my + mh - 40.0
    })
}

fn logical_bounds(window: &WebviewWindow) -> Option<Value> {
    if window.is_minimized().unwrap_or(false) || window.is_maximized().unwrap_or(false) {
        return None;
    }
    let scale = window.scale_factor().ok()?;
    let position = window.outer_position().ok()?.to_logical::<f64>(scale);
    let size = window.inner_size().ok()?.to_logical::<f64>(scale);
    Some(json!({ "x": position.x.round(), "y": position.y.round(), "width": size.width.round(), "height": size.height.round() }))
}

/// A Dungeon Blitz .swz (Game.swz, Login.swz): u32 key, u32 chunk count, then per chunk a u32
/// length and that many bytes XORed with a rolling key, each a zlib-compressed XML file. Same
/// algorithm as lib/damageMeter/swz.js.
pub fn unpack_swz(buf: &[u8]) -> Option<Vec<String>> {
    let be = |at: usize| -> Option<u32> { Some(u32::from_be_bytes(buf.get(at..at + 4)?.try_into().ok()?)) };
    let mut key = be(0)?;
    let count = be(4)? as usize;
    if count > (buf.len() - 8) / 4 {
        return None;
    }
    let mut pos = 8;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let n = be(pos)? as usize;
        pos += 4;
        let bytes = buf.get(pos..pos + n)?;
        let mut chunk = Vec::with_capacity(n);
        for (j, byte) in bytes.iter().enumerate() {
            chunk.push(byte ^ (key & 0xff) as u8);
            let s = (j & 7) as u32;
            if s != 0 {
                key = key.rotate_right(s);
            }
        }
        pos += n;
        let mut xml = String::new();
        flate2::read::ZlibDecoder::new(&chunk[..]).take(MAX_SWZ_XML_BYTES).read_to_string(&mut xml).ok()?;
        out.push(xml);
    }
    Some(out)
}

fn origin(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    matches!(parsed.scheme(), "http" | "https").then(|| parsed.origin().ascii_serialization())
}

/// Only the meter's own window may use these calls.
fn meter_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == WINDOW { Ok(()) } else { Err("not the meter window".into()) }
}

#[tauri::command]
pub fn dm_hello(window: WebviewWindow, l: tauri::State<'_, L>) -> Result<Value, String> {
    meter_window(&window)?;
    Ok(json!({ "session": l.meter.session_json(&l.token()) }))
}

#[tauri::command]
pub fn dm_state(window: WebviewWindow, l: tauri::State<'_, L>, summary: Value) -> Result<(), String> {
    meter_window(&window)?;
    l.meter.inner.lock().unwrap().summary = Some(summary);
    l.push();
    Ok(())
}

/// A fetch for the meter: the combat feed and the game data files, from the session's server only.
#[tauri::command]
pub async fn dm_http(
    window: WebviewWindow,
    l: tauri::State<'_, L>,
    method: String,
    url: String,
    headers: HashMap<String, String>,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    meter_window(&window)?;
    let server = l.meter.inner.lock().unwrap().server_url.clone();
    let allowed = match (server.as_deref().and_then(origin), origin(&url)) {
        (Some(server), Some(asked)) => server == asked,
        _ => false,
    };
    if !allowed {
        return Ok(json!({ "error": "only the game server is fetched" }));
    }
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(10_000).clamp(1_000, 60_000));
    let mut request = crate::net::client().request(method, &url).timeout(timeout);
    for (name, value) in &headers {
        request = request.header(name, value);
    }
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => return Ok(json!({ "error": error.to_string() })),
    };
    let status = response.status().as_u16();
    let content_type = response.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let bytes = match response.bytes().await {
        Ok(bytes) if bytes.len() <= MAX_DATA_BYTES => bytes,
        Ok(_) => return Ok(json!({ "error": "file too large" })),
        Err(error) => return Ok(json!({ "error": error.to_string() })),
    };
    let swz = if status == 200 && url.split('?').next().unwrap_or("").to_lowercase().ends_with(".swz") {
        let data = bytes.to_vec();
        tauri::async_runtime::spawn_blocking(move || unpack_swz(&data)).await.ok().flatten()
    } else {
        None
    };
    let mut answer = json!({
        "status": status,
        "contentType": content_type,
        "body": base64::engine::general_purpose::STANDARD.encode(&bytes),
    });
    if let Some(chunks) = swz {
        answer["swzChunks"] = json!(chunks);
    }
    Ok(answer)
}

#[tauri::command]
pub fn dm_write_file(window: WebviewWindow, l: tauri::State<'_, L>, path: String, text: String) -> Result<(), String> {
    meter_window(&window)?;
    let export = l.meter.inner.lock().unwrap().export_path.clone();
    let is_export = export.map(|p| normalize(&p.to_string_lossy()) == normalize(&path)).unwrap_or(false);
    if !is_export && !l.meter.own_file(&path) {
        return Err("the meter only writes its own files and the export you chose".into());
    }
    if let Some(parent) = Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
pub struct Filter {
    name: String,
    extensions: Vec<String>,
}

#[tauri::command]
pub async fn dm_save_dialog(
    window: WebviewWindow,
    l: tauri::State<'_, L>,
    default_path: String,
    filters: Vec<Filter>,
) -> Result<Option<String>, String> {
    meter_window(&window)?;
    let suggested = PathBuf::from(&default_path);
    if let Some(folder) = suggested.parent() {
        let _ = std::fs::create_dir_all(folder);
    }
    let parent = window.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = parent.dialog().file().set_title("Export DPS results").set_parent(&parent);
        if let Some(folder) = suggested.parent() {
            dialog = dialog.set_directory(folder);
        }
        if let Some(name) = suggested.file_name() {
            dialog = dialog.set_file_name(name.to_string_lossy());
        }
        for filter in &filters {
            let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
            dialog = dialog.add_filter(&filter.name, &extensions);
        }
        dialog.blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?
    .and_then(|p| p.into_path().ok());
    l.meter.inner.lock().unwrap().export_path = picked.clone();
    Ok(picked.map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn dm_clipboard(window: WebviewWindow, app: AppHandle, text: String) -> Result<(), String> {
    meter_window(&window)?;
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn dm_reveal(window: WebviewWindow, app: AppHandle, l: tauri::State<'_, L>, path: String) -> Result<(), String> {
    meter_window(&window)?;
    let export = l.meter.inner.lock().unwrap().export_path.clone();
    match export {
        Some(file) if normalize(&file.to_string_lossy()) == normalize(&path) => {
            app.opener().reveal_item_in_dir(file).map_err(|e| e.to_string())
        }
        _ => Err("only the last export is shown".into()),
    }
}

#[tauri::command]
pub fn dm_error(window: WebviewWindow, message: String) -> Result<(), String> {
    meter_window(&window)?;
    window.dialog().message(message).title("Damage Meter").kind(MessageDialogKind::Error).parent(&window).show(|_| {});
    Ok(())
}

#[tauri::command]
pub fn dm_pin(window: WebviewWindow, on: bool) -> Result<(), String> {
    meter_window(&window)?;
    window.set_always_on_top(on).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn pack(key: u32, xmls: &[&str]) -> Vec<u8> {
        let mut out = key.to_be_bytes().to_vec();
        out.extend((xmls.len() as u32).to_be_bytes());
        let mut k = key;
        for xml in xmls {
            let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
            z.write_all(xml.as_bytes()).unwrap();
            let plain = z.finish().unwrap();
            out.extend((plain.len() as u32).to_be_bytes());
            for (j, byte) in plain.iter().enumerate() {
                out.push(byte ^ (k & 0xff) as u8);
                let s = (j & 7) as u32;
                if s != 0 {
                    k = k.rotate_right(s);
                }
            }
        }
        out
    }

    #[test]
    fn unpacks_swz_chunks() {
        let packed = pack(0xdeadbeef, &["<PlayerPowerTypes/>", "<Monsters/>"]);
        assert_eq!(unpack_swz(&packed).unwrap(), vec!["<PlayerPowerTypes/>", "<Monsters/>"]);
        assert!(unpack_swz(b"<html>").is_none());
        assert!(unpack_swz(&packed[..packed.len() - 3]).is_none());
    }

    #[test]
    fn origins_match_only_the_same_server() {
        assert_eq!(origin("http://a.example/api/combat/outbound?since=1"), origin("http://a.example/"));
        assert_ne!(origin("https://a.example/"), origin("http://a.example/"));
        assert_eq!(origin("file:///etc/passwd"), None);
    }
}
