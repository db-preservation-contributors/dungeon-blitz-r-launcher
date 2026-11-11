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

/// What apprun-hooks/linuxdeploy-plugin-gtk.sh sets when the launcher runs from its AppImage.
const APPIMAGE_GTK_ENV: [&str; 9] = [
    "GTK_DATA_PREFIX",
    "GTK_THEME",
    "GSETTINGS_SCHEMA_DIR",
    "GI_TYPELIB_PATH",
    "GIO_MODULE_DIR",
    "GTK_EXE_PREFIX",
    "GTK_PATH",
    "GTK_IM_MODULE_FILE",
    "GDK_PIXBUF_MODULE_FILE",
];

/// Changes to a game's environment when the launcher runs from its AppImage (`None` removes the
/// variable). The AppImage's GTK hook points GTK at the GTK 3 files inside the AppImage, and
/// the launcher's children inherit that. Flash Player is a GTK 2 program on the host's own
/// libraries: GTK 3 input modules from GTK_IM_MODULE_FILE in a GTK 2 process make it abort.
pub fn appimage_env(get: impl Fn(&str) -> Option<String>) -> Vec<(String, Option<String>)> {
    let Some(appdir) = get("APPDIR").filter(|d| PLATFORM == "linux" && !d.is_empty()) else { return vec![] };
    let mut changes: Vec<(String, Option<String>)> = APPIMAGE_GTK_ENV.iter().map(|k| (k.to_string(), None)).collect();
    if let Some(dirs) = get("XDG_DATA_DIRS") {
        let host = dirs.split(':').filter(|d| !d.is_empty() && !d.starts_with(&appdir)).collect::<Vec<_>>().join(":");
        changes.push(("XDG_DATA_DIRS".into(), Some(host).filter(|h| !h.is_empty())));
    }
    changes
}

/// What a Wayland session says when Flash Player cannot have an X display.
pub const NO_X_DISPLAY: &str = "Flash Player needs an X11 display, and this session has none. \
On Wayland, turn on XWayland (Hyprland: xwayland { enabled = true }, which is the default) \
and start the launcher again from your desktop session.";

/// The X display Flash Player should use. Flash Player is a GTK 2 program: it only draws on
/// X11, and without a display it prints "cannot open display" and exits with status 1 at once.
/// On a Wayland desktop that display is XWayland's. A launcher started from the session gets
/// it in DISPLAY; one started some other way (a D-Bus activated app menu, a systemd user
/// service, a file manager outside the session) can be missing it while XWayland is running.
/// Then the display is the lowest X socket in `socket_dir` (/tmp/.X11-unix) that belongs to
/// `uid`, which is the one XWayland made for this user.
///
/// `Ok(None)`: DISPLAY is set, keep it. `Ok(Some(d))`: start Flash Player with DISPLAY=d.
/// `Err(())`: there is no X display to give it.
pub fn x11_display(display: Option<String>, socket_dir: &Path, uid: Option<u32>) -> Result<Option<String>, ()> {
    if display.map(|d| !d.trim().is_empty()).unwrap_or(false) {
        return Ok(None);
    }
    let mut numbers: Vec<u32> = fs::read_dir(socket_dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| owned_by(&e.path(), uid))
                .filter_map(|e| e.file_name().to_str()?.strip_prefix('X')?.parse().ok())
                .collect()
        })
        .unwrap_or_default();
    numbers.sort_unstable();
    numbers.first().map(|n| Some(format!(":{n}"))).ok_or(())
}

/// This process's user id, as the owner of /proc/self (Linux has no other way without libc).
#[cfg(unix)]
pub fn own_uid() -> Option<u32> {
    use std::os::unix::fs::MetadataExt;
    fs::metadata("/proc/self").ok().map(|m| m.uid())
}

#[cfg(not(unix))]
pub fn own_uid() -> Option<u32> {
    None
}

#[cfg(unix)]
fn owned_by(path: &Path, uid: Option<u32>) -> bool {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    let Ok(meta) = fs::symlink_metadata(path) else { return false };
    meta.file_type().is_socket() && uid.map(|u| meta.uid() == u).unwrap_or(true)
}

#[cfg(not(unix))]
fn owned_by(_path: &Path, _uid: Option<u32>) -> bool {
    false
}

/// What the launcher says when the game closes right after it started with a failing status.
/// `output` is the last lines the game wrote to stderr.
pub fn early_exit_message(label: &str, status: &str, output: &[String]) -> String {
    let said = |needle: &str| output.iter().find(|l| l.contains(needle));
    if said("cannot open display").is_some() {
        return NO_X_DISPLAY.into();
    }
    if let Some(line) = said("error while loading shared libraries") {
        let library = line.split("shared libraries: ").nth(1).and_then(|r| r.split(':').next()).unwrap_or("").trim();
        let gtk2 = if library.contains("gtk-x11-2.0") || library.contains("gdk-x11-2.0") {
            " It is part of GTK 2: install your distribution's gtk2 package (Arch: gtk2, Debian and Ubuntu: libgtk2.0-0)."
        } else {
            ""
        };
        return format!("{label} needs {library}, which is not installed on this system.{gtk2}");
    }
    match output.iter().rev().find(|l| !l.trim().is_empty()) {
        Some(last) => format!("{label} closed as soon as it started ({status}): {}", last.trim()),
        None => format!("{label} closed as soon as it started ({status})."),
    }
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

    #[cfg(unix)]
    #[test]
    fn finds_xwayland_display_when_display_is_missing() {
        use std::os::unix::net::UnixListener;
        let dir = std::env::temp_dir().join(format!("db-x11-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        assert_eq!(x11_display(Some(":0".into()), &dir, None), Ok(None));
        assert_eq!(x11_display(None, &dir, None), Err(()));
        assert_eq!(x11_display(Some(" ".into()), &dir.join("missing"), None), Err(()));

        fs::write(dir.join("X0"), b"").unwrap(); // not a socket
        let _two = UnixListener::bind(dir.join("X2")).unwrap();
        let _one = UnixListener::bind(dir.join("X1")).unwrap();
        assert_eq!(x11_display(None, &dir, None), Ok(Some(":1".into())));
        assert_eq!(x11_display(Some(String::new()), &dir, None), Ok(Some(":1".into())));
        let me = own_uid().expect("/proc/self has an owner");
        assert_eq!(x11_display(None, &dir, Some(me)), Ok(Some(":1".into())));
        assert_eq!(x11_display(None, &dir, Some(me.wrapping_add(1))), Err(()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn early_exit_names_the_reason() {
        let lines = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let display = lines(&["", "(flashplayer:1245): Gtk-WARNING **: 05:56:11.166: cannot open display: "]);
        assert_eq!(early_exit_message("Flash Player", "exit status: 1", &display), NO_X_DISPLAY);

        let gtk = lines(&["/opt/flashplayer: error while loading shared libraries: libgtk-x11-2.0.so.0: cannot open shared object file: No such file or directory"]);
        let said = early_exit_message("Flash Player", "exit status: 127", &gtk);
        assert!(said.starts_with("Flash Player needs libgtk-x11-2.0.so.0, which is not installed"), "{said}");
        assert!(said.contains("Arch: gtk2"), "{said}");

        let other = lines(&["first", "Error: Invalid SWF file name", ""]);
        assert_eq!(
            early_exit_message("Flash Player", "exit status: 255", &other),
            "Flash Player closed as soon as it started (exit status: 255): Error: Invalid SWF file name"
        );
        assert_eq!(early_exit_message("AIR", "exit status: 1", &[]), "AIR closed as soon as it started (exit status: 1).");
    }

    #[test]
    fn appimage_gtk_env_is_not_passed_to_flash_player() {
        let outside = |k: &str| (k == "XDG_DATA_DIRS").then(|| "/usr/share".to_string());
        assert!(appimage_env(outside).is_empty());

        let appimage = |k: &str| match k {
            "APPDIR" => Some("/tmp/.mount_Dungeon".to_string()),
            "XDG_DATA_DIRS" => Some("/tmp/.mount_Dungeon/usr/share:/usr/share:/usr/local/share".to_string()),
            "GTK_IM_MODULE_FILE" => Some("/tmp/.mount_Dungeon//usr/lib/gtk-3.0/3.0.0/immodules.cache".to_string()),
            _ => None,
        };
        let changes = appimage_env(appimage);
        if PLATFORM != "linux" {
            assert!(changes.is_empty());
            return;
        }
        assert!(changes.contains(&("GTK_IM_MODULE_FILE".into(), None)));
        assert!(changes.contains(&("GTK_PATH".into(), None)));
        assert!(changes.contains(&("XDG_DATA_DIRS".into(), Some("/usr/share:/usr/local/share".into()))));
    }
}
