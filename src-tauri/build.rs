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
    bundle_damage_meter(&root, &out);
    tauri_build::build()
}

/// lib/damageMeter's modules and data as one script for the meter window, after
/// src/damage_meter_host.js (which stands in for the Node modules they use).
fn bundle_damage_meter(root: &std::path::Path, out: &std::path::Path) {
    let dir = root.join("lib").join("damageMeter");
    let mut bundle = String::new();
    for name in ["protocol", "tracker", "meter", "powers", "entities", "exporter", "feed", "index"] {
        let file = dir.join(format!("{name}.js"));
        println!("cargo:rerun-if-changed={}", file.display());
        let source = fs::read_to_string(&file).unwrap_or_else(|e| panic!("{}: {e}", file.display()));
        bundle.push_str(&format!(
            "window.__dmDefine('./{name}', function (require, module, exports, __dirname, Buffer) {{\n{source}\n}});\n"
        ));
    }
    for name in ["powers", "bosses"] {
        let file = dir.join("data").join(format!("{name}.json"));
        println!("cargo:rerun-if-changed={}", file.display());
        let text = fs::read_to_string(&file).unwrap_or_else(|e| panic!("{}: {e}", file.display()));
        let literal = serde_json::to_string(&text).unwrap();
        bundle.push_str(&format!("window.__dmFile('/bundled/data/{name}.json', {literal});\n"));
    }
    fs::write(out.join("damage_meter_bundle.js"), bundle).unwrap();
}
