//! Developer mode's Create: a game server checkout run here as a test server behind two
//! Cloudflare quick tunnels (the web page and the WebSocket game socket), so anyone can join it
//! from its trycloudflare.com address. Port of lib/devServer.js and lib/cloudflared.js.

use regex::Regex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot};

use crate::config::{now_ms, ARCH, PLATFORM};
use crate::Bus;

pub const PORT_WEB: u16 = 8100;
pub const PORT_GAME: u16 = 8180;
pub const PORT_WEBSOCKET: u16 = 8181;
const READY_TIMEOUT: Duration = Duration::from_secs(180);
const TUNNEL_TIMEOUT: Duration = Duration::from_secs(90);
const LOG_TAIL_LINES: usize = 40;

const CLOUDFLARED_VERSION: &str = "2026.10.3";

struct Asset {
    name: &'static str,
    sha256: &'static str,
    archive: bool,
}

fn cloudflared_asset() -> Option<Asset> {
    let (name, sha256, archive) = match (PLATFORM, ARCH) {
        ("win32", "x64") => ("cloudflared-windows-amd64.exe", "76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2", false),
        ("darwin", "x64") => ("cloudflared-darwin-amd64.tgz", "81b7b85f2376815c4f59b1aa323887b62e16ce8b67555c2e1577dc23f2a82000", true),
        ("darwin", "arm64") => ("cloudflared-darwin-arm64.tgz", "1165d14b6f6360a3b8c283d7d1100024d6ec7cd9bc9e32519e96150645f3ec55", true),
        ("linux", "x64") => ("cloudflared-linux-amd64", "053b80b0a23031a038fdbf3c073f59f82b8f1f152aa67971d7383ffafc0dbab0", false),
        ("linux", "arm64") => ("cloudflared-linux-arm64", "89297ebfb9e8c99c0dc013a1140601453cf3798d8306c5591651f4a3f5210be8", false),
        _ => return None,
    };
    Some(Asset { name, sha256, archive })
}

/// What the test server runs with: single player, its own ports, and nothing that reaches the
/// official server's databases, Discord or health pings.
pub fn test_server_env(websocket_public_url: &str) -> Vec<(&'static str, String)> {
    let mut env: Vec<(&'static str, String)> = [
        ("MULTIPLAYER_MODE", "false"),
        ("ENABLE_POLICY_SERVER", "false"),
        ("ENABLE_MONGO_GAME_DATA", "false"),
        ("GAME_MONGODB_URI", ""),
        ("MONGODB_URI", ""),
        ("SPONSOR_MONGODB_URI", ""),
        ("SPONSOR_ACCOUNT_CREATION_REQUIRED", "false"),
        ("HEALTH_PING_URL", ""),
        ("HEALTH_PING_SECRET", ""),
        ("DISCORD_LOG_URL", ""),
        ("DISCORD_LOG_SECRET", ""),
        ("DISCORD_BOT_TOKEN", ""),
        ("PLAYER_REPORTS_DISCORD_BOT_TOKEN", ""),
        ("DISCORD_SOCIAL_BRIDGE_ENABLED", "false"),
        ("DISCORD_SOCIAL_CHAT_WEBHOOK_URL", ""),
        ("WIDGET_PUBLISH_ENABLED", "false"),
        ("PUBLIC_BASE_URL", ""),
        ("BASE_URL", ""),
        ("PASSWORD_RESET_URL", ""),
        ("GAME_REGIONS", ""),
        ("REGION_ROUTING_ENABLED", "false"),
        ("SERVER_LOGS", "on"),
    ]
    .into_iter()
    .map(|(k, v)| (k, v.to_string()))
    .collect();
    env.push(("STATIC_PORT", PORT_WEB.to_string()));
    env.push(("GAME_PORT", PORT_GAME.to_string()));
    env.push(("WEBSOCKET_GAME_PORT", PORT_WEBSOCKET.to_string()));
    env.push(("WEBSOCKET_PUBLIC_URL", websocket_public_url.to_string()));
    env
}

#[derive(Debug)]
pub struct Checkout {
    pub server_dir: PathBuf,
    pub entry: &'static str,
}

/// The folder the player chose: a repository root or its src/server, with dependencies installed.
pub fn inspect_server_root(root: &str) -> Result<Checkout, String> {
    let picked = root.trim();
    if picked.is_empty() {
        return Err("Choose the game server folder first.".into());
    }
    let picked = PathBuf::from(picked);
    let server_dir = [picked.join("src").join("server"), picked.clone()]
        .into_iter()
        .find(|dir| dir.join("main.ts").exists())
        .ok_or_else(|| format!("{} is not a game server checkout (no src/server/main.ts).", picked.display()))?;
    if !server_dir.join("node_modules").join("ts-node").exists() {
        return Err(format!("Its dependencies are not installed: run `npm install` in {}.", server_dir.display()));
    }
    let entry = if server_dir.join("start-test-server.js").exists() { "start-test-server.js" } else { "main.ts" };
    Ok(Checkout { server_dir, entry })
}

/// Apps started from Finder do not get the shell's PATH, so the usual install places are tried
/// after `node` itself.
fn node_candidates() -> Vec<PathBuf> {
    let mut candidates = vec![PathBuf::from("node")];
    if PLATFORM != "darwin" && PLATFORM != "linux" {
        return candidates;
    }
    candidates.push("/opt/homebrew/bin/node".into());
    candidates.push("/usr/local/bin/node".into());
    candidates.push("/usr/bin/node".into());
    let home = dirs::home_dir().unwrap_or_default();
    let roots = [
        (home.join(".nvm").join("versions").join("node"), false),
        (home.join(".asdf").join("installs").join("nodejs"), false),
        (home.join(".local").join("share").join("fnm").join("node-versions"), true),
        (home.join("Library").join("Application Support").join("fnm").join("node-versions"), true),
    ];
    for (root, fnm) in roots {
        let Ok(entries) = std::fs::read_dir(&root) else { continue };
        let mut versions: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        versions.sort();
        versions.reverse();
        for version in versions {
            let dir = root.join(version);
            candidates.push(if fnm { dir.join("installation").join("bin").join("node") } else { dir.join("bin").join("node") });
        }
    }
    candidates
}

/// Node 18 or later, the version the game server needs. Blocking: runs `node --version`.
pub fn find_node() -> Result<(PathBuf, String), String> {
    let mut old = String::new();
    for command in node_candidates() {
        let mut probe = std::process::Command::new(&command);
        probe.arg("--version").stdin(Stdio::null()).stderr(Stdio::null());
        hide_console_std(&mut probe);
        let Ok(output) = probe.output() else { continue };
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let major: u32 = version.trim_start_matches('v').split('.').next().and_then(|m| m.parse().ok()).unwrap_or(0);
        if major < 18 {
            if !version.is_empty() {
                old = version;
            }
            continue;
        }
        return Ok((command, version));
    }
    if old.is_empty() {
        Err("Node.js is not installed (or not on PATH). The game server runs in it.".into())
    } else {
        Err(format!("Node {old} is too old for the game server; install Node 18 or later."))
    }
}

pub async fn port_open(port: u16) -> bool {
    matches!(
        tokio::time::timeout(Duration::from_secs(1), tokio::net::TcpStream::connect(("127.0.0.1", port))).await,
        Ok(Ok(_))
    )
}

#[cfg(windows)]
fn hide_console_std(command: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000);
}
#[cfg(not(windows))]
fn hide_console_std(_command: &mut std::process::Command) {}

/// Its own process group on Unix, so Stop takes the server's children with it.
fn background(command: &mut Command) {
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    #[cfg(unix)]
    command.process_group(0);
}

fn kill_tree(pid: Option<u32>) {
    let Some(pid) = pid else { return };
    #[cfg(windows)]
    {
        let mut kill = std::process::Command::new("taskkill");
        kill.args(["/PID", &pid.to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null());
        hide_console_std(&mut kill);
        let _ = kill.status();
    }
    #[cfg(unix)]
    {
        let _ = std::process::Command::new("kill").args(["-TERM", &format!("-{pid}")]).stderr(Stdio::null()).status();
    }
}

/// Sends each line of a child's output to `lines` until the pipe closes.
fn pump<R: AsyncRead + Unpin + Send + 'static>(reader: Option<R>, lines: mpsc::UnboundedSender<String>) {
    let Some(reader) = reader else { return };
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(reader).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = lines.send(line);
        }
    });
}

async fn ensure_cloudflared(tools_dir: &Path) -> Result<PathBuf, String> {
    let asset = cloudflared_asset().ok_or_else(|| format!("Cloudflare publishes no cloudflared for {PLATFORM}-{ARCH}."))?;
    let home = tools_dir.join(format!("cloudflared-{CLOUDFLARED_VERSION}"));
    let binary = home.join(if PLATFORM == "win32" { "cloudflared.exe" } else { "cloudflared" });
    let marker = home.join("verified.json");
    if binary.exists() && marker.exists() {
        return Ok(binary);
    }
    std::fs::create_dir_all(&home).map_err(|e| format!("Could not make {}: {e}", home.display()))?;
    let url = format!("https://github.com/cloudflare/cloudflared/releases/download/{CLOUDFLARED_VERSION}/{}", asset.name);
    println!("[DevServer] Downloading cloudflared {CLOUDFLARED_VERSION} ({})...", asset.name);
    let response = crate::net::client()
        .get(&url)
        .timeout(Duration::from_secs(300))
        .send()
        .await
        .map_err(|e| format!("cloudflared could not be downloaded: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("cloudflared download answered {}", response.status().as_u16()));
    }
    let bytes = response.bytes().await.map_err(|e| format!("cloudflared download failed: {e}"))?;
    let digest = hex::encode(Sha256::digest(&bytes));
    if digest != asset.sha256 {
        return Err(format!("The cloudflared download does not match its published checksum ({digest}); it was not kept."));
    }
    let downloaded = home.join(format!("{}.part", asset.name));
    std::fs::write(&downloaded, &bytes).map_err(|e| format!("Could not save cloudflared: {e}"))?;
    if asset.archive {
        let status = std::process::Command::new("tar").arg("-xzf").arg(&downloaded).arg("-C").arg(&home).status();
        let _ = std::fs::remove_file(&downloaded);
        if !matches!(status, Ok(s) if s.success()) {
            return Err("The cloudflared archive could not be unpacked.".into());
        }
    } else {
        std::fs::rename(&downloaded, &binary).map_err(|e| format!("Could not save cloudflared: {e}"))?;
    }
    if !binary.exists() {
        return Err("The cloudflared download held no cloudflared program.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755));
    }
    let _ = std::fs::write(
        &marker,
        serde_json::json!({ "version": CLOUDFLARED_VERSION, "asset": asset.name, "sha256": asset.sha256 }).to_string(),
    );
    Ok(binary)
}

fn tunnel_url_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"https://[a-z0-9-]+\.trycloudflare\.com").unwrap())
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevStatus {
    pub state: String,
    pub step: String,
    pub share_url: String,
    pub web_socket_url: String,
    pub root: String,
    pub error: String,
    pub log_tail: Vec<String>,
}

struct Proc {
    pid: Option<u32>,
    kill: oneshot::Sender<()>,
}

#[derive(Default)]
struct Inner {
    status: DevStatus,
    log_tail: Vec<String>,
    run_id: u64,
    children: Vec<Proc>,
}

#[derive(Clone)]
pub struct DevServer {
    bus: Bus,
    tools_dir: PathBuf,
    log_path: PathBuf,
    inner: Arc<Mutex<Inner>>,
}

impl DevServer {
    pub fn new(data_dir: &Path, bus: Bus) -> Self {
        let inner = Inner { status: DevStatus { state: "idle".into(), ..Default::default() }, ..Default::default() };
        Self {
            bus,
            tools_dir: data_dir.join("tools"),
            log_path: data_dir.join("dev-server.log"),
            inner: Arc::new(Mutex::new(inner)),
        }
    }

    pub fn summary(&self) -> DevStatus {
        let inner = self.inner.lock().unwrap();
        let mut status = inner.status.clone();
        let skip = inner.log_tail.len().saturating_sub(8);
        status.log_tail = inner.log_tail[skip..].to_vec();
        status
    }

    pub fn running(&self) -> bool {
        matches!(self.inner.lock().unwrap().status.state.as_str(), "running" | "starting")
    }

    fn set(&self, f: impl FnOnce(&mut DevStatus)) {
        f(&mut self.inner.lock().unwrap().status);
        (self.bus)();
    }

    fn stale(&self, run: u64) -> bool {
        self.inner.lock().unwrap().run_id != run
    }

    fn note_output(&self, line: &str) {
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&self.log_path) {
            use std::io::Write;
            let _ = writeln!(file, "{line}");
        }
        if line.trim().is_empty() {
            return;
        }
        let mut inner = self.inner.lock().unwrap();
        inner.log_tail.push(line.chars().take(300).collect());
        let excess = inner.log_tail.len().saturating_sub(LOG_TAIL_LINES);
        inner.log_tail.drain(..excess);
    }

    /// Keeps `child` for Stop, and fails the run with `exited` when it ends on its own.
    fn supervise(&self, mut child: Child, run: u64, exited: impl FnOnce(String) -> String + Send + 'static) {
        let (kill_tx, kill_rx) = oneshot::channel::<()>();
        self.inner.lock().unwrap().children.push(Proc { pid: child.id(), kill: kill_tx });
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            tokio::select! {
                status = child.wait() => {
                    let code = status.ok().and_then(|s| s.code()).map(|c| c.to_string()).unwrap_or_else(|| "none".into());
                    if !me.stale(run) && me.running() {
                        me.fail(exited(code));
                    }
                }
                _ = kill_rx => {
                    let _ = child.kill().await;
                }
            }
        });
    }

    fn stop_children(&self) {
        let children: Vec<Proc> = self.inner.lock().unwrap().children.drain(..).collect();
        for proc in children {
            kill_tree(proc.pid);
            let _ = proc.kill.send(());
        }
    }

    fn fail(&self, error: String) {
        self.stop_children();
        self.set(|s| {
            s.state = "error".into();
            s.step.clear();
            s.share_url.clear();
            s.web_socket_url.clear();
            s.error = error;
        });
    }

    pub fn stop(&self) -> DevStatus {
        self.inner.lock().unwrap().run_id += 1;
        self.stop_children();
        self.set(|s| {
            *s = DevStatus { state: "idle".into(), ..Default::default() };
        });
        self.summary()
    }

    /// One quick tunnel to a local port: its address once cloudflared has registered it.
    async fn quick_tunnel(&self, binary: &Path, port: u16, run: u64) -> Result<String, String> {
        let mut command = Command::new(binary);
        command.args(["tunnel", "--no-autoupdate", "--protocol", "http2", "--url", &format!("http://localhost:{port}")]);
        background(&mut command);
        let mut child = command.spawn().map_err(|e| format!("cloudflared could not be started: {e}"))?;
        let (tx, mut rx) = mpsc::unbounded_channel();
        pump(child.stdout.take(), tx.clone());
        pump(child.stderr.take(), tx);
        let deadline = Instant::now() + TUNNEL_TIMEOUT;
        let mut url = String::new();
        let mut registered = false;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Some(line)) => {
                    if line.contains(" ERR ") || line.contains("ERR ") {
                        self.note_output(&format!("tunnel {port}: {}", line.trim()));
                    }
                    if url.is_empty() {
                        if let Some(found) = tunnel_url_pattern().find(&line) {
                            url = found.as_str().to_string();
                        }
                    }
                    if line.contains("Registered tunnel connection") {
                        registered = true;
                    }
                    if !url.is_empty() && registered {
                        break;
                    }
                }
                Ok(None) => {
                    let _ = child.kill().await;
                    return Err(format!("the tunnel for port {port} stopped"));
                }
                Err(_) => {
                    let _ = child.kill().await;
                    return Err(format!("the tunnel for port {port} was not connected after {} s", TUNNEL_TIMEOUT.as_secs()));
                }
            }
        }
        // The output keeps draining, so cloudflared never blocks on a full pipe.
        tauri::async_runtime::spawn(async move { while rx.recv().await.is_some() {} });
        self.supervise(child, run, |_| "A tunnel stopped; Create again for new addresses.".into());
        Ok(url)
    }

    pub async fn start(&self, root: String) -> DevStatus {
        if self.running() {
            return self.summary();
        }
        let run = {
            let mut inner = self.inner.lock().unwrap();
            inner.run_id += 1;
            inner.log_tail.clear();
            inner.run_id
        };
        self.set(|s| {
            *s = DevStatus { state: "starting".into(), step: "Checking the server folder...".into(), root: root.clone(), ..Default::default() };
        });
        if let Err(error) = self.run(run, &root).await {
            if !self.stale(run) {
                self.fail(error);
            }
        }
        self.summary()
    }

    async fn run(&self, run: u64, root: &str) -> Result<(), String> {
        let checkout = inspect_server_root(root)?;
        let (node, version) = tauri::async_runtime::spawn_blocking(find_node).await.map_err(|e| e.to_string())??;
        println!("[DevServer] Node {version} at {}", node.display());
        for port in [PORT_WEB, PORT_GAME, PORT_WEBSOCKET] {
            if port_open(port).await {
                return Err(format!("Port {port} is already in use: is another test server running?"));
            }
        }

        self.set(|s| s.step = "Getting cloudflared...".into());
        let cloudflared = ensure_cloudflared(&self.tools_dir).await?;
        if self.stale(run) {
            return Ok(());
        }

        self.set(|s| s.step = "Opening the two tunnels...".into());
        let (web, socket) = tokio::join!(self.quick_tunnel(&cloudflared, PORT_WEB, run), self.quick_tunnel(&cloudflared, PORT_WEBSOCKET, run));
        if self.stale(run) {
            self.stop_children();
            return Ok(());
        }
        let (web, socket) = (web?, socket?);
        let websocket_url = socket.replacen("https:", "wss:", 1);

        self.set(|s| s.step = format!("Starting the server ({})...", checkout.entry));
        let _ = std::fs::write(
            &self.log_path,
            format!("[launcher] {} {} {}\n", now_ms(), checkout.server_dir.display(), checkout.entry),
        );
        let mut command = Command::new(&node);
        if checkout.entry == "start-test-server.js" {
            command.args(["start-test-server.js", &websocket_url]);
        } else {
            command.args(["-r", "ts-node/register/transpile-only", "main.ts"]);
        }
        command.current_dir(&checkout.server_dir);
        for (key, value) in test_server_env(&websocket_url) {
            command.env(key, value);
        }
        background(&mut command);
        let mut server = command.spawn().map_err(|e| format!("The server could not be started: {e}"))?;
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        pump(server.stdout.take(), tx.clone());
        pump(server.stderr.take(), tx);
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(line) = rx.recv().await {
                me.note_output(&line);
            }
        });
        self.supervise(server, run, |code| format!("The server stopped (code {code}). See the log below."));

        let started = Instant::now();
        while !(port_open(PORT_WEBSOCKET).await && port_open(PORT_WEB).await) {
            if self.stale(run) || !self.running() {
                return Ok(());
            }
            if started.elapsed() > READY_TIMEOUT {
                return Err("The server did not open its ports within three minutes.".into());
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        let share_url = format!("{web}/web");
        println!("[DevServer] Running: share {share_url}");
        self.set(|s| {
            s.state = "running".into();
            s.step.clear();
            s.share_url = share_url;
            s.web_socket_url = websocket_url;
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkout_needs_main_ts_and_ts_node() {
        let dir = std::env::temp_dir().join(format!("dbr-dev-{}", std::process::id()));
        let server = dir.join("src").join("server");
        std::fs::create_dir_all(server.join("node_modules")).unwrap();
        assert!(inspect_server_root(dir.to_str().unwrap()).is_err());
        std::fs::write(server.join("main.ts"), "").unwrap();
        assert!(inspect_server_root(dir.to_str().unwrap()).unwrap_err().contains("npm install"));
        std::fs::create_dir_all(server.join("node_modules").join("ts-node")).unwrap();
        let found = inspect_server_root(dir.to_str().unwrap()).unwrap();
        assert_eq!(found.entry, "main.ts");
        assert_eq!(found.server_dir, server);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn test_server_never_reaches_the_live_services() {
        let env = test_server_env("wss://a.trycloudflare.com");
        let get = |k: &str| env.iter().find(|(key, _)| *key == k).map(|(_, v)| v.clone()).unwrap();
        assert_eq!(get("MONGODB_URI"), "");
        assert_eq!(get("DISCORD_BOT_TOKEN"), "");
        assert_eq!(get("MULTIPLAYER_MODE"), "false");
        assert_eq!(get("WEBSOCKET_PUBLIC_URL"), "wss://a.trycloudflare.com");
    }
}
