//! Developer mode's Join (and Play on my server): the game ports on this machine bridged to a
//! test server, so the AIR engine plays it as if it were local. Port of lib/devJoin.js.
//!
//! - own server (`Target::Local`): 8000 -> 8100 (web) and 8080 -> 8180 (game), plain TCP.
//! - someone's shared server (`Target::Tunnel`): 8000 is an HTTP proxy to its https web tunnel,
//!   8080 and 8180 carry the game's TCP stream over its wss game-socket tunnel.

use futures_util::{SinkExt, StreamExt};
use regex::Regex;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;

use crate::dev::{PORT_GAME, PORT_WEB};

pub const POLICY_FILE: &str =
    "<?xml version=\"1.0\"?><cross-domain-policy><allow-access-from domain=\"*\" to-ports=\"*\"/></cross-domain-policy>\0";
const PORT_HTTP: u16 = 8000;
const PORT_LOGIN: u16 = 8080;
const PORT_WORLD: u16 = 8180;
const PORT_POLICY: u16 = 843;
const MAX_HEAD: usize = 64 * 1024;
const MAX_BODY: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    Local,
    Tunnel { web_host: String, ws_host: String },
}

/// The host of a `https://....trycloudflare.com` share address, or None.
pub fn parse_share_address(address: &str) -> Option<String> {
    let url = url::Url::parse(address.trim()).ok()?;
    let host = url.host_str()?.to_string();
    let pattern = Regex::new(r"^[a-z0-9-]+\.trycloudflare\.com$").unwrap();
    (url.scheme() == "https" && pattern.is_match(&host)).then_some(host)
}

async fn fetch_text(url: &str) -> Result<String, String> {
    let response = crate::net::client()
        .get(url)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| format!("{url} did not answer"))?;
    if response.status().as_u16() != 200 {
        return Err(format!("{url} answered {}", response.status().as_u16()));
    }
    response.text().await.map_err(|e| e.to_string())
}

/// The shared server's two tunnels: its web host, and the game socket its /web page names.
pub async fn resolve_tunnel(address: &str) -> Result<Target, String> {
    let web_host = parse_share_address(address).ok_or("That is not a https://....trycloudflare.com address.")?;
    let page = fetch_text(&format!("https://{web_host}/web")).await?;
    let ws = Regex::new(r"wss://([a-z0-9-]+\.trycloudflare\.com)").unwrap();
    let ws_host = ws.captures(&page).map(|c| c[1].to_string()).ok_or("That server names no game socket. Is it running?")?;
    let index = fetch_text(&format!("https://{web_host}/")).await?;
    if !index.contains("/p/cbp/DungeonBlitz.swf?") {
        return Err("That server names no game SWF.".into());
    }
    Ok(Target::Tunnel { web_host, ws_host })
}

/// The listeners of one bridge; dropping or closing it frees the ports.
pub struct Bridge {
    pub page_url: String,
    tasks: Vec<tauri::async_runtime::JoinHandle<()>>,
}

impl Bridge {
    pub fn close(&mut self) {
        for task in self.tasks.drain(..) {
            task.abort();
        }
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.close();
    }
}

async fn listen(port: u16, name: &str) -> Result<TcpListener, String> {
    TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| format!("Port {port} ({name}) is in use on this computer: {e}"))
}

fn serve<F, Fut>(listener: TcpListener, handle: F) -> tauri::async_runtime::JoinHandle<()>
where
    F: Fn(TcpStream) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let _ = socket.set_nodelay(true);
            tauri::async_runtime::spawn(handle(socket));
        }
    })
}

async fn forward(mut socket: TcpStream, port: u16) {
    if let Ok(mut upstream) = TcpStream::connect(("127.0.0.1", port)).await {
        let _ = upstream.set_nodelay(true);
        let _ = tokio::io::copy_bidirectional(&mut socket, &mut upstream).await;
    }
}

async fn policy(mut socket: TcpStream) {
    let mut buffer = [0u8; 64];
    let _ = tokio::time::timeout(Duration::from_secs(5), socket.read(&mut buffer)).await;
    let _ = socket.write_all(POLICY_FILE.as_bytes()).await;
    let _ = socket.shutdown().await;
}

/// The game's TCP stream over the shared server's WebSocket game socket.
async fn tunnel_game(mut socket: TcpStream, ws_host: String) {
    let mut first = vec![0u8; 16 * 1024];
    let n = match socket.read(&mut first).await {
        Ok(0) | Err(_) => return,
        Ok(n) => n,
    };
    first.truncate(n);
    if first.starts_with(b"<policy-file-request/>") {
        let _ = socket.write_all(POLICY_FILE.as_bytes()).await;
        let _ = socket.shutdown().await;
        return;
    }
    let ws = match tokio_tungstenite::connect_async(format!("wss://{ws_host}/")).await {
        Ok((ws, _)) => ws,
        Err(error) => {
            println!("[DevJoin] the game socket tunnel failed: {error}");
            return;
        }
    };
    let (mut ws_tx, mut ws_rx) = ws.split();
    if ws_tx.send(Message::binary(first)).await.is_err() {
        return;
    }
    let (mut tcp_rx, mut tcp_tx) = socket.into_split();
    let up = async {
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            match tcp_rx.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if ws_tx.send(Message::binary(buffer[..n].to_vec())).await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = ws_tx.close().await;
    };
    let down = async {
        while let Some(Ok(message)) = ws_rx.next().await {
            let bytes = match message {
                Message::Binary(b) => b.to_vec(),
                Message::Text(t) => t.as_bytes().to_vec(),
                Message::Close(_) => break,
                _ => continue,
            };
            if tcp_tx.write_all(&bytes).await.is_err() {
                break;
            }
        }
        let _ = tcp_tx.shutdown().await;
    };
    tokio::select! {
        _ = up => {}
        _ = down => {}
    }
}

fn find_head_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}

/// One HTTP/1.1 request on 8000, passed to the shared server's https web tunnel. Each answer
/// closes its connection, which is all the AIR engine's loader needs.
async fn tunnel_http(mut socket: TcpStream, web_host: String) {
    let mut buffer = Vec::with_capacity(8 * 1024);
    let head_end = loop {
        if let Some(end) = find_head_end(&buffer) {
            break end;
        }
        if buffer.len() > MAX_HEAD {
            return;
        }
        let mut chunk = [0u8; 8 * 1024];
        match socket.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => buffer.extend_from_slice(&chunk[..n]),
        }
    };
    let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next().unwrap_or("").split_whitespace();
    let (Some(method), Some(path)) = (request_line.next(), request_line.next()) else { return };
    let mut headers = Vec::new();
    let mut length = 0usize;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else { continue };
        let (name, value) = (name.trim().to_ascii_lowercase(), value.trim().to_string());
        match name.as_str() {
            "host" | "connection" | "proxy-connection" | "keep-alive" | "transfer-encoding" | "upgrade" => {}
            "content-length" => length = value.parse().unwrap_or(0),
            _ => headers.push((name, value)),
        }
    }
    let mut body = buffer[head_end..].to_vec();
    while body.len() < length.min(MAX_BODY) {
        let mut chunk = [0u8; 16 * 1024];
        match socket.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => body.extend_from_slice(&chunk[..n]),
        }
    }
    let Ok(method) = reqwest::Method::from_bytes(method.as_bytes()) else { return };
    let mut request = crate::net::client().request(method, format!("https://{web_host}{path}")).timeout(Duration::from_secs(60));
    for (name, value) in &headers {
        request = request.header(name, value);
    }
    if !body.is_empty() {
        request = request.body(body);
    }
    let reply = match request.send().await {
        Ok(reply) => reply,
        Err(error) => {
            println!("[DevJoin] {path}: {error}");
            let _ = socket.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            return;
        }
    };
    let status = reply.status();
    let mut out = format!("HTTP/1.1 {} {}\r\n", status.as_u16(), status.canonical_reason().unwrap_or(""));
    for (name, value) in reply.headers() {
        let lower = name.as_str();
        if matches!(lower, "connection" | "keep-alive" | "transfer-encoding" | "content-length") {
            continue;
        }
        if let Ok(value) = value.to_str() {
            out.push_str(&format!("{name}: {value}\r\n"));
        }
    }
    let bytes = reply.bytes().await.unwrap_or_default();
    out.push_str(&format!("Content-Length: {}\r\nConnection: close\r\n\r\n", bytes.len()));
    if socket.write_all(out.as_bytes()).await.is_ok() {
        let _ = socket.write_all(&bytes).await;
    }
    let _ = socket.shutdown().await;
}

/// Opens the bridge for `target`. The game page is then at `page_url`.
pub async fn open_bridge(target: &Target) -> Result<Bridge, String> {
    let mut bridge = Bridge { page_url: format!("http://localhost:{PORT_HTTP}/"), tasks: Vec::new() };
    match target {
        Target::Local => {
            let web = listen(PORT_HTTP, "web").await?;
            let login = listen(PORT_LOGIN, "login").await?;
            bridge.tasks.push(serve(web, |s| forward(s, PORT_WEB)));
            bridge.tasks.push(serve(login, |s| forward(s, PORT_GAME)));
        }
        Target::Tunnel { web_host, ws_host } => {
            let web = listen(PORT_HTTP, "web").await?;
            let login = listen(PORT_LOGIN, "login").await?;
            let world = listen(PORT_WORLD, "world").await?;
            let host = web_host.clone();
            bridge.tasks.push(serve(web, move |s| tunnel_http(s, host.clone())));
            let host = ws_host.clone();
            bridge.tasks.push(serve(login, move |s| tunnel_game(s, host.clone())));
            let host = ws_host.clone();
            bridge.tasks.push(serve(world, move |s| tunnel_game(s, host.clone())));
        }
    }
    // 843 needs administrator rights on most systems; the game ports answer the policy too.
    if let Ok(listener) = TcpListener::bind(("127.0.0.1", PORT_POLICY)).await {
        bridge.tasks.push(serve(listener, policy));
    }
    Ok(bridge)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn share_address_is_https_trycloudflare_only() {
        assert_eq!(parse_share_address("https://abc-def.trycloudflare.com/web").as_deref(), Some("abc-def.trycloudflare.com"));
        assert_eq!(parse_share_address("http://abc.trycloudflare.com/web"), None);
        assert_eq!(parse_share_address("https://evil.com/?abc.trycloudflare.com"), None);
        assert_eq!(parse_share_address("https://abc.trycloudflare.com.evil.com/"), None);
        assert_eq!(parse_share_address(""), None);
    }

    #[test]
    fn finds_the_end_of_a_request_head() {
        assert_eq!(find_head_end(b"GET / HTTP/1.1\r\nHost: x\r\n\r\nbody"), Some(27));
        assert_eq!(find_head_end(b"GET / HTTP/1.1\r\n"), None);
    }
}
