use reqwest::Method;
use serde_json::Value;
use std::sync::OnceLock;
use std::time::Duration;

pub fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(concat!("dungeon-blitz-r-launcher/", env!("CARGO_PKG_VERSION")))
            .pool_idle_timeout(Duration::from_secs(90))
            .build()
            .expect("http client")
    })
}

#[derive(Clone, Debug, Default)]
pub struct JsonResponse {
    pub status: u16,
    pub body: Option<Value>,
    pub error: String,
}

impl JsonResponse {
    pub fn success(&self) -> bool {
        (200..300).contains(&self.status)
    }
    pub fn ok(&self) -> bool {
        self.success() && self.body.is_some()
    }
    pub fn field(&self, key: &str) -> Option<&Value> {
        self.body.as_ref().and_then(|b| b.get(key))
    }
    pub fn str(&self, key: &str) -> String {
        self.field(key).and_then(Value::as_str).unwrap_or("").to_string()
    }
    pub fn flag(&self, key: &str) -> bool {
        self.field(key) == Some(&Value::Bool(true))
    }
    pub fn describe(&self) -> String {
        if self.status != 0 {
            self.status.to_string()
        } else if !self.error.is_empty() {
            self.error.clone()
        } else {
            "no answer".into()
        }
    }
}

pub async fn request_json(
    method: Method,
    url: &str,
    body: Option<&Value>,
    headers: &[(&str, String)],
    timeout: Duration,
) -> JsonResponse {
    let mut request = client()
        .request(method, url)
        .timeout(timeout)
        .header("Cache-Control", "no-store")
        .header("Accept", "application/json");
    for (name, value) in headers {
        request = request.header(*name, value);
    }
    if let Some(body) = body {
        request = request.json(body);
    }
    match request.send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            let text = response.text().await.unwrap_or_default();
            let parsed = if text.trim().is_empty() { None } else { serde_json::from_str(&text).ok() };
            let error = if (200..300).contains(&status) && parsed.is_none() { "invalid-json".into() } else { String::new() };
            JsonResponse { status, body: parsed, error }
        }
        Err(error) => JsonResponse { status: 0, body: None, error: error.to_string() },
    }
}

pub async fn get_json(url: &str, headers: &[(&str, String)], timeout: Duration) -> Option<Value> {
    let response = request_json(Method::GET, url, None, headers, timeout).await;
    if response.success() { response.body } else { None }
}

pub async fn post_json(url: &str, body: &Value, timeout: Duration) -> JsonResponse {
    request_json(Method::POST, url, Some(body), &[], timeout).await
}

pub async fn get_text(url: &str, timeout: Duration, max_bytes: usize) -> String {
    let Ok(response) = client().get(url).timeout(timeout).header("Cache-Control", "no-store").send().await else {
        return String::new();
    };
    if !response.status().is_success() {
        return String::new();
    }
    let bytes = response.bytes().await.unwrap_or_default();
    String::from_utf8_lossy(&bytes[..bytes.len().min(max_bytes)]).into_owned()
}
