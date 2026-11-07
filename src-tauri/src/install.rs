use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::config::{is_packaged, PLATFORM};

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallLocation {
    pub relocate: bool,
    pub reason: String,
    pub message: String,
    pub source_path: String,
    pub target_path: String,
    pub can_move: bool,
}

pub fn bundle_path_of(exe: &Path) -> PathBuf {
    let text = exe.to_string_lossy().replace('\\', "/");
    match text.find(".app/") {
        Some(i) => PathBuf::from(&text[..i + 4]),
        None => exe.parent().map(Path::to_path_buf).unwrap_or_default(),
    }
}

pub fn inspect(exe: &Path) -> InstallLocation {
    let bundle = bundle_path_of(exe);
    let source = bundle.to_string_lossy().into_owned();
    let unchanged = InstallLocation { source_path: source.clone(), ..Default::default() };
    if !is_packaged() || source.is_empty() {
        return unchanged;
    }
    let normalized = source.replace('\\', "/");
    let volume = PLATFORM == "darwin" && normalized.starts_with("/Volumes/");
    let downloads = normalized.split('/').any(|s| s == "Downloads");
    let portable = PLATFORM == "darwin" && normalized.ends_with(".app");
    let target = if portable {
        format!("/Applications/{}", bundle.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
    } else {
        String::new()
    };
    if !target.is_empty() && target == normalized {
        return unchanged;
    }
    let build = |reason: &str, message: String| InstallLocation {
        relocate: true,
        reason: reason.into(),
        message,
        source_path: source.clone(),
        can_move: !target.is_empty(),
        target_path: target.clone(),
    };
    if volume {
        return build(
            "disk-image",
            "The launcher is running from a mounted disk image. It will stop working once the image is ejected, and it cannot be updated in place.".into(),
        );
    }
    if downloads {
        let home = dirs::home_dir().unwrap_or_default().join("Downloads");
        return build(
            "downloads",
            if portable {
                format!("The launcher is running from {}. Copies left there are easy to lose track of, and an outdated one cannot tell you it is outdated.", home.display())
            } else {
                "The launcher is running from an unpacked Downloads copy. Install it properly so the build you open is the build you have.".into()
            },
        );
    }
    unchanged
}

pub fn move_to_applications(location: &InstallLocation, exe: &Path) -> Result<PathBuf, String> {
    let (source, target) = (location.source_path.as_str(), location.target_path.as_str());
    if source.is_empty() || target.is_empty() {
        return Err("This build cannot move itself. Install it again from the installer.".into());
    }
    let parent = Path::new(target).parent().unwrap_or(Path::new("/Applications"));
    if std::fs::metadata(parent).map(|m| m.permissions().readonly()).unwrap_or(true) {
        return Err(format!("{} is not writable by this user.", parent.display()));
    }
    if Path::new(target).exists() {
        std::fs::remove_dir_all(target).map_err(|e| format!("Could not copy the launcher: {e}"))?;
    }
    let status = std::process::Command::new("ditto").args([source, target]).status().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("Could not copy the launcher.".into());
    }
    let inner = exe.to_string_lossy().replacen(source, "", 1);
    Ok(PathBuf::from(format!("{target}{inner}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_root() {
        assert_eq!(
            bundle_path_of(Path::new("/Volumes/DB/Dungeon Blitz R.app/Contents/MacOS/launcher")),
            PathBuf::from("/Volumes/DB/Dungeon Blitz R.app")
        );
    }
}
