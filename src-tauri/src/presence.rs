use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::sync::{mpsc, Mutex};

use crate::config::{base_url, env_is, hostname_of, normalize_http_url, now_ms, read_json, Paths};
use crate::discord_ipc::{DiscordIpc, READY_TIMEOUT};
use crate::Bus;

const DEFAULT_PORT: u16 = 47631;
const PARTY_MAX_MEMBERS: f64 = 4.0;
const DEFAULT_PLAY_GAME_URL: &str = "https://theminesa.studio/dungeon-blitz-r";
const MAX_BODY_BYTES: usize = 64 * 1024;

const IMAGE_KEYS: &[&str] = &[
    "blackrosemire", "castlehocke", "cemeteryhill", "dungeon_blitz", "embedded_background", "embedded_cover",
    "emeraldglades", "fellbridge", "flameseer", "frostbringer", "home", "indungeon", "justicar", "mage",
    "necromancer", "newbieroad", "paladin", "rogue", "sentinel", "shadowbringer", "shazaridesert", "soulthieft",
    "stormshardmountain", "templar", "valhaven", "viperblade",
];

fn defaults() -> Value {
    json!({
        "appId": "", "port": DEFAULT_PORT, "presenceUrl": "", "joinUrl": "", "playGameUrl": DEFAULT_PLAY_GAME_URL,
        "characterName": "", "pollMs": 4000, "largeImageText": "Dungeon Blitz: R", "smallImageKey": "dungeon_blitz",
        "smallImageText": "Dungeon Blitz: R", "largeImageHomeKey": "home", "largeImageDungeonKey": "indungeon",
        "largeImageNewbieRoadKey": "newbieroad", "logPayloads": false,
        "allowedPresenceOrigins": ["theminesa.studio", "*.theminesa.studio"]
    })
}

fn read_config(paths: &Paths) -> Map<String, Value> {
    let mut merged = defaults().as_object().cloned().unwrap();
    if let Some(Value::Object(own)) = read_json(&paths.resource_root.join("presence.config.json")) {
        merged.extend(own);
    }
    if let Some(Value::Object(server)) = read_json(&paths.server_root.join("discord-bridge.config.json")) {
        for key in defaults().as_object().unwrap().keys() {
            match server.get(key) {
                None | Some(Value::Null) => {}
                Some(Value::String(s)) if s.is_empty() => {}
                Some(v) => {
                    merged.insert(key.clone(), v.clone());
                }
            }
        }
    }
    let mut origins: Vec<String> = merged
        .get("allowedPresenceOrigins")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    for d in ["theminesa.studio", "*.theminesa.studio"] {
        if !origins.iter().any(|o| o == d) {
            origins.push(d.into());
        }
    }
    merged.insert("allowedPresenceOrigins".into(), json!(origins));
    merged
}

fn cfg_str(config: &Map<String, Value>, key: &str) -> String {
    config.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string()
}

pub fn host_allowed(host: &str, allowed: &[String]) -> bool {
    if host.is_empty() {
        return false;
    }
    if matches!(host, "localhost" | "127.0.0.1" | "::1") {
        return true;
    }
    if allowed.iter().any(|a| a == "*" || a == host) {
        return true;
    }
    allowed.iter().any(|entry| {
        entry.len() > 2 && entry.starts_with("*.") && {
            let suffix = &entry[2..];
            host.ends_with(&format!(".{suffix}")) && host.len() > suffix.len() + 1
        }
    })
}

#[derive(Clone, Debug, Default)]
pub struct PresenceState {
    pub running: bool,
    pub ready: bool,
    pub port: u16,
    pub character_name: String,
    pub activity: String,
    pub last_error: String,
}

struct Session {
    config: Map<String, Value>,
    server_url: String,
    allowed: Vec<String>,
    client: Option<Arc<DiscordIpc>>,
    last_hash: String,
    http: Option<Arc<tiny_http::Server>>,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}

#[derive(Clone)]
pub struct Presence {
    paths: Paths,
    bus: Bus,
    state: Arc<StdMutex<PresenceState>>,
    session: Arc<Mutex<Option<Session>>>,
}

impl Presence {
    pub fn new(paths: Paths, bus: Bus) -> Self {
        Self { paths, bus, state: Arc::default(), session: Arc::default() }
    }

    pub fn snapshot(&self) -> PresenceState {
        self.state.lock().unwrap().clone()
    }

    fn patch(&self, f: impl FnOnce(&mut PresenceState)) {
        f(&mut self.state.lock().unwrap());
        (self.bus)();
    }

    fn log(&self, config: &Map<String, Value>, message: &str) {
        if config.get("logPayloads") == Some(&Value::Bool(true)) || env_is("DUNGEON_BLITZ_LOG_PRESENCE", "1") {
            println!("[Presence] {message}");
        }
    }

    pub async fn start(&self, server_url: &str) {
        let mut guard = self.session.lock().await;
        if guard.is_some() {
            return;
        }
        let config = read_config(&self.paths);
        if cfg_str(&config, "appId").is_empty() {
            self.patch(|s| {
                s.running = false;
                s.last_error = "No Discord application id configured.".into();
            });
            return;
        }
        let mut allowed: Vec<String> = config
            .get("allowedPresenceOrigins")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default();
        let host = hostname_of(server_url);
        if !host.is_empty() && !allowed.contains(&host) {
            allowed.push(host);
        }
        let port = config.get("port").and_then(Value::as_u64).map(|p| p as u16).unwrap_or(DEFAULT_PORT);
        let http = match tiny_http::Server::http(("127.0.0.1", port)) {
            Ok(server) => {
                let server = Arc::new(server);
                let me = self.clone();
                let handle = server.clone();
                std::thread::spawn(move || {
                    for request in handle.incoming_requests() {
                        let me = me.clone();
                        tauri::async_runtime::block_on(me.handle_request(request));
                    }
                });
                self.patch(|s| {
                    s.running = true;
                    s.port = port;
                    s.last_error.clear();
                });
                Some(server)
            }
            Err(error) => {
                self.patch(|s| {
                    s.running = false;
                    s.port = 0;
                    s.last_error = format!("Presence endpoint could not listen on 127.0.0.1:{port} ({error}).");
                });
                None
            }
        };
        let me = self.clone();
        let task = tauri::async_runtime::spawn(async move { me.connect_loop().await });
        *guard = Some(Session {
            config,
            server_url: base_url(server_url),
            allowed,
            client: None,
            last_hash: String::new(),
            http,
            task: Some(task),
        });
    }

    async fn connect_loop(&self) {
        let mut attempt: u32 = 0;
        loop {
            let app_id = match self.session.lock().await.as_ref() {
                Some(s) => cfg_str(&s.config, "appId"),
                None => return,
            };
            let (tx, mut rx) = mpsc::unbounded_channel();
            match DiscordIpc::connect(&app_id, tx).await {
                Ok(client) => {
                    let client = Arc::new(client);
                    attempt = 0;
                    {
                        let mut guard = self.session.lock().await;
                        let Some(session) = guard.as_mut() else { return };
                        session.client = Some(client.clone());
                        session.last_hash.clear();
                        self.log(&session.config, "Connected to the Discord client.");
                    }
                    self.patch(|s| {
                        s.ready = true;
                        s.last_error.clear();
                    });
                    let _ = client.request("SUBSCRIBE", json!({}), READY_TIMEOUT).await;
                    let _ = client
                        .request("SUBSCRIBE", json!({ "evt": "ACTIVITY_JOIN" }), READY_TIMEOUT)
                        .await;
                    while let Some((evt, data)) = rx.recv().await {
                        match evt.as_str() {
                            "ACTIVITY_JOIN" => self.handle_join(&data).await,
                            "RPC_ERROR" => {
                                if let Some(s) = self.session.lock().await.as_mut() {
                                    s.last_hash.clear();
                                }
                            }
                            "CLOSED" => break,
                            _ => {}
                        }
                    }
                    if let Some(s) = self.session.lock().await.as_mut() {
                        s.client = None;
                    }
                    self.patch(|s| {
                        s.ready = false;
                        s.last_error = "Discord closed the connection.".into();
                    });
                }
                Err(error) => {
                    self.patch(|s| {
                        s.ready = false;
                        s.last_error = error;
                    });
                }
            }
            let delay = (1000u64 << attempt.min(6)).min(60_000);
            attempt = (attempt + 1).min(30);
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
    }

    pub async fn stop(&self) {
        let Some(mut session) = self.session.lock().await.take() else { return };
        if let Some(task) = session.task.take() {
            task.abort();
        }
        if let Some(client) = session.client.take() {
            if !session.last_hash.is_empty() {
                let _ = client
                    .request("SET_ACTIVITY", json!({ "pid": std::process::id(), "activity": null }), Duration::from_secs(2))
                    .await;
            }
            client.close();
        }
        if let Some(http) = session.http.take() {
            http.unblock();
        }
        self.patch(|s| {
            s.running = false;
            s.ready = false;
            s.activity.clear();
            s.character_name.clear();
        });
    }

    async fn handle_request(&self, mut request: tiny_http::Request) {
        let origin = request
            .headers()
            .iter()
            .find(|h| h.field.equiv("Origin"))
            .map(|h| h.value.as_str().trim().to_string())
            .unwrap_or_default();
        let allowed = self.session.lock().await.as_ref().map(|s| s.allowed.clone()).unwrap_or_default();
        let mut headers = vec![
            ("Access-Control-Allow-Headers", "Content-Type".to_string()),
            ("Access-Control-Allow-Methods", "GET,POST,OPTIONS".to_string()),
            ("Content-Type", "application/json".to_string()),
        ];
        if !origin.is_empty() {
            if !host_allowed(&hostname_of(&origin), &allowed) {
                respond(request, 403, json!({ "ok": false, "reason": "origin-not-allowed" }), &headers);
                return;
            }
            headers.push(("Access-Control-Allow-Origin", origin.clone()));
            headers.push(("Vary", "Origin".into()));
        }
        let method = request.method().as_str().to_uppercase();
        if method == "OPTIONS" {
            let _ = request.respond(with_headers(tiny_http::Response::empty(204), &headers));
            return;
        }
        let route = request.url().split('?').next().unwrap_or("").to_string();
        if route == "/healthz" {
            let ready = self.snapshot().ready;
            respond(request, 200, json!({ "ok": true, "ready": ready }), &headers);
            return;
        }
        if method != "POST" {
            respond(request, 405, json!({ "ok": false, "reason": "method-not-allowed" }), &headers);
            return;
        }
        let mut raw = Vec::new();
        let read = request.as_reader().take(MAX_BODY_BYTES as u64 + 1).read_to_end(&mut raw);
        if read.is_err() || raw.len() > MAX_BODY_BYTES {
            respond(request, 400, json!({ "ok": false, "reason": "bad-request" }), &headers);
            return;
        }
        let text = String::from_utf8_lossy(&raw).trim().to_string();
        let body: Value = if text.is_empty() {
            json!({})
        } else {
            match serde_json::from_str::<Value>(&text) {
                Ok(v) if v.is_object() => v,
                Ok(_) => json!({}),
                Err(_) => {
                    respond(request, 400, json!({ "ok": false, "reason": "bad-request" }), &headers);
                    return;
                }
            }
        };
        match route.as_str() {
            "/configure" => {
                let name = body.get("characterName").and_then(Value::as_str).unwrap_or("").trim().to_string();
                if !name.is_empty() {
                    self.patch(|s| s.character_name = name);
                }
                let (presence_url, join_url) = self.urls().await;
                respond(request, 200, json!({ "ok": true, "presenceUrl": presence_url, "joinUrl": join_url }), &headers);
            }
            "/clear" => {
                self.clear().await;
                respond(request, 200, json!({ "ok": true, "cleared": true }), &headers);
            }
            "/presence" => {
                let (updated, cleared) = self.publish(&body).await;
                let status = if cleared { 202 } else if updated { 200 } else { 202 };
                let mut out = json!({ "ok": true, "updated": updated });
                if cleared {
                    out["cleared"] = json!(true);
                }
                respond(request, status, out, &headers);
            }
            _ => respond(request, 404, json!({ "ok": false, "reason": "not-found" }), &headers),
        }
    }

    async fn urls(&self) -> (String, String) {
        let guard = self.session.lock().await;
        let Some(session) = guard.as_ref() else { return (String::new(), String::new()) };
        let mut base = if session.server_url.is_empty() {
            String::new()
        } else {
            format!("{}/api/presence/discord-target", session.server_url)
        };
        if base.is_empty() {
            base = normalize_http_url(&cfg_str(&session.config, "presenceUrl"));
        }
        let character = {
            let state = self.state.lock().unwrap().character_name.clone();
            if state.is_empty() { cfg_str(&session.config, "characterName") } else { state }
        };
        if !base.is_empty() && !character.is_empty() {
            let sep = if base.contains('?') { '&' } else { '?' };
            base = format!("{base}{sep}character={}", url::form_urlencoded::byte_serialize(character.as_bytes()).collect::<String>());
        }
        let join = if session.server_url.is_empty() {
            normalize_http_url(&cfg_str(&session.config, "joinUrl"))
        } else {
            format!("{}/api/presence/discord-join", session.server_url)
        };
        (base, join)
    }

    pub async fn publish(&self, body: &Value) -> (bool, bool) {
        match normalize_payload(body) {
            None => {
                self.apply(None).await;
                (false, true)
            }
            Some(payload) => (self.apply(Some(payload)).await, false),
        }
    }

    pub async fn clear(&self) {
        self.apply(None).await;
    }

    async fn apply(&self, payload: Option<Value>) -> bool {
        let (client, config, last_hash) = {
            let guard = self.session.lock().await;
            let Some(session) = guard.as_ref() else { return false };
            (session.client.clone(), session.config.clone(), session.last_hash.clone())
        };
        let Some(client) = client else { return false };
        if !self.snapshot().ready {
            return false;
        }
        let pid = std::process::id();
        let Some(payload) = payload else {
            if last_hash.is_empty() {
                return false;
            }
            if let Err(error) = client.request("SET_ACTIVITY", json!({ "pid": pid, "activity": null }), READY_TIMEOUT).await {
                self.log(&config, &format!("Failed to clear presence: {error}"));
            }
            if let Some(s) = self.session.lock().await.as_mut() {
                s.last_hash.clear();
            }
            self.patch(|s| {
                s.activity.clear();
                s.character_name.clear();
            });
            return true;
        };
        let activity = build_activity(&payload, &config);
        let hash = activity.to_string();
        if hash == last_hash {
            return false;
        }
        if let Err(error) = client.request("SET_ACTIVITY", json!({ "pid": pid, "activity": activity }), READY_TIMEOUT).await {
            self.patch(|s| s.last_error = format!("Discord refused the presence update: {error}"));
            return false;
        }
        if let Some(s) = self.session.lock().await.as_mut() {
            s.last_hash = hash;
        }
        let text = |k: &str| payload.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let (name, details, state) = (text("characterName"), text("details"), text("state"));
        self.log(&config, &format!("Presence updated: {name} | {details} | {state}"));
        self.patch(|s| {
            s.character_name = name;
            s.activity = [details, state].into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" - ");
            s.last_error.clear();
        });
        true
    }

    async fn handle_join(&self, data: &Value) {
        let secret = ["secret", "joinSecret"]
            .iter()
            .find_map(|k| data.get(*k).and_then(Value::as_str))
            .unwrap_or("")
            .trim()
            .to_string();
        let (_, join_url) = self.urls().await;
        if secret.is_empty() || join_url.is_empty() {
            return;
        }
        let result = crate::net::post_json(&join_url, &json!({ "secret": secret }), Duration::from_secs(10)).await;
        println!(
            "[Presence] {}",
            if result.success() { "Handed a Discord party join to the game server.".to_string() } else { format!("Discord party join failed ({}).", result.describe()) }
        );
    }
}

fn with_headers<R: Read>(mut response: tiny_http::Response<R>, headers: &[(&str, String)]) -> tiny_http::Response<R> {
    for (name, value) in headers {
        if let Ok(h) = tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes()) {
            response.add_header(h);
        }
    }
    response
}

fn respond(request: tiny_http::Request, status: u16, body: Value, headers: &[(&str, String)]) {
    let response = tiny_http::Response::from_string(body.to_string()).with_status_code(status);
    let _ = request.respond(with_headers(response, headers));
}

fn number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Null => Some(0.0),
        _ => None,
    }
}

fn trimmed(body: &Value, key: &str) -> String {
    match body.get(key) {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

pub fn normalize_payload(body: &Value) -> Option<Value> {
    if body.get("clear") == Some(&Value::Bool(true)) {
        return None;
    }
    let character = trimmed(body, "characterName");
    let started = number(body.get("startedAtMs")).unwrap_or(0.0);
    if character.is_empty() || !started.is_finite() || started <= 0.0 {
        return None;
    }
    let or = |v: Option<f64>, d: f64| v.filter(|x| x.is_finite()).unwrap_or(d);
    let party_size = or(number(body.get("partySize")), 0.0).max(0.0).round();
    let party_id = or(number(body.get("partyId")), 0.0).max(0.0).round();
    let party_max = or(number(body.get("partyMax")).filter(|v| *v > 0.0), PARTY_MAX_MEMBERS).round();
    Some(json!({
        "characterName": character,
        "characterClass": trimmed(body, "characterClass"),
        "details": trimmed(body, "details"),
        "state": trimmed(body, "state"),
        "startedAtMs": started,
        "partySize": party_size,
        "partyId": party_id,
        "partyMax": party_max,
        "joinSecret": trimmed(body, "joinSecret"),
        "levelKey": trimmed(body, "levelKey"),
        "levelName": trimmed(body, "levelName"),
        "areaKey": trimmed(body, "areaKey"),
        "portraitUrl": trimmed(body, "portraitUrl"),
        "disciplineKey": trimmed(body, "disciplineKey"),
        "activityKind": trimmed(body, "activityKind"),
    }))
}

fn image_key(key: &str) -> Option<String> {
    let lower = key.trim().to_lowercase();
    IMAGE_KEYS.contains(&lower.as_str()).then_some(lower)
}

fn large_image(payload: &Value, config: &Map<String, Value>) -> String {
    let text = |k: &str| payload.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let (level, area, kind) = (text("levelKey"), text("areaKey"), text("activityKind").to_lowercase());
    if let Some(k) = image_key(&area).or_else(|| image_key(&level)) {
        return k;
    }
    if level == "CraftTown" || level == "CraftTownTutorial" {
        return cfg_str(config, "largeImageHomeKey");
    }
    if level == "NewbieRoad" || level == "NewbieRoadHard" {
        return cfg_str(config, "largeImageNewbieRoadKey");
    }
    if kind == "dungeon" {
        return cfg_str(config, "largeImageDungeonKey");
    }
    if !area.is_empty() {
        return area;
    }
    normalize_http_url(&text("portraitUrl"))
}

pub fn build_activity(payload: &Value, config: &Map<String, Value>) -> Value {
    let text = |k: &str| payload.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let num = |k: &str| payload.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    let started = if num("startedAtMs") > 0.0 { num("startedAtMs").round() as u64 } else { now_ms() };
    let mut activity = json!({ "instance": false, "timestamps": { "start": started } });
    if !text("details").is_empty() {
        activity["details"] = json!(text("details"));
    }
    if !text("state").is_empty() {
        activity["state"] = json!(text("state"));
    }
    if num("partyId") > 0.0 {
        activity["party"] = json!({
            "id": (num("partyId") as u64).to_string(),
            "size": [num("partySize").round().max(1.0) as u64, num("partyMax").round().max(1.0) as u64]
        });
    }
    let mut assets = Map::new();
    if !text("disciplineKey").is_empty() {
        assets.insert("small_image".into(), json!(text("disciplineKey")));
        if !text("characterClass").is_empty() {
            assets.insert("small_text".into(), json!(text("characterClass")));
        }
    } else if !cfg_str(config, "smallImageKey").is_empty() {
        assets.insert("small_image".into(), json!(cfg_str(config, "smallImageKey")));
        if !cfg_str(config, "smallImageText").is_empty() {
            assets.insert("small_text".into(), json!(cfg_str(config, "smallImageText")));
        }
    }
    let large = large_image(payload, config);
    if !large.is_empty() {
        assets.insert("large_image".into(), json!(large));
        let level_name = text("levelName");
        assets.insert(
            "large_text".into(),
            json!(if level_name.is_empty() { cfg_str(config, "largeImageText") } else { level_name }),
        );
    }
    if !assets.is_empty() {
        activity["assets"] = Value::Object(assets);
    }
    let play = normalize_http_url(&cfg_str(config, "playGameUrl"));
    let play = if play.is_empty() { DEFAULT_PLAY_GAME_URL.to_string() } else { play };
    activity["buttons"] = json!([{ "label": "Play Game", "url": play }]);
    activity
}

#[allow(dead_code)]
pub fn image_keys() -> HashMap<&'static str, &'static str> {
    IMAGE_KEYS.iter().map(|k| (*k, *k)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins() {
        let allowed = vec!["theminesa.studio".to_string(), "*.theminesa.studio".to_string()];
        assert!(host_allowed("dungeonblitzr.theminesa.studio", &allowed));
        assert!(host_allowed("127.0.0.1", &allowed));
        assert!(!host_allowed("evil.example", &allowed));
        assert!(!host_allowed("xtheminesa.studio", &allowed));
    }

    #[test]
    fn activity_mapping() {
        let config = defaults().as_object().cloned().unwrap();
        let payload = normalize_payload(&json!({
            "characterName": "Neo", "details": "Valhaven", "state": "Solo", "startedAtMs": 1000,
            "levelKey": "CraftTown", "partyId": 7, "partySize": 2, "disciplineKey": "paladin", "characterClass": "Paladin"
        }))
        .unwrap();
        let activity = build_activity(&payload, &config);
        assert_eq!(activity["assets"]["large_image"], "home");
        assert_eq!(activity["assets"]["small_image"], "paladin");
        assert_eq!(activity["party"]["size"], json!([2, 4]));
        assert_eq!(activity["buttons"][0]["label"], "Play Game");
        assert!(normalize_payload(&json!({ "characterName": "Neo" })).is_none());
    }
}
