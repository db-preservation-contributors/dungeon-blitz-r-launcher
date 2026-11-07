use base64::Engine;
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;
use url::Url;

use crate::config::absolute;
use crate::net;

pub const LOGIN_KEY_HEADER: &str = "X-Launcher-Login-Key";
pub const LOGIN_CODE_HEADER: &str = "X-Launcher-Login-Code";
const TIMEOUT: Duration = Duration::from_secs(8);

pub fn random_base64url(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buffer);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buffer)
}

pub fn create_login_key() -> String {
    random_base64url(32)
}

pub fn login_key_hash(key: &str) -> String {
    hex::encode(Sha256::digest(key.as_bytes()))
}

pub fn login_url(game_url: &str, key: &str) -> String {
    let url = absolute(game_url, "/auth/discord");
    if url.is_empty() || key.is_empty() {
        return url;
    }
    let mut parsed = Url::parse(&url).unwrap();
    parsed.query_pairs_mut().append_pair("launcher", &login_key_hash(key));
    parsed.to_string()
}

fn key_headers(key: &str, code: &str) -> Vec<(&'static str, String)> {
    let mut headers = Vec::new();
    if !key.is_empty() {
        headers.push((LOGIN_KEY_HEADER, key.to_string()));
        if !code.is_empty() {
            headers.push((LOGIN_CODE_HEADER, code.to_string()));
        }
    }
    headers
}

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn yes(value: &Value, key: &str) -> bool {
    value.get(key) == Some(&Value::Bool(true))
}

pub async fn server_reachable(game_url: &str) -> bool {
    net::get_json(&absolute(game_url, "/api/auth/discord/config"), &[], TIMEOUT).await.is_some()
}

#[derive(Clone, Debug, Default)]
pub struct Account {
    pub linked: bool,
    pub email: String,
    pub username: String,
    pub global_name: String,
}

pub async fn fetch_discord_account(game_url: &str) -> Option<Account> {
    let payload = net::get_json(&absolute(game_url, "/api/discord/account"), &[], TIMEOUT).await?;
    Some(Account {
        linked: yes(&payload, "linked"),
        email: text(&payload, "email"),
        username: text(&payload, "username"),
        global_name: text(&payload, "globalName"),
    })
}

pub async fn fetch_pending(game_url: &str) -> Option<String> {
    let payload = net::get_json(&absolute(game_url, "/api/auth/discord/pending"), &[], TIMEOUT).await?;
    yes(&payload, "pending").then(|| text(&payload, "email"))
}

#[derive(Clone, Debug, Default)]
pub struct LoginStatus {
    pub signed_in: bool,
    pub email: String,
    pub code_required: bool,
    pub code_rejected: bool,
}

pub async fn fetch_login_status(game_url: &str, key: &str, code: &str) -> LoginStatus {
    let payload =
        net::get_json(&absolute(game_url, "/api/auth/launcher/login-state"), &key_headers(key, code), TIMEOUT).await;
    let payload = payload.unwrap_or(Value::Null);
    LoginStatus {
        signed_in: yes(&payload, "signedIn"),
        email: text(&payload, "email"),
        code_required: yes(&payload, "codeRequired"),
        code_rejected: yes(&payload, "codeRejected"),
    }
}

#[derive(Clone, Debug)]
pub struct Issued {
    pub token: String,
    pub email: String,
}

pub async fn issue_session(game_url: &str, key: &str) -> Option<Issued> {
    let payload = net::get_json(&absolute(game_url, "/api/auth/launcher/session"), &key_headers(key, ""), TIMEOUT).await?;
    let token = text(&payload, "token");
    (yes(&payload, "ok") && !token.is_empty()).then(|| Issued { token, email: text(&payload, "email") })
}

pub enum Resume {
    Ok(Issued),
    Expired,
    Unavailable,
}

pub async fn resume_session(game_url: &str, token: &str) -> Resume {
    let response = net::post_json(&absolute(game_url, "/api/auth/launcher/resume"), &json!({ "token": token }), TIMEOUT).await;
    let body = response.body.clone().unwrap_or(Value::Null);
    let next = text(&body, "token");
    if response.status == 200 && yes(&body, "ok") && !next.is_empty() {
        return Resume::Ok(Issued { token: next, email: text(&body, "email") });
    }
    if response.status == 401 { Resume::Expired } else { Resume::Unavailable }
}

pub async fn forget_session(game_url: &str, token: &str) {
    if !token.is_empty() {
        net::post_json(&absolute(game_url, "/api/auth/launcher/forget"), &json!({ "token": token }), TIMEOUT).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_url_names_key_by_hash() {
        let key = "abc";
        let url = login_url("http://dungeonblitzr.theminesa.studio/", key);
        assert_eq!(
            url,
            format!("http://dungeonblitzr.theminesa.studio/auth/discord?launcher={}", login_key_hash(key))
        );
        assert!(!url.contains("=abc"));
        assert_eq!(create_login_key().len(), 43);
    }
}
