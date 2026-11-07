use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, Mutex};

const OP_HANDSHAKE: u32 = 0;
const OP_FRAME: u32 = 1;
const OP_CLOSE: u32 = 2;
const OP_PING: u32 = 3;
const OP_PONG: u32 = 4;
const SOCKET_ATTEMPTS: usize = 10;
pub const READY_TIMEOUT: Duration = Duration::from_secs(10);
pub const AUTHORIZE_TIMEOUT: Duration = Duration::from_secs(300);

type Writer = Box<dyn AsyncWrite + Send + Unpin>;
type Reader = Box<dyn AsyncRead + Send + Unpin>;
type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;

pub struct DiscordIpc {
    writer: Arc<Mutex<Writer>>,
    pending: Pending,
    reader: tauri::async_runtime::JoinHandle<()>,
}

pub fn socket_paths() -> Vec<String> {
    let prefix = std::env::var("DUNGEON_BLITZ_DISCORD_SOCKET_NAME").unwrap_or_default();
    let name = format!("{}discord-ipc-", prefix.trim());
    let mut paths = Vec::new();
    if cfg!(windows) {
        for i in 0..SOCKET_ATTEMPTS {
            paths.push(format!(r"\\.\pipe\{name}{i}"));
        }
        return paths;
    }
    let directory = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]
        .iter()
        .find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty()))
        .unwrap_or_else(|| "/tmp".into());
    for i in 0..SOCKET_ATTEMPTS {
        paths.push(PathBuf::from(&directory).join(format!("{name}{i}")).to_string_lossy().into_owned());
    }
    paths
}

#[cfg(unix)]
async fn open(path: &str) -> std::io::Result<(Reader, Writer)> {
    let stream = tokio::net::UnixStream::connect(path).await?;
    let (r, w) = stream.into_split();
    Ok((Box::new(r), Box::new(w)))
}

#[cfg(windows)]
async fn open(path: &str) -> std::io::Result<(Reader, Writer)> {
    let client = tokio::net::windows::named_pipe::ClientOptions::new().open(path)?;
    let (r, w) = tokio::io::split(client);
    Ok((Box::new(r), Box::new(w)))
}

fn encode(opcode: u32, payload: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(payload).unwrap_or_default();
    let mut frame = Vec::with_capacity(8 + body.len());
    frame.extend_from_slice(&opcode.to_le_bytes());
    frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
    frame.extend_from_slice(&body);
    frame
}

pub fn nonce() -> String {
    let mut bytes = [0u8; 16];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    hex::encode(bytes)
}

impl DiscordIpc {
    pub async fn connect(client_id: &str, events: mpsc::UnboundedSender<(String, Value)>) -> Result<Self, String> {
        let mut last_error = String::from("Discord is not running.");
        let mut opened = None;
        for path in socket_paths() {
            match open(&path).await {
                Ok(pair) => {
                    opened = Some(pair);
                    break;
                }
                Err(error) => last_error = format!("Discord is not running. ({error})"),
            }
        }
        let Some((reader, writer)) = opened else { return Err(last_error) };
        let writer: Arc<Mutex<Writer>> = Arc::new(Mutex::new(writer));
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (ready_tx, ready_rx) = oneshot::channel();
        let reader = tauri::async_runtime::spawn(read_loop(reader, writer.clone(), pending.clone(), events, ready_tx));
        let client = Self { writer, pending, reader };
        client.send(OP_HANDSHAKE, &json!({ "v": 1, "client_id": client_id })).await;
        match tokio::time::timeout(READY_TIMEOUT, ready_rx).await {
            Ok(Ok(())) => Ok(client),
            _ => {
                client.close();
                Err("Discord did not answer the RPC handshake.".into())
            }
        }
    }

    async fn send(&self, opcode: u32, payload: &Value) {
        let mut writer = self.writer.lock().await;
        let _ = writer.write_all(&encode(opcode, payload)).await;
        let _ = writer.flush().await;
    }

    pub async fn request(&self, cmd: &str, args: Value, timeout: Duration) -> Result<Value, String> {
        let id = nonce();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);
        self.send(OP_FRAME, &json!({ "cmd": cmd, "args": args, "nonce": id })).await;
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Discord closed the connection.".into()),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!("Discord did not answer {cmd} in time."))
            }
        }
    }

    pub async fn authorize(&self, client_id: &str, scopes: &[String], challenge: &str, state: &str) -> Result<String, String> {
        let response = self
            .request(
                "AUTHORIZE",
                json!({
                    "client_id": client_id,
                    "scopes": scopes,
                    "code_challenge": challenge,
                    "code_challenge_method": "S256",
                    "state": state,
                    "nonce": nonce(),
                    "pid": std::process::id()
                }),
                AUTHORIZE_TIMEOUT,
            )
            .await?;
        response
            .pointer("/data/code")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "Discord did not return an authorization code.".to_string())
    }

    pub fn close(&self) {
        self.reader.abort();
    }
}

impl Drop for DiscordIpc {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

async fn read_loop(
    mut reader: Reader,
    writer: Arc<Mutex<Writer>>,
    pending: Pending,
    events: mpsc::UnboundedSender<(String, Value)>,
    ready: oneshot::Sender<()>,
) {
    let mut ready = Some(ready);
    loop {
        let mut header = [0u8; 8];
        if reader.read_exact(&mut header).await.is_err() {
            break;
        }
        let opcode = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
        let length = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
        if length > 16 * 1024 * 1024 {
            break;
        }
        let mut body = vec![0u8; length];
        if reader.read_exact(&mut body).await.is_err() {
            break;
        }
        let message: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        match opcode {
            OP_PING => {
                let mut w = writer.lock().await;
                let _ = w.write_all(&encode(OP_PONG, &message)).await;
                continue;
            }
            OP_CLOSE => break,
            OP_FRAME => {}
            _ => continue,
        }
        let evt = message.get("evt").and_then(Value::as_str).unwrap_or("").to_string();
        let cmd = message.get("cmd").and_then(Value::as_str).unwrap_or("");
        if evt == "READY" || (cmd == "DISPATCH" && message.get("data").is_some()) {
            if let Some(tx) = ready.take() {
                let _ = tx.send(());
            }
            if !evt.is_empty() && evt != "READY" {
                let _ = events.send((evt, message.get("data").cloned().unwrap_or(Value::Null)));
            }
            continue;
        }
        let id = message.get("nonce").and_then(Value::as_str).unwrap_or("").to_string();
        if evt == "ERROR" {
            let text = message.pointer("/data/message").and_then(Value::as_str).unwrap_or("Discord RPC error").to_string();
            if let Some(tx) = pending.lock().await.remove(&id) {
                let _ = tx.send(Err(text));
            } else {
                let _ = events.send(("RPC_ERROR".into(), Value::String(text)));
            }
            continue;
        }
        if let Some(tx) = pending.lock().await.remove(&id) {
            let _ = tx.send(Ok(message));
        }
    }
    pending.lock().await.clear();
    let _ = events.send(("CLOSED".into(), Value::Null));
}
