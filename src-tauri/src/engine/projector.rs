use regex::Regex;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use url::Url;

use super::{binary, integrity, loader_swf, Launch};
use crate::config::{env_is, Paths, ARCH, PLATFORM};

const DEFAULT_SWF_PATH: &str = "/p/cbp/DungeonBlitz.swf?fv=cbp&gv=cbp";
pub const MAC_TITLE_FILE: &str = "Dungeon Blitz: R";
pub const WINDOWS_LOADER_FILE: &str = "dungeon-blitz.swf";

#[derive(Clone, Debug)]
pub struct Projector {
    pub path: PathBuf,
    pub executable: PathBuf,
    pub version: String,
    pub source: String,
    pub architectures: Vec<String>,
    pub arch_mismatch: bool,
    pub tampered: bool,
    pub tamper_reason: String,
}

fn name_matches(name: &str) -> bool {
    let pattern = match PLATFORM {
        "win32" => r"(?i)^flashplayer.*\.exe$",
        "darwin" => r"(?i)^Flash Player.*\.app$",
        _ => r"(?i)^flashplayer(debugger)?$",
    };
    Regex::new(pattern).map(|r| r.is_match(name)).unwrap_or(false)
}

fn is_projector(candidate: &Path) -> bool {
    let name = candidate.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !name_matches(&name) {
        return false;
    }
    if PLATFORM == "darwin" { candidate.is_dir() } else { candidate.is_file() }
}

pub fn is_chosen_projector(candidate: &Path) -> bool {
    if is_projector(candidate) {
        return true;
    }
    let lower = candidate.to_string_lossy().to_lowercase();
    match PLATFORM {
        "win32" => lower.ends_with(".exe") && candidate.is_file(),
        "darwin" => lower.ends_with(".app") && candidate.is_dir(),
        _ => {
            let library = Regex::new(r"\.so(\.\d+)*$").unwrap().is_match(&lower);
            if library || !candidate.is_file() {
                return false;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::metadata(candidate).map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
            }
            #[cfg(not(unix))]
            {
                true
            }
        }
    }
}

pub fn projector_in_directory(directory: &Path) -> Option<PathBuf> {
    let mut entries: Vec<String> =
        fs::read_dir(directory).ok()?.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    entries.sort();
    entries.sort_by_key(|e| e.to_lowercase().contains("debug"));
    entries.into_iter().map(|e| directory.join(e)).find(|c| is_projector(c))
}

fn search_directories(paths: &Paths, extra: &[PathBuf]) -> Vec<PathBuf> {
    let mut dirs = vec![paths.vendor("projector")];
    dirs.extend_from_slice(extra);
    let home = dirs::home_dir().unwrap_or_default();
    match PLATFORM {
        "win32" => {
            let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into());
            let pf86 = std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| r"C:\Program Files (x86)".into());
            dirs.push(PathBuf::from(pf).join("Adobe").join("Flash Player"));
            dirs.push(PathBuf::from(pf86).join("Adobe").join("Flash Player"));
            dirs.push(home.join("Downloads"));
        }
        "darwin" => {
            dirs.push("/Applications".into());
            dirs.push(home.join("Applications"));
            dirs.push(home.join("Downloads"));
        }
        _ => {
            for d in ["/usr/local/bin", "/usr/bin", "/opt/flashplayer"] {
                dirs.push(d.into());
            }
            dirs.push(home.join(".local").join("bin"));
        }
    }
    dirs
}

pub fn can_execute(architectures: &[String]) -> bool {
    if architectures.is_empty() || architectures.iter().any(|a| a == ARCH) {
        return true;
    }
    let has = |a: &str| architectures.iter().any(|x| x == a);
    match PLATFORM {
        "win32" => has("ia32") || (has("x64") && ARCH == "arm64"),
        "darwin" => has("x64") && ARCH == "arm64",
        _ => false,
    }
}

fn detect_version(path: &Path) -> String {
    match PLATFORM {
        "darwin" => binary::version_from_mac_bundle(path),
        "win32" => binary::version_from_windows_metadata(path),
        _ => {
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            Regex::new(r"(\d+)[._](\d+)[._](\d+)[._](\d+)")
                .unwrap()
                .captures(&name)
                .map(|c| format!("{}.{}.{}.{}", &c[1], &c[2], &c[3], &c[4]))
                .unwrap_or_default()
        }
    }
}

fn describe(path: PathBuf, source: &str) -> Projector {
    let executable = if PLATFORM == "darwin" { binary::mac_bundle_executable(&path) } else { path.clone() };
    let architectures = if executable.as_os_str().is_empty() { vec![] } else { binary::architectures(&executable) };
    Projector {
        version: detect_version(&path),
        arch_mismatch: !can_execute(&architectures),
        path,
        executable,
        source: source.into(),
        architectures,
        tampered: false,
        tamper_reason: String::new(),
    }
}

pub fn find_vendored(paths: &Paths) -> Option<PathBuf> {
    projector_in_directory(&paths.vendor("projector"))
}

pub fn find(paths: &Paths, preferred: &str, vendor_only: bool) -> Option<Projector> {
    if vendor_only {
        return find_vendored(paths).map(|p| describe(p, "vendor"));
    }
    let preferred = preferred.trim();
    if !preferred.is_empty() {
        let candidate = PathBuf::from(preferred);
        if is_chosen_projector(&candidate) {
            return Some(describe(candidate, "manual"));
        }
        if let Some(found) = projector_in_directory(&candidate) {
            return Some(describe(found, "manual"));
        }
    }
    let vendor = paths.vendor("projector");
    let extra = [paths.resource_root.join("projector")];
    for directory in search_directories(paths, &extra) {
        if let Some(candidate) = projector_in_directory(&directory) {
            return Some(describe(candidate, if directory == vendor { "vendor" } else { "auto" }));
        }
    }
    None
}

pub fn verify(path: &Path) -> integrity::Verdict {
    integrity::verify_tree(path, integrity::PROJECTOR_RECORD, "Flash Player")
}

pub fn swf_url_from_page(html: &str, page_url: &str) -> String {
    let pattern = Regex::new(r#"["'`]((?:https?://[^"'`\s]+)?/[^"'`\s]*DungeonBlitz\.swf[^"'`\s]*)["'`]"#).unwrap();
    let Some(found) = pattern.captures(html) else { return String::new() };
    let cleaned = Regex::new(r"\$\{[^}]*\}").unwrap().replace_all(&found[1], "").into_owned();
    Url::parse(page_url).and_then(|b| b.join(&cleaned)).map(|u| u.to_string()).unwrap_or_default()
}

pub fn default_swf_url(page_url: &str) -> String {
    Url::parse(page_url).and_then(|b| b.join(DEFAULT_SWF_PATH)).map(|u| u.to_string()).unwrap_or_default()
}

pub async fn resolve_swf_url(server_url: &str) -> String {
    let html = crate::net::get_text(server_url, Duration::from_secs(8), 512 * 1024).await;
    let found = swf_url_from_page(&html, server_url);
    if found.is_empty() { default_swf_url(server_url) } else { found }
}

pub fn flash_render_mode() -> String {
    let mode = std::env::var("DB_FLASH_RENDER").unwrap_or_default().trim().to_lowercase();
    match mode.as_str() {
        "direct" | "gpu" => mode,
        "software" => String::new(),
        _ if PLATFORM == "win32" => "direct".into(),
        _ => String::new(),
    }
}

#[derive(Clone, Debug)]
pub struct Preload {
    pub directory: PathBuf,
    pub libraries: Vec<String>,
}

pub fn find_flash_preload(paths: &Paths) -> Option<Preload> {
    let directory = paths.resource_root.join("vendor").join("flashpreload").join("linux");
    let mut libraries: Vec<String> = fs::read_dir(&directory)
        .ok()?
        .flatten()
        .filter(|e| e.path().is_file())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".so"))
        .collect();
    libraries.sort();
    if libraries.is_empty() { None } else { Some(Preload { directory, libraries }) }
}

pub fn verify_flash_preload(directory: &Path) -> integrity::Verdict {
    integrity::verify_tree(directory, integrity::PRELOAD_RECORD, "Flash Player preload")
}

pub fn linux_env(preload: Option<&Preload>) -> Vec<(String, String)> {
    let mut env = Vec::new();
    if !env_is("DUNGEON_BLITZ_FLASH_VDPAU", "1") {
        env.push(("VDPAU_DRIVER".into(), "none".into()));
    }
    let Some(preload) = preload else { return env };
    if preload.libraries.is_empty() || env_is("DUNGEON_BLITZ_FLASH_PRELOAD", "0") {
        return env;
    }
    let directory = preload.directory.to_string_lossy().into_owned();
    if directory.contains(':') {
        return env;
    }
    let join = |first: Vec<String>, sep: &str| first.into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(sep);
    let library_path = join(vec![directory, std::env::var("LD_LIBRARY_PATH").unwrap_or_default()], ":");
    let mut preloads = vec![std::env::var("LD_PRELOAD").unwrap_or_default()];
    preloads.extend(preload.libraries.iter().cloned());
    env.push(("LD_LIBRARY_PATH".into(), library_path));
    env.push(("LD_PRELOAD".into(), join(preloads, " ")));
    env
}

pub fn prepare_launch(
    projector: &Projector,
    swf_url: &str,
    work_dir: &Path,
    preload: Option<&Preload>,
    render: &str,
    quality: &str,
) -> Result<Launch, String> {
    let command = if projector.executable.as_os_str().is_empty() { projector.path.clone() } else { projector.executable.clone() };
    let write_loader = |name: &str| -> Result<PathBuf, String> {
        fs::create_dir_all(work_dir).map_err(|e| e.to_string())?;
        let loader = work_dir.join(name);
        fs::write(&loader, loader_swf::build(swf_url, render, quality)?).map_err(|e| e.to_string())?;
        Ok(loader)
    };
    match PLATFORM {
        "linux" => Ok(Launch { command, args: vec![swf_url.into()], cwd: None, env: linux_env(preload) }),
        "win32" if !render.is_empty() || !quality.is_empty() => {
            let loader = write_loader(WINDOWS_LOADER_FILE)?;
            Ok(Launch { command, args: vec![loader.to_string_lossy().into_owned()], cwd: Some(work_dir.into()), env: vec![] })
        }
        "darwin" => {
            write_loader(MAC_TITLE_FILE)?;
            Ok(Launch { command, args: vec![MAC_TITLE_FILE.into()], cwd: Some(work_dir.into()), env: vec![] })
        }
        _ => Ok(Launch { command, args: vec![swf_url.into()], cwd: None, env: vec![] }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_swf_from_page() {
        let html = r#"<script>const swf = `/p/cbp/DungeonBlitz.swf?fv=cbp&gv=cbp&clientrev=42${languageParam}`;</script>"#;
        assert_eq!(
            swf_url_from_page(html, "http://dungeonblitzr.theminesa.studio/"),
            "http://dungeonblitzr.theminesa.studio/p/cbp/DungeonBlitz.swf?fv=cbp&gv=cbp&clientrev=42"
        );
        assert_eq!(
            default_swf_url("http://dungeonblitzr.theminesa.studio/"),
            "http://dungeonblitzr.theminesa.studio/p/cbp/DungeonBlitz.swf?fv=cbp&gv=cbp"
        );
    }
}
