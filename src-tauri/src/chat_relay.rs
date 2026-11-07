use reqwest::Method;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::config::base_url;
use crate::net::request_json;
use crate::social::Social;
use crate::Bus;

const TIMEOUT: Duration = Duration::from_secs(8);
const MAX_PENDING: usize = 50;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayState {
    pub running: bool,
    pub supported: Option<bool>,
    pub relayed: u64,
    pub received: u64,
    pub last_error: String,
}

#[derive(Default)]
struct Inner {
    server: String,
    cursor: Option<f64>,
    last_seq: f64,
    pending: BTreeMap<u64, (String, String)>,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
    state: RelayState,
}

#[derive(Clone)]
pub struct ChatRelay {
    social: Social,
    bus: Bus,
    inner: Arc<Mutex<Inner>>,
}

impl ChatRelay {
    pub fn new(social: Social, bus: Bus) -> Self {
        let relay = Self { social: social.clone(), bus, inner: Arc::default() };
        let me = relay.clone();
        social.set_chat_sink(Arc::new(move |name, message| {
            let me = me.clone();
            tauri::async_runtime::spawn(async move { me.deliver_inbound(name, message).await });
        }));
        relay
    }

    pub fn snapshot(&self) -> RelayState {
        self.inner.lock().unwrap().state.clone()
    }

    fn patch(&self, f: impl FnOnce(&mut RelayState)) {
        f(&mut self.inner.lock().unwrap().state);
        (self.bus)();
    }

    pub fn start(&self, server_url: &str) {
        let base = base_url(server_url);
        if base.is_empty() {
            self.patch(|s| {
                s.running = false;
                s.supported = Some(false);
                s.last_error = "No server to mirror chat with.".into();
            });
            return;
        }
        {
            let inner = self.inner.lock().unwrap();
            if inner.state.running && inner.server == base {
                return;
            }
        }
        self.stop();
        let me = self.clone();
        {
            let mut inner = self.inner.lock().unwrap();
            inner.server = base;
            inner.cursor = None;
            inner.last_seq = 0.0;
            inner.pending.clear();
            inner.task = Some(tauri::async_runtime::spawn(async move {
                loop {
                    let delay = me.poll().await;
                    tokio::time::sleep(delay).await;
                }
            }));
        }
        self.patch(|s| {
            s.running = true;
            s.supported = None;
            s.last_error.clear();
        });
    }

    pub fn stop(&self) {
        {
            let mut inner = self.inner.lock().unwrap();
            if let Some(task) = inner.task.take() {
                task.abort();
            }
            inner.pending.clear();
            inner.cursor = None;
        }
        self.patch(|s| s.running = false);
    }

    async fn poll(&self) -> Duration {
        let social = self.social.snapshot();
        if social.lobby_ready {
            self.flush().await;
        }
        let (server, cursor) = {
            let inner = self.inner.lock().unwrap();
            (inner.server.clone(), inner.cursor)
        };
        let mut params = Vec::new();
        if let Some(c) = cursor {
            params.push(format!("since={c}"));
        }
        if social.lobby_ready && social.linked_lobby && !social.lobby_id.is_empty() {
            params.push(format!("lobby={}", social.lobby_id));
        }
        let query = if params.is_empty() { String::new() } else { format!("?{}", params.join("&")) };
        let result = request_json(Method::GET, &format!("{server}/api/chat/outbound{query}"), None, &[], TIMEOUT).await;
        if !result.ok() {
            if result.status == 404 && result.str("reason") == "no-game-session" {
                self.patch(|s| {
                    s.supported = None;
                    s.last_error = "Waiting for the game session to come up...".into();
                });
                return Duration::from_secs(15);
            }
            let message = if result.status == 404 {
                "This server does not mirror game chat to Discord yet.".to_string()
            } else {
                format!("Chat feed unreachable ({}).", result.describe())
            };
            self.patch(|s| {
                s.supported = Some(false);
                s.last_error = message;
            });
            return Duration::from_secs(600);
        }
        if self.snapshot().supported != Some(true) {
            self.patch(|s| {
                s.supported = Some(true);
                s.last_error.clear();
            });
        }
        let next = result.field("cursor").and_then(Value::as_f64);
        let messages = result.field("messages").and_then(Value::as_array).cloned().unwrap_or_default();
        {
            let mut inner = self.inner.lock().unwrap();
            for message in messages {
                let seq = message.get("seq").and_then(Value::as_f64);
                let text = message.get("message").and_then(Value::as_str).unwrap_or("").trim().to_string();
                let Some(seq) = seq else { continue };
                if text.is_empty() || seq <= inner.last_seq {
                    continue;
                }
                inner.last_seq = seq;
                let sender = message.get("senderName").and_then(Value::as_str).unwrap_or("").trim().to_string();
                inner.pending.insert(seq as u64, (if sender.is_empty() { "Player".into() } else { sender }, text));
                while inner.pending.len() > MAX_PENDING {
                    let first = *inner.pending.keys().next().unwrap();
                    inner.pending.remove(&first);
                }
            }
            if next.is_some() {
                inner.cursor = next;
            }
        }
        if self.social.snapshot().lobby_ready {
            self.flush().await;
        }
        Duration::from_millis(2500)
    }

    async fn flush(&self) {
        loop {
            let entry = self.inner.lock().unwrap().pending.iter().next().map(|(k, v)| (*k, v.clone()));
            let Some((seq, (sender, message))) = entry else { return };
            match self.social.send_chat(&sender, &message).await {
                Ok(()) => {
                    self.inner.lock().unwrap().pending.remove(&seq);
                    self.patch(|s| {
                        s.relayed += 1;
                        s.last_error.clear();
                    });
                }
                Err(error) => {
                    self.patch(|s| s.last_error = error);
                    return;
                }
            }
        }
    }

    async fn deliver_inbound(&self, sender: String, message: String) {
        let server = {
            let inner = self.inner.lock().unwrap();
            if !inner.state.running {
                return;
            }
            inner.server.clone()
        };
        let message = message.trim().to_string();
        if message.is_empty() || server.is_empty() {
            return;
        }
        let sender = if sender.trim().is_empty() { "Discord".to_string() } else { sender.trim().to_string() };
        let result = request_json(
            Method::POST,
            &format!("{server}/api/chat/inbound"),
            Some(&json!({ "senderName": sender, "message": message })),
            &[],
            TIMEOUT,
        )
        .await;
        if !result.ok() {
            let error = if result.status == 404 {
                "This server does not print Discord chat in game yet.".to_string()
            } else {
                format!("Discord chat could not be shown in game ({}).", result.describe())
            };
            self.patch(|s| s.last_error = error);
            return;
        }
        self.patch(|s| {
            s.received += 1;
            s.last_error.clear();
        });
    }
}
