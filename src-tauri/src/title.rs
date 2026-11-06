pub const GAME_TITLE: &str = "Dungeon Blitz: R";

#[cfg(windows)]
pub fn keep_game_title(pid: u32, alive: std::sync::Arc<std::sync::atomic::AtomicBool>) {
    use std::sync::atomic::Ordering;
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, SetWindowTextW,
    };

    unsafe extern "system" fn visit(hwnd: HWND, data: LPARAM) -> BOOL {
        let pid = data as u32;
        let mut owner = 0u32;
        GetWindowThreadProcessId(hwnd, &mut owner);
        if owner == pid && IsWindowVisible(hwnd) != 0 {
            let wanted: Vec<u16> = GAME_TITLE.encode_utf16().chain(std::iter::once(0)).collect();
            let mut current = [0u16; 256];
            let len = GetWindowTextW(hwnd, current.as_mut_ptr(), 256).max(0) as usize;
            if current[..len] != wanted[..wanted.len() - 1] {
                SetWindowTextW(hwnd, wanted.as_ptr());
            }
        }
        1
    }

    std::thread::spawn(move || {
        while alive.load(Ordering::Relaxed) {
            unsafe {
                EnumWindows(Some(visit), pid as LPARAM);
            }
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    });
}

#[cfg(target_os = "linux")]
pub fn keep_game_title(pid: u32, alive: std::sync::Arc<std::sync::atomic::AtomicBool>) {
    use std::process::{Command, Stdio};
    use std::sync::atomic::Ordering;
    let has = Command::new("xdotool").arg("version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok();
    if !has {
        return;
    }
    std::thread::spawn(move || {
        while alive.load(Ordering::Relaxed) {
            let _ = Command::new("sh")
                .args([
                    "-c",
                    r#"for w in $(xdotool search --pid "$0" 2>/dev/null); do xdotool set_window --name "$1" "$w"; done"#,
                    &pid.to_string(),
                    GAME_TITLE,
                ])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    });
}

#[cfg(target_os = "macos")]
pub fn keep_game_title(_pid: u32, _alive: std::sync::Arc<std::sync::atomic::AtomicBool>) {}
