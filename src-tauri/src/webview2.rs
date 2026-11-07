//! The launcher's window is Microsoft Edge WebView2. The installer sets the runtime up, but that
//! can fail (no internet during setup, a broken earlier install that still leaves its registry
//! key, a different Windows account). Without it Tauri only shows "Could not find the WebView2
//! Runtime" and quits, so the launcher checks first and offers to install it.
//!
//! Microsoft's Evergreen bootstrapper picks the right runtime for the system: the current one on
//! Windows 10 and 11, version 109 (the last for them) on Windows 7, 8 and 8.1.

use std::path::Path;
use std::time::Duration;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    MessageBoxW, IDYES, MB_ICONERROR, MB_ICONINFORMATION, MB_OK, MB_SETFOREGROUND, MB_YESNO,
};

const BOOTSTRAPPER_URL: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
const DOWNLOAD_PAGE: &str = "https://developer.microsoft.com/microsoft-edge/webview2";
const TITLE: &str = "Dungeon Blitz: R";

/// True when the runtime is there (or was just installed) and the launcher can open its window.
pub fn ensure() -> bool {
    if tauri::webview_version().is_ok() {
        return true;
    }
    let ask = "Dungeon Blitz: R needs the Microsoft Edge WebView2 Runtime, and it is not installed \
               for this Windows account.\n\nDownload and install it from Microsoft now?";
    if message(ask, MB_YESNO | MB_ICONINFORMATION) != IDYES {
        manual_install(None);
        return false;
    }
    match install() {
        Ok(()) if tauri::webview_version().is_ok() => true,
        Ok(()) => {
            manual_install(Some("The installer finished, but WebView2 is still not available."));
            false
        }
        Err(error) => {
            manual_install(Some(&error));
            false
        }
    }
}

fn install() -> Result<(), String> {
    let path = std::env::temp_dir().join("DungeonBlitzR-MicrosoftEdgeWebview2Setup.exe");
    download(&path)?;
    // Not silent: Microsoft's own progress window shows while it downloads the runtime.
    let status = std::process::Command::new(&path).arg("/install").status();
    let _ = std::fs::remove_file(&path);
    match status {
        Ok(_) => Ok(()),
        Err(error) => Err(format!("The WebView2 installer did not start: {error}")),
    }
}

fn download(path: &Path) -> Result<(), String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    let bytes = runtime.block_on(async {
        let response = reqwest::Client::builder()
            .user_agent(concat!("dungeon-blitz-r-launcher/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|e| e.to_string())?
            .get(BOOTSTRAPPER_URL)
            .send()
            .await
            .map_err(|e| format!("Could not download the WebView2 installer: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("Could not download the WebView2 installer (HTTP {}).", response.status().as_u16()));
        }
        response.bytes().await.map_err(|e| format!("Could not download the WebView2 installer: {e}"))
    })?;
    if !bytes.starts_with(b"MZ") {
        return Err("The WebView2 installer Microsoft sent is not a Windows program.".into());
    }
    std::fs::write(path, &bytes).map_err(|e| format!("Could not save the WebView2 installer: {e}"))
}

fn manual_install(reason: Option<&str>) {
    let mut text = String::new();
    if let Some(reason) = reason {
        text.push_str(reason);
        text.push_str("\n\n");
    }
    text.push_str(&format!(
        "Install the Microsoft Edge WebView2 Runtime (\"Evergreen Bootstrapper\") from\n{DOWNLOAD_PAGE}\nthen start Dungeon Blitz: R again."
    ));
    message(&text, MB_OK | MB_ICONERROR);
}

fn message(text: &str, style: u32) -> i32 {
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (text, title) = (wide(text), wide(TITLE));
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), style | MB_SETFOREGROUND) }
}
