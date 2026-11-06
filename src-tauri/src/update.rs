use serde::Serialize;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::config::{is_packaged, now_ms, ARCH, PLATFORM};
use crate::Bus;

const OWNER: &str = "theminesastudios";
const REPO: &str = "dungeon-blitz-r-launcher";
const START_DELAY: Duration = Duration::from_secs(5);
const INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub mode: String,
    pub state: String,
    pub percent: u32,
    pub version: String,
    pub asset: String,
    pub error: String,
    pub current_version: String,
    pub last_checked_at: u64,
    #[serde(skip)]
    pub download_url: String,
}

pub fn build_name() -> &'static str {
    match PLATFORM {
        "darwin" => "mac",
        "win32" if cfg!(feature = "win7") => "win7-setup",
        "win32" => "win-setup",
        _ if std::env::var("APPIMAGE").is_ok() => "linux-appimage",
        _ => "linux-deb",
    }
}

fn parse(value: &str) -> Option<([u64; 3], Vec<String>)> {
    let v = value.trim().trim_start_matches(['v', 'V']);
    let v = v.split('+').next()?;
    let (core, pre) = match v.split_once('-') {
        Some((c, p)) => (c, p.split('.').map(str::to_string).collect()),
        None => (v, vec![]),
    };
    let parts: Vec<u64> = core.split('.').map(|p| p.parse().ok()).collect::<Option<_>>()?;
    (parts.len() == 3).then(|| ([parts[0], parts[1], parts[2]], pre))
}

pub fn compare(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    use std::cmp::Ordering::*;
    let (ac, ap) = parse(a)?;
    let (bc, bp) = parse(b)?;
    if ac != bc {
        return Some(ac.cmp(&bc));
    }
    match (ap.is_empty(), bp.is_empty()) {
        (true, true) => return Some(Equal),
        (true, false) => return Some(Greater),
        (false, true) => return Some(Less),
        _ => {}
    }
    for i in 0..ap.len().max(bp.len()) {
        let (Some(x), Some(y)) = (ap.get(i), bp.get(i)) else {
            return Some(if ap.len() < bp.len() { Less } else { Greater });
        };
        let ord = match (x.parse::<u64>(), y.parse::<u64>()) {
            (Ok(m), Ok(n)) => m.cmp(&n),
            (Ok(_), Err(_)) => Less,
            (Err(_), Ok(_)) => Greater,
            _ => x.cmp(y),
        };
        if ord != Equal {
            return Some(ord);
        }
    }
    Some(Equal)
}

pub fn pick_asset(assets: &[Value], build: &str, arch: &str) -> Option<(String, String)> {
    let files: Vec<(String, String)> = assets
        .iter()
        .filter_map(|a| Some((a.get("name")?.as_str()?.to_string(), a.get("browser_download_url")?.as_str()?.to_string())))
        .collect();
    let named = |suffix: &str| files.iter().find(|(n, _)| n.to_lowercase().ends_with(&suffix.to_lowercase())).cloned();
    match build {
        "mac" => named(&format!("-mac-{arch}.dmg")).or_else(|| named(".dmg")),
        "win-setup" => named(&format!("-win-{arch}-setup.exe")),
        "win7-setup" => named(&format!("-win7-{arch}-setup.exe")),
        "linux-appimage" => named(".appimage"),
        "linux-deb" => named(".deb"),
        _ => None,
    }
}

fn allowed(url: &str) -> bool {
    url::Url::parse(url).map(|u| u.scheme() == "https" && u.host_str() == Some("github.com")).unwrap_or(false)
}

#[derive(Clone)]
pub struct Updates {
    bus: Bus,
    state: Arc<Mutex<UpdateState>>,
}

impl Updates {
    pub fn new(version: String, bus: Bus) -> Self {
        let state = UpdateState {
            mode: "notice".into(),
            state: if is_packaged() { "idle".into() } else { "disabled".into() },
            percent: 0,
            version: String::new(),
            asset: String::new(),
            error: String::new(),
            current_version: version,
            last_checked_at: 0,
            download_url: String::new(),
        };
        Self { bus, state: Arc::new(Mutex::new(state)) }
    }

    pub fn summary(&self) -> UpdateState {
        self.state.lock().unwrap().clone()
    }

    pub fn download_url(&self) -> String {
        let s = self.state.lock().unwrap();
        if s.state == "available" && allowed(&s.download_url) { s.download_url.clone() } else { String::new() }
    }

    pub fn start(&self) {
        if !is_packaged() || crate::config::env_off("DUNGEON_BLITZ_UPDATE_CHECK") {
            return;
        }
        let me = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(START_DELAY).await;
            loop {
                me.check().await;
                tokio::time::sleep(INTERVAL).await;
            }
        });
    }

    async fn check(&self) {
        let current = {
            let mut s = self.state.lock().unwrap();
            s.last_checked_at = now_ms();
            if s.state != "available" {
                s.state = "checking".into();
            }
            s.current_version.clone()
        };
        (self.bus)();
        let endpoint = format!("https://api.github.com/repos/{OWNER}/{REPO}/releases/latest");
        let response = crate::net::client()
            .get(&endpoint)
            .header("Accept", "application/vnd.github+json")
            .timeout(Duration::from_secs(15))
            .send()
            .await;
        let body = match response {
            Ok(r) if r.status().is_success() => r.json::<Value>().await.ok(),
            Ok(r) => {
                println!("[Update] check failed: GitHub answered {}", r.status());
                None
            }
            Err(e) => {
                println!("[Update] check failed: {e}");
                None
            }
        };
        let mut s = self.state.lock().unwrap();
        let Some(release) = body else {
            if s.state == "checking" {
                s.state = "idle".into();
            }
            drop(s);
            (self.bus)();
            return;
        };
        let tag = release.get("tag_name").and_then(Value::as_str).unwrap_or("").to_string();
        let newer = compare(&tag, &current) == Some(std::cmp::Ordering::Greater);
        if !newer || release.get("draft") == Some(&Value::Bool(true)) || release.get("prerelease") == Some(&Value::Bool(true)) {
            s.state = "not-available".into();
            s.version.clear();
            s.download_url.clear();
            s.asset.clear();
        } else {
            let assets = release.get("assets").and_then(Value::as_array).cloned().unwrap_or_default();
            let page = release.get("html_url").and_then(Value::as_str).unwrap_or("").to_string();
            let (asset, url) = pick_asset(&assets, build_name(), ARCH).unwrap_or((String::new(), page));
            s.state = "available".into();
            s.version = tag.trim_start_matches(['v', 'V']).to_string();
            s.asset = asset;
            s.download_url = url;
            println!("[Update] {} is available: {}", s.version, s.download_url);
        }
        drop(s);
        (self.bus)();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering::*;

    #[test]
    fn versions() {
        assert_eq!(compare("v1.12.0", "1.11.3"), Some(Greater));
        assert_eq!(compare("1.11.3", "1.11.3"), Some(Equal));
        assert_eq!(compare("2.0.0-alpha.1", "2.0.0"), Some(Less));
        assert_eq!(compare("nope", "1.0.0"), None);
    }

    #[test]
    fn assets() {
        let assets = serde_json::json!([
            { "name": "DungeonBlitzR-Launcher-2.0.0-win7-x64-setup.exe", "browser_download_url": "https://github.com/a/7" },
            { "name": "DungeonBlitzR-Launcher-2.0.0-win-x64-setup.exe", "browser_download_url": "https://github.com/a/10" }
        ]);
        let list = assets.as_array().unwrap();
        assert_eq!(pick_asset(list, "win-setup", "x64").unwrap().1, "https://github.com/a/10");
        assert_eq!(pick_asset(list, "win7-setup", "x64").unwrap().1, "https://github.com/a/7");
    }
}
