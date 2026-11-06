use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

fn read_header(path: &Path, bytes: usize) -> Option<Vec<u8>> {
    let mut file = fs::File::open(path).ok()?;
    let mut buffer = vec![0u8; bytes];
    let mut read = 0;
    while read < bytes {
        match file.read(&mut buffer[read..]) {
            Ok(0) => break,
            Ok(n) => read += n,
            Err(_) => return None,
        }
    }
    buffer.truncate(read);
    Some(buffer)
}

fn u16le(b: &[u8], o: usize) -> Option<u16> {
    b.get(o..o + 2).map(|s| u16::from_le_bytes([s[0], s[1]]))
}
fn u32le(b: &[u8], o: usize) -> Option<u32> {
    b.get(o..o + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}
fn u32be(b: &[u8], o: usize) -> Option<u32> {
    b.get(o..o + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

fn mach_cpu(value: u32) -> Option<&'static str> {
    match value {
        0x0000_0007 => Some("ia32"),
        0x0100_0007 => Some("x64"),
        0x0100_000c => Some("arm64"),
        _ => None,
    }
}

fn macho(h: &[u8]) -> Vec<String> {
    let Some(magic) = u32le(h, 0) else { return vec![] };
    if magic == 0xfeed_facf {
        return u32le(h, 4).and_then(mach_cpu).map(|a| vec![a.to_string()]).unwrap_or_default();
    }
    if magic != 0xbeba_feca && magic != 0xbfba_feca {
        return vec![];
    }
    let entry = if magic == 0xbfba_feca { 32 } else { 20 };
    let count = u32be(h, 4).unwrap_or(0) as usize;
    let mut out: Vec<String> = Vec::new();
    for i in 0..count.min(64) {
        let Some(cpu) = u32be(h, 8 + i * entry) else { break };
        if let Some(arch) = mach_cpu(cpu) {
            if !out.iter().any(|a| a == arch) {
                out.push(arch.to_string());
            }
        }
    }
    out
}

fn pe(h: &[u8]) -> Vec<String> {
    if h.len() < 0x40 || &h[0..2] != b"MZ" {
        return vec![];
    }
    let Some(offset) = u32le(h, 0x3c).map(|v| v as usize) else { return vec![] };
    if h.get(offset..offset + 4) != Some(b"PE\0\0") {
        return vec![];
    }
    match u16le(h, offset + 4) {
        Some(0x014c) => vec!["ia32".into()],
        Some(0x8664) => vec!["x64".into()],
        Some(0xaa64) => vec!["arm64".into()],
        _ => vec![],
    }
}

fn elf(h: &[u8]) -> Vec<String> {
    if h.len() < 20 || &h[0..4] != b"\x7fELF" {
        return vec![];
    }
    match u16le(h, 18) {
        Some(0x0003) => vec!["ia32".into()],
        Some(0x003e) => vec!["x64".into()],
        Some(0x00b7) => vec!["arm64".into()],
        _ => vec![],
    }
}

pub fn architectures(path: &Path) -> Vec<String> {
    let Some(header) = read_header(path, 4096) else { return vec![] };
    for reader in [macho, pe, elf] {
        let found = reader(&header);
        if !found.is_empty() {
            return found;
        }
    }
    vec![]
}

fn plist_value(bundle: &Path, key: &str) -> Option<String> {
    let text = fs::read_to_string(bundle.join("Contents").join("Info.plist")).ok()?;
    let pattern = regex::Regex::new(&format!(r"<key>{key}</key>\s*<string>([^<]*)</string>")).ok()?;
    pattern.captures(&text).map(|c| c[1].trim().to_string())
}

pub fn version_from_mac_bundle(bundle: &Path) -> String {
    plist_value(bundle, "CFBundleVersion").unwrap_or_default()
}

pub fn mac_bundle_executable(bundle: &Path) -> PathBuf {
    if !bundle.is_dir() {
        return bundle.to_path_buf();
    }
    let macos = bundle.join("Contents").join("MacOS");
    if let Some(named) = plist_value(bundle, "CFBundleExecutable") {
        let candidate = macos.join(named);
        if candidate.is_file() {
            return candidate;
        }
    }
    fs::read_dir(&macos)
        .ok()
        .and_then(|entries| entries.flatten().map(|e| e.path()).find(|p| p.is_file()))
        .unwrap_or_default()
}

#[cfg(windows)]
pub fn version_from_windows_metadata(path: &Path) -> String {
    use std::os::windows::process::CommandExt;
    let script = format!("(Get-Item -LiteralPath '{}').VersionInfo.FileVersion", path.display().to_string().replace('\'', "''"));
    std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(0x0800_0000)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().replace(", ", ".").replace(',', "."))
        .unwrap_or_default()
}

#[cfg(not(windows))]
pub fn version_from_windows_metadata(_path: &Path) -> String {
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_own_binary() {
        let exe = std::env::current_exe().unwrap();
        let found = architectures(&exe);
        assert_eq!(found, vec![crate::config::ARCH.to_string()]);
    }
}
