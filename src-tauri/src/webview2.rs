//! The launcher's window is Microsoft Edge WebView2. The installer sets the runtime up, but that
//! can fail (no internet during setup, a broken earlier install that still leaves its registry
//! key, a different Windows account). Without it Tauri only shows "Could not find the WebView2
//! Runtime" and quits, so the launcher checks first and offers to install it.
//!
//! Windows 10 and 11 get Microsoft's Evergreen bootstrapper, which installs the current runtime.
//!
//! Windows 7, 8 and 8.1 stopped at runtime 109. The bootstrapper is supposed to install 109 there,
//! but it hands the work to Microsoft Edge Update, which on a Windows 7 without the SHA-2 and
//! TLS 1.2 updates (KB4474419, KB4490628, KB3140245) exits without installing anything: players
//! saw "The installer finished, but WebView2 is still not available." So the Windows 7 build
//! downloads the 109 installer itself (Microsoft's own `MicrosoftEdge_X86/X64_109.0.1518.140.exe`
//! from Microsoft's download service, checked against the SHA-256 below) and runs it with
//! `--msedgewebview`, which installs only the WebView2 runtime, for this Windows account, with no
//! Edge Update and no administrator prompt. The bootstrapper stays as the fallback.
//!
//! Microsoft's download service (`msedge.api.cdp.microsoft.com`) has a certificate from the
//! Windows Update PKI, which chains to "Microsoft Root Certificate Authority 2011". That root is
//! only in Windows' own store, not in the Mozilla list (webpki-roots) the launcher's TLS uses, so
//! without it every request failed with "invalid peer certificate: UnknownIssuer". The root ships
//! in `certs/` and is trusted for that one request; the installer itself comes over plain HTTP
//! from Microsoft's CDN and is checked against its SHA-256.

use std::path::Path;
use std::time::Duration;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    MessageBoxW, IDYES, MB_ICONERROR, MB_ICONINFORMATION, MB_OK, MB_SETFOREGROUND, MB_YESNO,
};

const BOOTSTRAPPER_URL: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
const DOWNLOAD_PAGE: &str = "https://developer.microsoft.com/microsoft-edge/webview2";
const TITLE: &str = "Dungeon Blitz: R";

/// The last WebView2 runtime for Windows 7, 8 and 8.1.
const LEGACY_VERSION: &str = "109.0.1518.140";

/// "Microsoft Root Certificate Authority 2011" (DER, valid until 2036-03-22, SHA-256
/// 847DF6A78497943F27FC72EB93F9A637320A02B561D0A91B09E87A7807ED7C61), the root of the
/// download service's certificate. See the module notes.
const MICROSOFT_ROOT_2011: &[u8] = include_bytes!("../certs/MicrosoftRootCertificateAuthority2011.cer");

/// (download-service name, installer file, SHA-256 in base64) for the launcher's architecture.
/// The runtime matches the launcher: the ia32 launcher gets the x86 runtime, the x64 one x64.
#[cfg(target_arch = "x86")]
const LEGACY: (&str, &str, &str) = (
    "msedgewebview-stable-win7and8-x86",
    "MicrosoftEdge_X86_109.0.1518.140.exe",
    "K0jOOzBLe5qPk3ekLYZh7NxTxfLG7nCNqdYhJ8eALBg=",
);
#[cfg(not(target_arch = "x86"))]
const LEGACY: (&str, &str, &str) = (
    "msedgewebview-stable-win7and8-x64",
    "MicrosoftEdge_X64_109.0.1518.140.exe",
    "cNSWhzoKHKFK4KA40lhWshIbG0t7rZgBzmObFEusQfg=",
);

/// True when the runtime is there (or was just installed) and the launcher can open its window.
pub fn ensure() -> bool {
    if tauri::webview_version().is_ok() {
        return true;
    }
    let legacy = cfg!(feature = "win7");
    let ask = if legacy {
        "Dungeon Blitz: R needs the Microsoft Edge WebView2 Runtime, and it is not installed \
         for this Windows account.\n\nDownload it from Microsoft and install it now? It is about \
         130 MB. Nothing shows while it downloads; a message appears when it is done."
    } else {
        "Dungeon Blitz: R needs the Microsoft Edge WebView2 Runtime, and it is not installed \
         for this Windows account.\n\nDownload and install it from Microsoft now?"
    };
    if message(ask, MB_YESNO | MB_ICONINFORMATION) != IDYES {
        manual_install(None);
        return false;
    }
    let mut problems = Vec::new();
    if legacy {
        let result = install_legacy();
        if tauri::webview_version().is_ok() {
            return true;
        }
        problems.push(result.err().unwrap_or_else(|| {
            format!("WebView2 {LEGACY_VERSION} installed, but Windows does not report it yet.")
        }));
    }
    match install_bootstrapper() {
        Ok(()) if tauri::webview_version().is_ok() => return true,
        Ok(()) => problems.push("The installer finished, but WebView2 is still not available.".into()),
        Err(error) => problems.push(error),
    }
    manual_install(Some(&problems.join("\n")));
    false
}

fn install_bootstrapper() -> Result<(), String> {
    let path = std::env::temp_dir().join("DungeonBlitzR-MicrosoftEdgeWebview2Setup.exe");
    let bytes = runtime()?.block_on(async {
        let response = http(Duration::from_secs(120))?
            .get(BOOTSTRAPPER_URL)
            .send()
            .await
            .map_err(|e| format!("Could not download the WebView2 installer: {}", chain(&e)))?;
        if !response.status().is_success() {
            return Err(format!("Could not download the WebView2 installer (HTTP {}).", response.status().as_u16()));
        }
        response.bytes().await.map_err(|e| format!("Could not download the WebView2 installer: {}", chain(&e)))
    })?;
    if !bytes.starts_with(b"MZ") {
        return Err("The WebView2 installer Microsoft sent is not a Windows program.".into());
    }
    std::fs::write(&path, &bytes).map_err(|e| format!("Could not save the WebView2 installer: {e}"))?;
    // Not silent: Microsoft's own progress window shows while it downloads the runtime.
    let status = std::process::Command::new(&path).arg("/install").status();
    let _ = std::fs::remove_file(&path);
    match status {
        Ok(_) => Ok(()),
        Err(error) => Err(format!("The WebView2 installer did not start: {error}")),
    }
}

/// Downloads Microsoft's WebView2 109 installer and installs the runtime for this account.
fn install_legacy() -> Result<(), String> {
    let (name, file, sha256) = LEGACY;
    let path = std::env::temp_dir().join(format!("DungeonBlitzR-{file}"));
    let downloaded = runtime()?.block_on(download_legacy(name, file, sha256, &path));
    if let Err(error) = downloaded {
        let _ = std::fs::remove_file(&path);
        return Err(error);
    }
    let status = std::process::Command::new(&path).arg("--msedgewebview").status();
    let _ = std::fs::remove_file(&path);
    match status {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!(
            "The WebView2 {LEGACY_VERSION} installer stopped with code {}.",
            status.code().map_or_else(|| "?".to_string(), |c| format!("{c} (0x{:08X})", c as u32))
        )),
        Err(error) => Err(format!("The WebView2 {LEGACY_VERSION} installer did not start: {error}")),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "PascalCase")]
struct DownloadInfo {
    url: String,
    file_id: String,
}

async fn download_legacy(name: &str, file: &str, sha256: &str, path: &Path) -> Result<(), String> {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    use std::io::Write;

    let failed = |e: &dyn std::fmt::Display| format!("Could not download WebView2 {LEGACY_VERSION} from Microsoft: {e}");
    // Microsoft's download service hands out a short-lived link for each file of a version.
    let api = format!(
        "https://msedge.api.cdp.microsoft.com/api/v1.1/internal/contents/Browser/namespaces/Default/names/{name}/versions/{LEGACY_VERSION}/files?action=GenerateDownloadInfo&foregroundPriority=true"
    );
    let root = reqwest::Certificate::from_der(MICROSOFT_ROOT_2011).map_err(|e| failed(&chain(&e)))?;
    let client = reqwest::Client::builder()
        .user_agent(concat!("dungeon-blitz-r-launcher/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(60))
        .add_root_certificate(root)
        .build()
        .map_err(|e| failed(&chain(&e)))?;
    let files: Vec<DownloadInfo> = client
        .post(&api)
        .json(&serde_json::json!({}))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| failed(&chain(&e)))?
        .json()
        .await
        .map_err(|e| failed(&chain(&e)))?;
    let url = files
        .into_iter()
        .find(|f| f.file_id == file)
        .map(|f| f.url)
        .ok_or_else(|| failed(&format!("{file} is not offered any more")))?;

    // ~130 MB: streamed to disk, no overall time limit, only a limit per read.
    let mut response = reqwest::Client::builder()
        .user_agent(concat!("dungeon-blitz-r-launcher/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?
        .get(&url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| failed(&chain(&e)))?;
    let mut out = std::fs::File::create(path).map_err(|e| format!("Could not save the WebView2 installer: {e}"))?;
    let mut hasher = Sha256::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| failed(&chain(&e)))? {
        hasher.update(&chunk);
        out.write_all(&chunk).map_err(|e| format!("Could not save the WebView2 installer: {e}"))?;
    }
    drop(out);
    if base64::engine::general_purpose::STANDARD.encode(hasher.finalize()) != sha256 {
        return Err(format!("The WebView2 {LEGACY_VERSION} installer did not download correctly (checksum mismatch). Try again."));
    }
    Ok(())
}

/// The error and every cause under it. reqwest's own message is only "error sending request
/// for url (...)"; the reason (a certificate, DNS, a refused connection) is in the sources.
fn chain(error: &dyn std::error::Error) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

fn runtime() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|e| e.to_string())
}

fn http(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("dungeon-blitz-r-launcher/", env!("CARGO_PKG_VERSION")))
        .timeout(timeout)
        .build()
        .map_err(|e| e.to_string())
}

fn manual_install(reason: Option<&str>) {
    let mut text = String::new();
    if let Some(reason) = reason {
        text.push_str(reason);
        text.push_str("\n\n");
    }
    if cfg!(feature = "win7") {
        text.push_str(
            "Start Dungeon Blitz: R again to retry. If it still fails, run Windows Update until it \
             finds nothing more (KB4474419 and KB4490628 are the ones WebView2 needs), restart the \
             computer, and try again, or ask for help in our Discord.",
        );
    } else {
        text.push_str(&format!(
            "Install the Microsoft Edge WebView2 Runtime (\"Evergreen Bootstrapper\") from\n{DOWNLOAD_PAGE}\nthen start Dungeon Blitz: R again."
        ));
    }
    message(&text, MB_OK | MB_ICONERROR);
}

fn message(text: &str, style: u32) -> i32 {
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (text, title) = (wide(text), wide(TITLE));
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), style | MB_SETFOREGROUND) }
}
