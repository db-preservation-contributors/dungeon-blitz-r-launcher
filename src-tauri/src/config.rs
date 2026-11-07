use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use url::Url;

use crate::graphics::{normalize_quality, normalize_renderer};

pub const APP_DIRECTORY_NAME: &str = "dungeon-blitz-r-launcher";

#[cfg(target_os = "windows")]
pub const PLATFORM: &str = "win32";
#[cfg(target_os = "macos")]
pub const PLATFORM: &str = "darwin";
#[cfg(target_os = "linux")]
pub const PLATFORM: &str = "linux";

#[cfg(target_arch = "x86_64")]
pub const ARCH: &str = "x64";
#[cfg(target_arch = "x86")]
pub const ARCH: &str = "ia32";
#[cfg(target_arch = "aarch64")]
pub const ARCH: &str = "arm64";

pub fn is_packaged() -> bool {
    !cfg!(debug_assertions)
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn env_is(name: &str, value: &str) -> bool {
    std::env::var(name).map(|v| v == value).unwrap_or(false)
}

pub fn env_off(name: &str) -> bool {
    env_is(name, "0")
}

#[derive(Clone, Debug)]
pub struct Paths {
    pub data_dir: PathBuf,
    pub resource_root: PathBuf,
    pub server_root: PathBuf,
}

impl Paths {
    pub fn new(resource_dir: Option<PathBuf>) -> Self {
        let checkout = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let resource_root = if is_packaged() {
            resource_dir.unwrap_or_else(|| checkout.clone())
        } else {
            checkout.clone()
        };
        let server_root = std::env::var("DUNGEON_BLITZ_SERVER_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|_| checkout.join("..").join("private-dungeon-blitz-r").join("src").join("server"));
        let data_dir = dirs::config_dir()
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".config"))
            .join(APP_DIRECTORY_NAME);
        Self { data_dir, resource_root, server_root }
    }

    pub fn vendor(&self, kind: &str) -> PathBuf {
        self.resource_root.join("vendor").join(kind).join(PLATFORM)
    }
}

pub fn read_json(path: &Path) -> Option<Value> {
    fs::read_to_string(path).ok().and_then(|text| serde_json::from_str(&text).ok())
}

pub fn write_json(path: &Path, value: &Value) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, format!("{}\n", serde_json::to_string_pretty(value).unwrap_or_default()))
}

pub fn normalize_http_url(value: &str) -> String {
    let raw = value.trim();
    if raw.is_empty() {
        return String::new();
    }
    match Url::parse(raw) {
        Ok(parsed) => {
            let allowed = parsed.scheme() == "http" || parsed.scheme() == "https";
            let credentials = !parsed.username().is_empty() || parsed.password().is_some();
            if !allowed || credentials {
                String::new()
            } else {
                parsed.to_string()
            }
        }
        Err(_) => String::new(),
    }
}

pub fn base_url(value: &str) -> String {
    normalize_http_url(value).trim_end_matches('/').to_string()
}

pub fn absolute(game_url: &str, pathname: &str) -> String {
    Url::parse(game_url).and_then(|base| base.join(pathname)).map(|u| u.to_string()).unwrap_or_default()
}

pub fn hostname_of(value: &str) -> String {
    let text = value.trim().to_lowercase();
    if text.is_empty() {
        return String::new();
    }
    let candidate = if text.contains("://") { text } else { format!("http://{text}") };
    Url::parse(&candidate)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.trim_start_matches('[').trim_end_matches(']').to_string()))
        .unwrap_or_default()
}

#[derive(Clone, Debug, Serialize)]
pub struct Server {
    pub id: String,
    pub name: String,
    pub note: String,
    pub url: String,
}

#[derive(Clone, Debug)]
pub struct ServerList {
    pub servers: Vec<Server>,
    pub default_server_id: String,
}

fn str_field(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string()
}

pub fn load_servers(paths: &Paths) -> ServerList {
    let file = read_json(&paths.resource_root.join("servers.json")).unwrap_or(Value::Null);
    let mut servers: Vec<Server> = file
        .get("servers")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .map(|entry| Server {
                    id: str_field(entry, "id"),
                    name: str_field(entry, "name"),
                    note: str_field(entry, "note"),
                    url: normalize_http_url(&str_field(entry, "url")),
                })
                .filter(|s| !s.id.is_empty() && !s.url.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let launcher_config = read_json(&paths.server_root.join("launcher.config.json")).unwrap_or(Value::Null);
    let configured = normalize_http_url(&str_field(&launcher_config, "clientUrl"));
    if !configured.is_empty() && !servers.iter().any(|s| s.url == configured) {
        servers.insert(
            0,
            Server {
                id: "launcher-config".into(),
                name: "launcher.config.json".into(),
                note: "src/server/launcher.config.json icindeki clientUrl".into(),
                url: configured,
            },
        );
    }

    let wanted = str_field(&file, "defaultServerId");
    let default_server_id = if servers.iter().any(|s| s.id == wanted) {
        wanted
    } else {
        servers.first().map(|s| s.id.clone()).unwrap_or_default()
    };
    ServerList { servers, default_server_id }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub server_id: String,
    pub custom_server_url: String,
    pub flash_path: String,
    pub projector_path: String,
    pub dev_mode: bool,
    pub dev_server_root: String,
    pub renderer: String,
    pub graphics_quality: String,
    pub start_discord_bridge: bool,
    pub auto_connect: bool,
    pub start_social_bridge: bool,
    pub chat_name: String,
    pub discord_email: String,
    pub discord_name: String,
    pub discord_linked_at: f64,
    pub window_bounds: Option<Value>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            server_id: String::new(),
            custom_server_url: String::new(),
            flash_path: String::new(),
            projector_path: String::new(),
            dev_mode: false,
            dev_server_root: String::new(),
            renderer: "auto".into(),
            graphics_quality: "auto".into(),
            start_discord_bridge: true,
            auto_connect: true,
            start_social_bridge: true,
            chat_name: String::new(),
            discord_email: String::new(),
            discord_name: String::new(),
            discord_linked_at: 0.0,
            window_bounds: None,
        }
    }
}

impl Settings {
    fn normalized(mut self) -> Self {
        self.renderer = normalize_renderer(&self.renderer);
        self.graphics_quality = normalize_quality(&self.graphics_quality);
        self.custom_server_url = normalize_http_url(&self.custom_server_url);
        for field in [
            &mut self.server_id,
            &mut self.flash_path,
            &mut self.projector_path,
            &mut self.dev_server_root,
            &mut self.chat_name,
            &mut self.discord_email,
            &mut self.discord_name,
        ] {
            *field = field.trim().to_string();
        }
        if !self.discord_linked_at.is_finite() {
            self.discord_linked_at = 0.0;
        }
        if !matches!(self.window_bounds, Some(Value::Object(_))) {
            self.window_bounds = None;
        }
        self
    }
}

pub struct StateStore {
    path: PathBuf,
}

impl StateStore {
    pub fn new(data_dir: &Path) -> Self {
        Self { path: data_dir.join("launcher-state.json") }
    }

    pub fn read(&self) -> Settings {
        let value = read_json(&self.path).unwrap_or(Value::Object(Map::new()));
        let cleaned = lenient(value);
        serde_json::from_value::<Settings>(cleaned).unwrap_or_default().normalized()
    }

    pub fn write(&self, patch: Value) -> Settings {
        let mut current = serde_json::to_value(self.read()).unwrap_or(Value::Object(Map::new()));
        if let (Value::Object(target), Value::Object(changes)) = (&mut current, patch) {
            for (key, value) in changes {
                target.insert(key, value);
            }
        }
        let next = serde_json::from_value::<Settings>(lenient(current)).unwrap_or_default().normalized();
        let _ = write_json(&self.path, &serde_json::to_value(&next).unwrap_or(Value::Null));
        next
    }
}

fn lenient(value: Value) -> Value {
    let defaults = serde_json::to_value(Settings::default()).unwrap();
    let mut out = Map::new();
    if let (Value::Object(defaults), Value::Object(source)) = (&defaults, &value) {
        for (key, default) in defaults {
            let Some(found) = source.get(key) else { continue };
            let keep = match (default, found) {
                (Value::String(_), Value::String(_)) => true,
                (Value::Bool(_), _) => true,
                (Value::Number(_), Value::Number(_)) => true,
                (Value::Null, Value::Object(_)) => true,
                _ => false,
            };
            if keep {
                let value = match (default, found) {
                    (Value::Bool(true), other) => Value::Bool(other != &Value::Bool(false)),
                    (Value::Bool(false), other) => Value::Bool(other == &Value::Bool(true)),
                    _ => found.clone(),
                };
                out.insert(key.clone(), value);
            }
        }
    }
    Value::Object(out)
}

#[derive(Clone, Debug, Default)]
pub struct CachedSession {
    pub token: String,
    pub email: String,
}

pub struct SessionCache {
    path: PathBuf,
}

impl SessionCache {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn read(&self) -> CachedSession {
        let Some(value) = read_json(&self.path) else { return CachedSession::default() };
        let token = str_field(&value, "token");
        let valid = (32..=128).contains(&token.len())
            && token.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        if !valid {
            return CachedSession::default();
        }
        CachedSession { token, email: str_field(&value, "email") }
    }

    pub fn write(&self, token: &str, email: &str) {
        let token = token.trim();
        if token.is_empty() {
            self.clear();
            return;
        }
        let value = serde_json::json!({ "token": token, "email": email.trim(), "savedAt": now_ms() });
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let temp = self.path.with_extension(format!("{}.tmp", std::process::id()));
        if write_private(&temp, &format!("{}\n", serde_json::to_string_pretty(&value).unwrap_or_default())).is_ok() {
            let _ = fs::rename(&temp, &self.path);
        }
    }

    pub fn clear(&self) {
        let _ = fs::remove_file(&self.path);
    }
}

pub fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?;
        file.write_all(text.as_bytes())
    }
    #[cfg(not(unix))]
    {
        fs::write(path, text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_credentials_and_other_schemes() {
        assert_eq!(normalize_http_url("http://dungeonblitzr.theminesa.studio"), "http://dungeonblitzr.theminesa.studio/");
        assert_eq!(normalize_http_url("http://user:pass@example.com/"), "");
        assert_eq!(normalize_http_url("file:///etc/passwd"), "");
        assert_eq!(normalize_http_url("  "), "");
    }

    #[test]
    fn settings_tolerate_bad_types() {
        let parsed: Settings = serde_json::from_value(lenient(serde_json::json!({
            "renderer": 5, "devMode": "yes", "startDiscordBridge": false, "serverId": "official"
        })))
        .unwrap();
        let parsed = parsed.normalized();
        assert_eq!(parsed.renderer, "auto");
        assert!(!parsed.dev_mode);
        assert!(!parsed.start_discord_bridge);
        assert!(parsed.start_social_bridge);
        assert_eq!(parsed.server_id, "official");
    }

    #[test]
    fn servers_json_keeps_its_format() {
        let paths = Paths {
            data_dir: PathBuf::new(),
            resource_root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."),
            server_root: PathBuf::from("/nonexistent"),
        };
        let list = load_servers(&paths);
        assert_eq!(list.default_server_id, "official");
        let official = list.servers.iter().find(|s| s.id == "official").unwrap();
        assert_eq!(official.url, "http://dungeonblitzr.theminesa.studio/");
    }
}
