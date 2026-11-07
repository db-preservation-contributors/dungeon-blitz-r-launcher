use std::path::{Path, PathBuf};

use super::{binary, integrity, Launch};
use crate::config::{Paths, PLATFORM};

pub const BUNDLE_NAME: &str = "DungeonBlitzR";

#[derive(Clone, Debug)]
pub struct AirApp {
    pub path: PathBuf,
    pub executable: PathBuf,
    pub tampered: bool,
    pub tamper_reason: String,
}

fn in_directory(directory: &Path) -> Option<AirApp> {
    let app = |path: PathBuf, executable: PathBuf| AirApp { path, executable, tampered: false, tamper_reason: String::new() };
    if PLATFORM == "darwin" {
        let bundle = directory.join(format!("{BUNDLE_NAME}.app"));
        if !bundle.exists() {
            return None;
        }
        let executable = binary::mac_bundle_executable(&bundle);
        return (!executable.as_os_str().is_empty() && executable.exists()).then(|| app(bundle, executable));
    }
    let bundle = directory.join(BUNDLE_NAME);
    let name = if PLATFORM == "win32" { format!("{BUNDLE_NAME}.exe") } else { BUNDLE_NAME.to_string() };
    let executable = bundle.join(name);
    executable.exists().then(|| app(bundle, executable))
}

pub fn find(paths: &Paths) -> Option<AirApp> {
    in_directory(&paths.vendor("air"))
}

pub fn verify(path: &Path) -> integrity::Verdict {
    integrity::verify_tree(path, integrity::AIR_RECORD, "AIR engine")
}

pub fn prepare_launch(app: &AirApp, swf_url: &str, quality: &str) -> Launch {
    let mut args = vec![swf_url.to_string()];
    if !quality.is_empty() {
        args.push(format!("--quality={quality}"));
    }
    Launch { command: app.executable.clone(), args, cwd: None, env: vec![] }
}
