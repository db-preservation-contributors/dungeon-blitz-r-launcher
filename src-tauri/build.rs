use std::{env, fs, path::PathBuf};

fn main() {
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("..");
    fs::create_dir_all(root.join("vendor")).unwrap();
    let lib = root.join("lib");
    for name in ["projector.integrity.json", "air.integrity.json", "flashpreload.integrity.json"] {
        let source = lib.join(name);
        println!("cargo:rerun-if-changed={}", source.display());
        let body = fs::read_to_string(&source).unwrap_or_else(|_| "{}".into());
        fs::write(out.join(name), body).unwrap();
    }
    tauri_build::build()
}
