#[cfg(windows)]
pub fn boost(pid: u32) {
    use std::os::windows::process::CommandExt;
    if std::env::var("DB_FLASH_TIMER").as_deref() != Ok("1") || pid == 0 {
        return;
    }
    std::thread::spawn(move || {
        let result = (|| -> Result<String, String> {
            let dir = std::env::temp_dir().join(format!("dungeon-blitz-timer-{}", rand::random::<u32>()));
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let script = dir.join("timer.ps1");
            std::fs::write(&script, include_str!("flash_timer.ps1")).map_err(|e| e.to_string())?;
            let root = std::env::var("SystemRoot").or_else(|_| std::env::var("windir")).unwrap_or_else(|_| "C:\\Windows".into());
            let wow64 = std::path::Path::new(&root).join("SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe");
            let shell = if wow64.exists() { wow64 } else { std::path::Path::new(&root).join("System32\\WindowsPowerShell\\v1.0\\powershell.exe") };
            let output = std::process::Command::new(shell)
                .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
                .arg(&script)
                .args([pid.to_string(), "1".into()])
                .stdin(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .creation_flags(0x0800_0000)
                .output()
                .map_err(|e| e.to_string());
            let _ = std::fs::remove_dir_all(&dir);
            let text = String::from_utf8_lossy(&output?.stdout).trim().to_string();
            Ok(if text.is_empty() { "failed: no answer from PowerShell".into() } else { text })
        })();
        println!("[Flash] Timer resolution: {}", result.unwrap_or_else(|e| format!("failed: {e}")));
    });
}

#[cfg(not(windows))]
pub fn boost(_pid: u32) {}
