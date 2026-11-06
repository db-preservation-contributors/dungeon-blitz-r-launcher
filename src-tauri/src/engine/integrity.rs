use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

pub const PROJECTOR_RECORD: &str = include_str!(concat!(env!("OUT_DIR"), "/projector.integrity.json"));
pub const AIR_RECORD: &str = include_str!(concat!(env!("OUT_DIR"), "/air.integrity.json"));
pub const PRELOAD_RECORD: &str = include_str!(concat!(env!("OUT_DIR"), "/flashpreload.integrity.json"));

#[derive(Clone, Debug)]
pub struct Verdict {
    pub ok: bool,
    pub reason: String,
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

struct Walk {
    ancestors: HashSet<PathBuf>,
    hashes: HashMap<PathBuf, String>,
}

fn collect(root: &Path, relative: &[String], lines: &mut Vec<String>, state: &mut Walk) -> std::io::Result<()> {
    let full = relative.iter().fold(root.to_path_buf(), |p, s| p.join(s));
    let name = relative.join("/");
    let metadata = match fs::metadata(&full) {
        Ok(m) => m,
        Err(error) => {
            if fs::symlink_metadata(&full).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
                let target = fs::read_link(&full)?;
                lines.push(format!("L {name} -> {}", target.display()));
                return Ok(());
            }
            return Err(error);
        }
    };
    let real = fs::canonicalize(&full)?;
    if metadata.is_dir() {
        if state.ancestors.contains(&real) {
            lines.push(format!("C {name}"));
            return Ok(());
        }
        state.ancestors.insert(real.clone());
        let mut entries: Vec<String> =
            fs::read_dir(&full)?.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        entries.sort();
        for entry in entries {
            let mut next = relative.to_vec();
            next.push(entry);
            collect(root, &next, lines, state)?;
        }
        state.ancestors.remove(&real);
        return Ok(());
    }
    let hash = match state.hashes.get(&real) {
        Some(h) => h.clone(),
        None => {
            let h = sha256_file(&real)?;
            state.hashes.insert(real.clone(), h.clone());
            h
        }
    };
    lines.push(format!("F {name} {hash}"));
    Ok(())
}

pub fn tree_digest(target: &Path) -> String {
    let mut lines = Vec::new();
    let mut state = Walk { ancestors: HashSet::new(), hashes: HashMap::new() };
    match collect(target, &[], &mut lines, &mut state) {
        Ok(()) => hex::encode(Sha256::digest(lines.join("\n").as_bytes())),
        Err(_) => String::new(),
    }
}

pub fn verify_tree(target: &Path, record: &str, label: &str) -> Verdict {
    let fail = |reason: String| Verdict { ok: false, reason };
    let parsed: serde_json::Value = serde_json::from_str(record).unwrap_or_default();
    let digest = parsed.get("digest").and_then(|v| v.as_str()).unwrap_or("");
    if digest.len() != 64 || !digest.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) {
        return fail(format!("this build carries no {label} fingerprint"));
    }
    if let Some(platform) = parsed.get("platform").and_then(|v| v.as_str()) {
        if !platform.is_empty() && platform != crate::config::PLATFORM {
            return fail(format!("this build's {label} fingerprint is for {platform}"));
        }
    }
    let expected = parsed.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let found = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if found != expected {
        return fail(format!("expected {expected}, found {found}"));
    }
    let actual = tree_digest(target);
    if actual.is_empty() {
        return fail(format!("{label} could not be read"));
    }
    if actual != digest {
        return fail(format!("{label} files were changed after installation"));
    }
    Verdict { ok: true, reason: String::new() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digest_matches_node_format() {
        let dir = std::env::temp_dir().join(format!("db-integrity-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("Bundle").join("sub")).unwrap();
        fs::write(dir.join("Bundle").join("a.txt"), b"a").unwrap();
        fs::write(dir.join("Bundle").join("sub").join("b.txt"), b"b").unwrap();
        let bundle = dir.join("Bundle");
        let lines = format!(
            "F a.txt {}\nF sub/b.txt {}",
            hex::encode(Sha256::digest(b"a")),
            hex::encode(Sha256::digest(b"b"))
        );
        let expected = hex::encode(Sha256::digest(lines.as_bytes()));
        assert_eq!(tree_digest(&bundle), expected);
        let record = format!(r#"{{"platform":"{}","name":"Bundle","digest":"{}"}}"#, crate::config::PLATFORM, expected);
        assert!(verify_tree(&bundle, &record, "AIR engine").ok);
        fs::write(dir.join("Bundle").join("extra"), b"x").unwrap();
        assert!(!verify_tree(&bundle, &record, "AIR engine").ok);
        let _ = fs::remove_dir_all(&dir);
    }
}
