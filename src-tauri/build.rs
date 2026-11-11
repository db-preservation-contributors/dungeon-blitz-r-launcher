use std::{env, fs, path::PathBuf};

fn main() {
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("..");
    fs::create_dir_all(root.join("vendor")).unwrap();
    let lib = root.join("lib");
    for name in ["projector.integrity.json", "air.integrity.json", "flashpreload.integrity.json", "wine.integrity.json"] {
        let source = lib.join(name);
        println!("cargo:rerun-if-changed={}", source.display());
        let body = fs::read_to_string(&source).unwrap_or_else(|_| "{}".into());
        fs::write(out.join(name), body).unwrap();
    }
    // The Windows 7 build links the whole C runtime in (`+crt-static`): Windows 7 without the
    // Universal CRT update has no api-ms-win-crt-*.dll. Tauri's own setting links only the VC
    // runtime statically and forces the dynamic UCRT, which conflicts with that.
    let crt_static = env::var("CARGO_CFG_TARGET_FEATURE").unwrap_or_default().split(',').any(|f| f == "crt-static");
    if crt_static {
        let windows = tauri_build::WindowsAttributes::new().static_vc_runtime(false);
        tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows)).expect("tauri build");
    } else {
        tauri_build::build()
    }
}
