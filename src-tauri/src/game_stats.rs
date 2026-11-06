use reqwest::Method;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::config::{base_url, now_ms};
use crate::net::request_json;
use crate::Bus;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsState {
    pub running: bool,
    pub state: String,
    pub written: bool,
    pub username: String,
    pub updated_at: u64,
    pub last_error: String,
}

impl Default for StatsState {
    fn default() -> Self {
        Self { running: false, state: "idle".into(), written: false, username: String::new(), updated_at: 0, last_error: String::new() }
    }
}

#[derive(Default)]
struct Inner {
    server: String,
    syncing: bool,
    state: StatsState,
}

#[derive(Clone)]
pub struct GameStats {
    bus: Bus,
    inner: Arc<Mutex<Inner>>,
}

impl GameStats {
    pub fn new(bus: Bus) -> Self {
        Self { bus, inner: Arc::default() }
    }

    pub fn snapshot(&self) -> StatsState {
        self.inner.lock().unwrap().state.clone()
    }

    fn patch(&self, f: impl FnOnce(&mut StatsState)) {
        f(&mut self.inner.lock().unwrap().state);
        (self.bus)();
    }

    pub fn start(&self, server_url: &str) {
        let base = base_url(server_url);
        self.inner.lock().unwrap().server = base.clone();
        self.patch(|s| *s = StatsState { running: !base.is_empty(), ..StatsState::default() });
    }

    pub fn stop(&self) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.server.clear();
            inner.syncing = false;
        }
        self.patch(|s| *s = StatsState::default());
    }

    pub async fn sync(&self, token: String) -> StatsState {
        let server = {
            let mut inner = self.inner.lock().unwrap();
            if inner.syncing {
                return inner.state.clone();
            }
            if !inner.server.is_empty() {
                inner.syncing = true;
            }
            inner.server.clone()
        };
        if server.is_empty() {
            self.patch(|s| {
                s.state = "idle".into();
                s.last_error = "The launcher is not attached to a game session yet.".into();
            });
            return self.snapshot();
        }
        self.patch(|s| {
            s.state = "syncing".into();
            s.last_error.clear();
        });
        let body = if token.is_empty() { json!({}) } else { json!({ "token": token }) };
        let result =
            request_json(Method::POST, &format!("{server}/api/discord/stats/sync"), Some(&body), &[], Duration::from_secs(10)).await;
        self.inner.lock().unwrap().syncing = false;
        let unlinked = |s: &mut StatsState| {
            s.state = "unlinked".into();
            s.written = false;
            s.last_error = "Sign in with Discord in the game so the widget has an account to write.".into();
        };
        if !result.ok() {
            let status = result.status;
            let describe = result.describe();
            self.patch(|s| match status {
                401 | 403 => {
                    s.state = "error".into();
                    s.written = false;
                    s.last_error = "The server does not recognise this launcher yet. Sign in with Discord in the game, then press Sync game stats.".into();
                }
                409 => unlinked(s),
                404 => {
                    s.state = "unsupported".into();
                    s.written = false;
                    s.last_error = "This server cannot write Discord widget stats yet.".into();
                }
                _ => {
                    s.state = "error".into();
                    s.written = false;
                    s.last_error = format!("The widget profile could not be written ({describe}).");
                }
            });
            return self.snapshot();
        }
        if !result.flag("ok") {
            let reason = result.str("reason").trim().to_string();
            let message = result.str("message").trim().to_string();
            self.patch(|s| {
                if reason == "discord-not-linked" {
                    unlinked(s);
                } else {
                    s.state = "error".into();
                    s.written = false;
                    s.last_error = if message.is_empty() {
                        format!("The server would not write the widget profile ({}).", if reason.is_empty() { "no reason given" } else { &reason })
                    } else {
                        message
                    };
                }
            });
            return self.snapshot();
        }
        let username = result.str("username").trim().to_string();
        let updated = result.field("updatedAt").and_then(Value::as_f64).map(|v| v as u64).filter(|v| *v > 0).unwrap_or_else(now_ms);
        self.patch(|s| {
            s.state = "written".into();
            s.written = true;
            s.username = username;
            s.updated_at = updated;
            s.last_error.clear();
        });
        self.snapshot()
    }
}
