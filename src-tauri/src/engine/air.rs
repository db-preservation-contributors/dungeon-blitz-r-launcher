use std::path::{Path, PathBuf};

use super::{binary, integrity, Launch};
use crate::config::{Paths, PLATFORM};

pub const BUNDLE_NAME: &str = "DungeonBlitzR";

/// The Wine build the Linux launcher carries (tools/build-wine.js): vendor/wine/linux/wine.
pub const WINE_DIR: &str = "wine";

#[derive(Clone, Debug)]
pub struct AirApp {
    pub path: PathBuf,
    pub executable: PathBuf,
    /// Linux: the Wine the Windows bundle runs in. HARMAN's Linux AIR runtime needs a
    /// commercial licence, so Linux plays the Windows AIR bundle in a Wine built from WineHQ's
    /// source and shipped beside it.
    pub wine: Option<PathBuf>,
    pub tampered: bool,
    pub tamper_reason: String,
}

fn in_directory(directory: &Path, platform: &str) -> Option<AirApp> {
    let app = |path: PathBuf, executable: PathBuf| AirApp { path, executable, wine: None, tampered: false, tamper_reason: String::new() };
    if platform == "darwin" {
        let bundle = directory.join(format!("{BUNDLE_NAME}.app"));
        if !bundle.exists() {
            return None;
        }
        let executable = binary::mac_bundle_executable(&bundle);
        return (!executable.as_os_str().is_empty() && executable.exists()).then(|| app(bundle, executable));
    }
    let bundle = directory.join(BUNDLE_NAME);
    let name = if platform == "win32" { format!("{BUNDLE_NAME}.exe") } else { BUNDLE_NAME.to_string() };
    let executable = bundle.join(name);
    executable.exists().then(|| app(bundle, executable))
}

/// The folder of a Wine build: the one with bin/wine in it.
pub fn wine_in_directory(directory: &Path) -> Option<PathBuf> {
    let wine = directory.join(WINE_DIR);
    wine.join("bin").join("wine").is_file().then_some(wine)
}

pub fn find(paths: &Paths) -> Option<AirApp> {
    if PLATFORM == "linux" {
        let mut app = in_directory(&paths.vendor_for("air", "win32"), "win32")?;
        app.wine = Some(wine_in_directory(&paths.vendor("wine"))?);
        return Some(app);
    }
    in_directory(&paths.vendor("air"), PLATFORM)
}

pub fn verify(app: &AirApp) -> integrity::Verdict {
    let Some(wine) = &app.wine else {
        return integrity::verify_tree(&app.path, integrity::AIR_RECORD, "AIR engine");
    };
    let air = integrity::verify_tree_for(&app.path, integrity::AIR_RECORD, "AIR engine", "win32");
    if !air.ok {
        return air;
    }
    integrity::verify_tree(wine, integrity::WINE_RECORD, "Wine")
}

/// What Wine is given, besides the bundled Wine's own folder. The game gets a Wine folder of its
/// own (`prefix`, made on the first start), and Wine is kept from offering to install Mono and
/// Gecko, which AIR does not use, and from adding menu entries to the desktop.
pub fn wine_env(prefix: &Path) -> Vec<(String, String)> {
    vec![
        ("WINEPREFIX".into(), prefix.to_string_lossy().into_owned()),
        ("WINEDEBUG".into(), "-all".into()),
        ("WINEDLLOVERRIDES".into(), "mscoree,mshtml=;winemenubuilder.exe=d".into()),
    ]
}

/// `data_dir` is the launcher's own data folder; the Wine folder is made there.
pub fn prepare_launch(app: &AirApp, swf_url: &str, quality: &str, data_dir: &Path) -> Launch {
    let mut args = vec![swf_url.to_string()];
    if !quality.is_empty() {
        args.push(format!("--quality={quality}"));
    }
    let Some(wine) = &app.wine else {
        return Launch { command: app.executable.clone(), args, cwd: None, env: vec![] };
    };
    args.insert(0, app.executable.to_string_lossy().into_owned());
    Launch {
        command: wine.join("bin").join("wine"),
        args,
        cwd: Some(app.path.clone()),
        env: wine_env(&data_dir.join("wine-prefix")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn linux_starts_the_windows_bundle_in_the_bundled_wine() {
        let dir = std::env::temp_dir().join(format!("db-air-wine-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let bundle = dir.join("air").join(BUNDLE_NAME);
        fs::create_dir_all(&bundle).unwrap();
        fs::write(bundle.join(format!("{BUNDLE_NAME}.exe")), b"MZ").unwrap();
        fs::create_dir_all(dir.join("wine").join(WINE_DIR).join("bin")).unwrap();
        assert!(wine_in_directory(&dir.join("wine")).is_none(), "no bin/wine yet");
        fs::write(dir.join("wine").join(WINE_DIR).join("bin").join("wine"), b"").unwrap();
        let wine = wine_in_directory(&dir.join("wine")).unwrap();

        let mut app = in_directory(&dir.join("air"), "win32").unwrap();
        app.wine = Some(wine.clone());
        let launch = prepare_launch(&app, "http://x/DungeonBlitz.swf?a=1", "low", Path::new("/data"));
        assert_eq!(launch.command, wine.join("bin").join("wine"));
        assert_eq!(
            launch.args,
            vec![bundle.join(format!("{BUNDLE_NAME}.exe")).to_string_lossy().into_owned(), "http://x/DungeonBlitz.swf?a=1".into(), "--quality=low".into()]
        );
        assert_eq!(launch.cwd.as_deref(), Some(bundle.as_path()));
        assert!(launch.env.contains(&("WINEPREFIX".into(), "/data/wine-prefix".into())));

        app.wine = None;
        let native = prepare_launch(&app, "http://x/y.swf", "", Path::new("/data"));
        assert_eq!(native.command, bundle.join(format!("{BUNDLE_NAME}.exe")));
        assert!(native.env.is_empty() && native.cwd.is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
