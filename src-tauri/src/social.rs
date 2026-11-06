use base64::Engine;
use reqwest::Method;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::sync::{mpsc, Mutex};

use crate::auth::random_base64url;
use crate::config::{now_ms, read_json, write_private, Paths};
use crate::discord_ipc::DiscordIpc;
use crate::net::{client, request_json};
use crate::Bus;

const API: &str = "https://discord.com/api/v10";
const TOKEN_URL: &str = "https://discord.com/api/oauth2/token";
const LINKED_ATTEMPTS: usize = 20;
const TOKEN_SLACK_MS: u64 = 60_000;

pub type TokenFn = Arc<dyn Fn() -> String + Send + Sync>;
pub type ChatSink = Arc<dyn Fn(String, String) + Send + Sync>;

#[derive(Clone, Debug, Default)]
pub struct SocialState {
    pub running: bool,
    pub lobby_ready: bool,
    pub lobby_id: String,
    pub linked_lobby: bool,
    pub username: String,
    pub auth_pending: bool,
    pub last_status: String,
}

#[derive(Debug)]
struct RestError {
    status: u16,
    message: String,
}

struct Config {
    app_id: String,
    channel_id: String,
    lobby_secret: String,
    channel_linking: bool,
    client_secret: String,
    scopes: Vec<String>,
    poll_ms: u64,
    discord_ipc: bool,
}

#[derive(Default)]
struct Session {
    token: String,
    user_id: String,
    lobby_id: String,
    awaiting_self: String,
    last_message_id: String,
}

#[derive(Clone)]
pub struct Social {
    paths: Paths,
    bus: Bus,
    state: Arc<StdMutex<SocialState>>,
    session: Arc<Mutex<Session>>,
    task: Arc<StdMutex<Option<tokio::task::JoinHandle<()>>>>,
    sink: Arc<StdMutex<Option<ChatSink>>>,
}

impl Social {
    pub fn new(paths: Paths, bus: Bus) -> Self {
        Self {
            paths,
            bus,
            state: Arc::default(),
            session: Arc::default(),
            task: Arc::default(),
            sink: Arc::default(),
        }
    }

    pub fn set_chat_sink(&self, sink: ChatSink) {
        *self.sink.lock().unwrap() = Some(sink);
    }

    pub fn snapshot(&self) -> SocialState {
        self.state.lock().unwrap().clone()
    }

    fn patch(&self, f: impl FnOnce(&mut SocialState)) {
        f(&mut self.state.lock().unwrap());
        (self.bus)();
    }

    fn status(&self, text: impl Into<String>) {
        let text: String = text.into();
        println!("[Social] {text}");
        self.patch(|s| s.last_status = text.chars().take(300).collect());
    }

    fn token_path(&self) -> PathBuf {
        self.paths.data_dir.join("discord-social-token.json")
    }

    fn read_config(&self) -> Config {
        let base = read_json(&self.paths.resource_root.join("social.config.json")).unwrap_or(Value::Null);
        let server = read_json(&self.paths.server_root.join("discord-social-bridge.config.json"));
        let pick = |key: &str| -> String {
            let own = base.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string();
            server
                .as_ref()
                .and_then(|s| s.get(key).and_then(Value::as_str))
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or(own)
        };
        let channel_linking = match &server {
            Some(s) => s.get("enableChannelLinking") == Some(&Value::Bool(true)),
            None => base.get("enableChannelLinking") == Some(&Value::Bool(true)),
        };
        let scopes: Vec<String> = base
            .get("scopes")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .filter(|v: &Vec<String>| !v.is_empty())
            .unwrap_or_else(|| vec!["openid".into(), "identify".into(), "sdk.social_layer".into()]);
        let app_id = pick("appId");
        let secret = pick("lobbySecret");
        Config {
            lobby_secret: if secret.is_empty() { format!("launcher-{app_id}") } else { secret },
            app_id,
            channel_id: pick("channelId"),
            channel_linking,
            client_secret: base.get("clientSecret").and_then(Value::as_str).unwrap_or("").trim().to_string(),
            scopes,
            poll_ms: base.get("pollIntervalMs").and_then(Value::as_u64).filter(|v| *v > 0).unwrap_or(2000),
            discord_ipc: base.get("discordIpc") != Some(&Value::Bool(false)),
        }
    }

    pub fn available(&self) -> bool {
        !self.read_config().app_id.is_empty()
    }

    pub fn start(&self, server_url: String, token_fn: TokenFn) {
        let mut task = self.task.lock().unwrap();
        if task.as_ref().map(|t| !t.is_finished()).unwrap_or(false) {
            return;
        }
        let me = self.clone();
        self.patch(|s| {
            s.running = true;
            s.last_status = "JavaScript social bridge starting...".into();
        });
        *task = Some(tokio::spawn(async move {
            me.run(server_url, token_fn).await;
        }));
    }

    pub fn stop(&self) {
        if let Some(task) = self.task.lock().unwrap().take() {
            task.abort();
        }
        self.patch(|s| {
            s.running = false;
            s.lobby_ready = false;
            s.linked_lobby = false;
            s.auth_pending = false;
        });
    }

    async fn run(&self, server_url: String, token_fn: TokenFn) {
        let config = self.read_config();
        if config.app_id.is_empty() {
            self.status("social.config.json has no appId.");
            return;
        }
        let mut token = self.ensure_authorized(&config).await;
        for _ in 0..2 {
            if token.is_empty() {
                return;
            }
            match self.enter_lobby(&config, &token, &server_url, &token_fn).await {
                Ok(()) => {
                    if !self.poll_loop(&config).await {
                        return;
                    }
                }
                Err(401) => {}
                Err(_) => return,
            }
            self.status("Discord session expired. Re-authorizing...");
            token = match self.refresh(&config).await {
                Some(t) => t,
                None => self.authorize_in_discord(&config).await,
            };
        }
    }

    fn read_cache(&self) -> Option<Value> {
        read_json(&self.token_path())
    }

    fn write_cache(&self, tokens: &Value, previous_refresh: &str) -> String {
        let access = tokens.get("access_token").and_then(Value::as_str).unwrap_or("").to_string();
        let refresh = tokens.get("refresh_token").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(previous_refresh);
        let expires = now_ms() + tokens.get("expires_in").and_then(Value::as_u64).unwrap_or(0) * 1000;
        let cache = json!({
            "access_token": access, "refresh_token": refresh, "expires_at": expires,
            "scope": tokens.get("scope").and_then(Value::as_str).unwrap_or("")
        });
        if let Some(parent) = self.token_path().parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = write_private(&self.token_path(), &format!("{}\n", serde_json::to_string_pretty(&cache).unwrap_or_default()));
        access
    }

    async fn ensure_authorized(&self, config: &Config) -> String {
        if let Some(cache) = self.read_cache() {
            let access = cache.get("access_token").and_then(Value::as_str).unwrap_or("");
            let expires = cache.get("expires_at").and_then(Value::as_f64).unwrap_or(0.0) as u64;
            if !access.is_empty() && expires.saturating_sub(TOKEN_SLACK_MS) > now_ms() {
                self.session.lock().await.token = access.to_string();
                return access.to_string();
            }
            if let Some(t) = self.refresh(config).await {
                return t;
            }
        }
        self.authorize_in_discord(config).await
    }

    async fn refresh(&self, config: &Config) -> Option<String> {
        let cache = self.read_cache()?;
        let refresh = cache.get("refresh_token").and_then(Value::as_str).filter(|s| !s.is_empty())?.to_string();
        let mut form = vec![
            ("grant_type", "refresh_token".to_string()),
            ("refresh_token", refresh.clone()),
            ("client_id", config.app_id.clone()),
        ];
        if !config.client_secret.is_empty() {
            form.push(("client_secret", config.client_secret.clone()));
        }
        let tokens = form_post(&form).await.ok()?;
        let access = self.write_cache(&tokens, &refresh);
        self.session.lock().await.token = access.clone();
        (!access.is_empty()).then_some(access)
    }

    async fn authorize_in_discord(&self, config: &Config) -> String {
        if !config.discord_ipc {
            self.status("Discord authorization did not complete. Open the Discord app and start the game again.");
            return String::new();
        }
        self.status("Asking Discord to authorize the launcher...");
        self.patch(|s| s.auth_pending = true);
        let (tx, _rx) = mpsc::unbounded_channel();
        let client = match DiscordIpc::connect(&config.app_id, tx).await {
            Ok(c) => c,
            Err(error) => {
                self.patch(|s| s.auth_pending = false);
                let lower = error.to_lowercase();
                self.status(if lower.contains("not running") {
                    "The Discord desktop client is not running. Start Discord, then start the game again.".to_string()
                } else {
                    format!("Discord is not reachable: {error}")
                });
                return String::new();
            }
        };
        let verifier = random_base64url(32);
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let state = random_base64url(16);
        let result = async {
            let code = client.authorize(&config.app_id, &config.scopes, &challenge, &state).await?;
            let mut form = vec![
                ("grant_type", "authorization_code".to_string()),
                ("code", code),
                ("client_id", config.app_id.clone()),
                ("code_verifier", verifier.clone()),
            ];
            if !config.client_secret.is_empty() {
                form.push(("client_secret", config.client_secret.clone()));
            }
            form_post(&form).await.map_err(|e| e.message)
        }
        .await;
        client.close();
        self.patch(|s| s.auth_pending = false);
        match result {
            Ok(tokens) => {
                let access = self.write_cache(&tokens, "");
                self.session.lock().await.token = access.clone();
                self.status("Discord authorization complete.");
                access
            }
            Err(error) => {
                self.status(format!("Discord authorization failed: {error}"));
                String::new()
            }
        }
    }

    async fn enter_lobby(&self, config: &Config, token: &str, server_url: &str, token_fn: &TokenFn) -> Result<(), u16> {
        let me = match api(Method::GET, "/users/@me", token, None).await {
            Ok(v) => v,
            Err(e) => {
                self.status(format!("Discord did not accept the session: {}", e.message));
                return Err(if e.status == 401 || e.status == 403 { 401 } else { 0 });
            }
        };
        let user_id = me.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let name = ["global_name", "username"]
            .iter()
            .find_map(|k| me.get(*k).and_then(Value::as_str).filter(|s| !s.trim().is_empty()))
            .unwrap_or("")
            .trim()
            .to_string();
        {
            let mut session = self.session.lock().await;
            session.user_id = user_id.clone();
            session.token = token.to_string();
            session.last_message_id = "0".into();
        }
        if let Some(lobby) = self.join_linked_lobby(server_url, &user_id, token_fn).await {
            self.session.lock().await.lobby_id = lobby.clone();
            self.patch(|s| {
                s.lobby_ready = true;
                s.lobby_id = lobby;
                s.linked_lobby = true;
                s.username = name;
            });
            self.status("Lobby chat connected to the Discord channel.");
            return Ok(());
        }
        let lobby = match api(
            Method::PUT,
            "/lobbies",
            token,
            Some(json!({ "secret": config.lobby_secret, "idle_timeout_seconds": 604800 })),
        )
        .await
        {
            Ok(v) => v,
            Err(e) if e.status == 401 || e.status == 403 => return Err(401),
            Err(e) => {
                self.status(format!("The Discord lobby could not be joined: {}", e.message));
                return Err(0);
            }
        };
        let lobby_id = lobby.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        self.session.lock().await.lobby_id = lobby_id.clone();
        self.patch(|s| {
            s.lobby_ready = true;
            s.lobby_id = lobby_id.clone();
            s.linked_lobby = false;
            s.username = name;
        });
        self.status("Lobby chat connected.");
        if config.channel_linking && !config.channel_id.is_empty() {
            let linked = lobby.pointer("/linked_channel/id").and_then(Value::as_str) == Some(config.channel_id.as_str());
            if !linked {
                let path = format!("/lobbies/{lobby_id}/channel-linking");
                match api(Method::PATCH, &path, token, Some(json!({ "channel_id": config.channel_id }))).await {
                    Ok(_) => self.status("Discord channel linked to the lobby."),
                    Err(e) => self.status(format!("Channel link failed: {}", e.message)),
                }
            }
        }
        Ok(())
    }

    async fn join_linked_lobby(&self, server_url: &str, user_id: &str, token_fn: &TokenFn) -> Option<String> {
        if server_url.is_empty() {
            return None;
        }
        for _ in 0..LINKED_ATTEMPTS {
            let token = token_fn();
            let mut body = json!({ "userId": user_id });
            if !token.is_empty() {
                body["token"] = json!(token);
            }
            let result = request_json(
                Method::POST,
                &format!("{server_url}/api/discord/lobby/join"),
                Some(&body),
                &[],
                Duration::from_secs(8),
            )
            .await;
            let lobby = result.str("lobbyId");
            if result.ok() && result.flag("ok") && !lobby.is_empty() {
                return Some(lobby);
            }
            let reason = {
                let r = result.str("reason");
                if r.is_empty() { result.describe() } else { r }
            };
            if result.status == 404 || result.status == 403 {
                self.status(match reason.as_str() {
                    "discord-account-mismatch" => "Lobby chat uses a different Discord account than your game account; using a private lobby.",
                    "discord-not-linked" => "Sign in with Discord to talk in the Discord channel; using a private lobby.",
                    _ => "This server has no Discord channel lobby; using a private lobby.",
                });
                return None;
            }
            self.status(format!("Waiting to join the Discord channel lobby ({reason})..."));
            tokio::time::sleep(Duration::from_secs(15)).await;
        }
        None
    }

    async fn poll_loop(&self, config: &Config) -> bool {
        loop {
            let (token, lobby) = {
                let s = self.session.lock().await;
                (s.token.clone(), s.lobby_id.clone())
            };
            match api(Method::GET, &format!("/lobbies/{lobby}/messages?limit=50"), &token, None).await {
                Ok(Value::Array(messages)) => {
                    for message in messages.iter().rev() {
                        self.deliver(message).await;
                    }
                }
                Ok(_) => {}
                Err(e) if e.status == 401 => {
                    self.patch(|s| s.lobby_ready = false);
                    return true;
                }
                Err(e) => self.status(format!("Lobby poll failed: {}", e.message)),
            }
            tokio::time::sleep(Duration::from_millis(config.poll_ms)).await;
        }
    }

    async fn deliver(&self, message: &Value) {
        let id = message.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        if id.is_empty() {
            return;
        }
        let author = message.get("author").cloned().unwrap_or(Value::Null);
        {
            let mut s = self.session.lock().await;
            if s.awaiting_self == id || author.get("id").and_then(Value::as_str) == Some(s.user_id.as_str()) {
                s.awaiting_self.clear();
                if snowflake_gt(&id, &s.last_message_id) {
                    s.last_message_id = id;
                }
                return;
            }
            if !snowflake_gt(&id, &s.last_message_id) {
                return;
            }
            let first = s.last_message_id == "0";
            s.last_message_id = id;
            if first {
                return;
            }
        }
        let name = message
            .pointer("/lobby_member/additional_name")
            .or_else(|| author.get("global_name"))
            .or_else(|| author.get("username"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("Discord")
            .to_string();
        let content = message.get("content").and_then(Value::as_str).unwrap_or("").to_string();
        let sink = self.sink.lock().unwrap().clone();
        if let Some(sink) = sink {
            sink(name, content);
        }
    }

    pub async fn send_chat(&self, sender: &str, message: &str) -> Result<(), String> {
        let text = message.trim();
        if text.is_empty() {
            return Err("Refusing to send an empty message.".into());
        }
        if !self.snapshot().lobby_ready {
            return Err("The lobby is not ready yet.".into());
        }
        let _ = sender;
        let (token, lobby) = {
            let s = self.session.lock().await;
            (s.token.clone(), s.lobby_id.clone())
        };
        match api(Method::POST, &format!("/lobbies/{lobby}/messages"), &token, Some(json!({ "content": text }))).await {
            Ok(sent) => {
                self.session.lock().await.awaiting_self = sent.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                Ok(())
            }
            Err(e) => {
                self.status(format!("Message was not sent: {}", e.message));
                Err(e.message)
            }
        }
    }
}

fn snowflake_gt(candidate: &str, reference: &str) -> bool {
    match (candidate.parse::<u128>(), reference.parse::<u128>()) {
        (Ok(a), Ok(b)) => a > b,
        _ => candidate > reference,
    }
}

async fn api(method: Method, path: &str, token: &str, body: Option<Value>) -> Result<Value, RestError> {
    let mut request = client()
        .request(method, format!("{API}{path}"))
        .bearer_auth(token)
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(10));
    if let Some(body) = body {
        request = request.json(&body);
    }
    finish(request.send().await).await
}

async fn form_post(fields: &[(&str, String)]) -> Result<Value, RestError> {
    let request = client().post(TOKEN_URL).form(fields).header("Accept", "application/json").timeout(Duration::from_secs(10));
    finish(request.send().await).await
}

async fn finish(response: reqwest::Result<reqwest::Response>) -> Result<Value, RestError> {
    let response = response.map_err(|e| RestError { status: 0, message: e.to_string() })?;
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        let message = ["message", "error_description", "error"]
            .iter()
            .find_map(|k| body.get(*k).and_then(Value::as_str))
            .map(str::to_string)
            .unwrap_or_else(|| format!("Discord answered {status}."));
        return Err(RestError { status, message });
    }
    Ok(body)
}
