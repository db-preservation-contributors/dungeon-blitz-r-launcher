use reqwest::Method;
use serde_json::{json, Map, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tauri::async_runtime::JoinHandle;

use crate::net::request_json;
use crate::presence::Presence;

const BLANK_LINE: &str = "\u{2800}\u{2800}";
const TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Default)]
struct HostState {
    tasks: Vec<JoinHandle<()>>,
    last_hash: String,
    last_character: String,
}

#[derive(Clone)]
pub struct GameHost {
    presence: Presence,
    state: Arc<Mutex<HostState>>,
}

impl GameHost {
    pub fn new(presence: Presence) -> Self {
        Self { presence, state: Arc::default() }
    }

    pub async fn start(&self, server_url: &str, with_presence: bool) {
        self.stop().await;
        let base = server_url.trim_end_matches('/').to_string();
        if base.is_empty() {
            return;
        }
        let mut state = self.state.lock().await;
        if with_presence {
            let me = self.clone();
            let url = base.clone();
            state.tasks.push(tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(2500)).await;
                loop {
                    me.sync_presence(&url).await;
                    tokio::time::sleep(Duration::from_secs(4)).await;
                }
            }));
        }
        let url = base.clone();
        state.tasks.push(tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(10)).await;
            loop {
                measure_regions(&url).await;
                tokio::time::sleep(Duration::from_secs(600)).await;
            }
        }));
    }

    pub async fn stop(&self) {
        let had = {
            let mut state = self.state.lock().await;
            for task in state.tasks.drain(..) {
                task.abort();
            }
            state.last_character.clear();
            !std::mem::take(&mut state.last_hash).is_empty()
        };
        if had {
            self.presence.clear().await;
        }
    }

    async fn sync_presence(&self, base: &str) {
        let character = self.state.lock().await.last_character.clone();
        let query = if character.is_empty() {
            String::new()
        } else {
            format!("?character={}", url::form_urlencoded::byte_serialize(character.as_bytes()).collect::<String>())
        };
        let response = request_json(Method::GET, &format!("{base}/api/presence/self{query}"), None, &[], TIMEOUT).await;
        if response.status == 409 {
            let offered: Vec<String> = response
                .field("availableCharacters")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
                .unwrap_or_default();
            let mut state = self.state.lock().await;
            if !state.last_character.is_empty() && !offered.contains(&state.last_character) {
                state.last_character.clear();
            }
            return;
        }
        let session = if response.ok() { response.field("session").filter(|s| s.is_object()).cloned() } else { None };
        let Some(session) = session else {
            if response.status != 0 {
                let had = !std::mem::take(&mut self.state.lock().await.last_hash).is_empty();
                if had {
                    self.state.lock().await.last_character.clear();
                    self.presence.clear().await;
                }
            }
            return;
        };
        let payload = presence_payload(&session, base);
        let hash = payload.to_string();
        {
            let mut state = self.state.lock().await;
            state.last_character = session.get("characterName").and_then(Value::as_str).unwrap_or("").to_string();
            if hash == state.last_hash {
                return;
            }
            state.last_hash = hash;
        }
        self.presence.publish(&payload).await;
    }
}

pub fn presence_payload(session: &Value, base: &str) -> Value {
    let get = |k: &str| session.get(k).cloned().unwrap_or(Value::Null);
    let line = |k: &str| match session.get(k).and_then(Value::as_str) {
        Some(s) if !s.is_empty() => json!(s),
        _ => json!(BLANK_LINE),
    };
    let class = match session.get("disciplineName").and_then(Value::as_str) {
        Some(s) if !s.is_empty() => json!(s),
        _ => get("characterClass"),
    };
    let mut out = Map::new();
    for key in [
        "characterName", "startedAtMs", "partySize", "partyId", "partyMax", "partyLocked", "joinSecret", "levelKey",
        "levelName", "areaKey", "portraitUrl", "disciplineKey", "activityKind", "playerStatus",
    ] {
        out.insert(key.into(), get(key));
    }
    out.insert("characterClass".into(), class);
    out.insert("details".into(), line("details"));
    out.insert("state".into(), line("state"));
    out.insert("presenceUrl".into(), json!(format!("{base}/api/presence/self")));
    out.insert("joinUrl".into(), json!(format!("{base}/api/presence/discord-join")));
    Value::Object(out)
}

async fn ping(url: &str) -> Option<f64> {
    let started = Instant::now();
    let response = crate::net::client().get(url).header("Cache-Control", "no-store").timeout(TIMEOUT).send().await.ok()?;
    let ok = response.status().is_success();
    let _ = response.bytes().await;
    ok.then(|| started.elapsed().as_secs_f64() * 1000.0)
}

async fn measure_regions(base: &str) {
    let listing = request_json(Method::GET, &format!("{base}/api/regions"), None, &[], TIMEOUT).await;
    let regions = listing.field("regions").and_then(Value::as_array).cloned().unwrap_or_default();
    if !listing.ok() || regions.len() < 2 {
        return;
    }
    let root = url::Url::parse(&format!("{base}/")).ok();
    let mut results = Map::new();
    for region in regions {
        let id = region.get("id").and_then(Value::as_str).unwrap_or("");
        let ping_url = region
            .get("pingUrl")
            .and_then(Value::as_str)
            .and_then(|p| root.as_ref()?.join(p).ok())
            .filter(|u| u.scheme() == "http" || u.scheme() == "https");
        let (false, Some(ping_url)) = (id.is_empty(), ping_url) else { continue };
        let mut times = Vec::new();
        for _ in 0..6 {
            times.push(ping(ping_url.as_str()).await);
        }
        if times.iter().all(Option::is_some) {
            let best = times[1..].iter().flatten().cloned().fold(f64::INFINITY, f64::min);
            if best.is_finite() {
                results.insert(id.into(), json!(best.round() as u64));
            }
        }
    }
    if !results.is_empty() {
        request_json(Method::POST, &format!("{base}/api/region-rtt"), Some(&json!({ "results": results })), &[], TIMEOUT).await;
    }
}
