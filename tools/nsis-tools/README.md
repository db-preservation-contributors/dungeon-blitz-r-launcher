# Vendored NSIS build tools

Tauri's NSIS bundler downloads two files from GitHub release assets while packaging the Windows
setups, whenever its tool cache (`%LOCALAPPDATA%\tauri\NSIS`) is missing or incomplete:

- `nsis-3.13.zip` — from `tauri-apps/binary-releases`, tag `nsis-3.13`
  (SHA1 `DB14F8AF2EA346B786C6AE19343F61AAF5E09B8E`)
- `nsis_tauri_utils.dll` — from `tauri-apps/nsis-tauri-utils`, tag `nsis_tauri_utils-v0.5.3`
  (SHA1 `75197FEE3C6A814FE035788D1C34EAD39349B860`)

On a fresh GitHub runner the cache is always empty, so every Windows job (x64, ia32, Windows 7 x64
and ia32) downloaded them, and a degraded GitHub CDN (`503`/`504`) failed all four. The
**Seed the NSIS build tools** step in `.github/workflows/rust-launcher.yml` lays these files out the
way the bundler would — the zip extracted and renamed to `NSIS`, the DLL in
`Plugins\x86-unicode\additional` — so the bundler finds a complete toolset and skips the downloads.
The step checks both SHA1s and falls back to a retrying download if a vendored file is missing or
altered.

Both files are small, so they are kept in Git directly (not LFS) and marked `binary` in
`.gitattributes`.

## Refreshing them

These are pinned to what `tauri-bundler` 2.10.4 requests. If a Tauri CLI upgrade changes `NSIS_URL`,
`NSIS_SHA1`, `NSIS_TAURI_UTILS_URL` or `NSIS_TAURI_UTILS_SHA1` (see
`crates/tauri-bundler/src/bundle/windows/nsis/mod.rs`), replace the files and update the names,
URLs and SHA1s in the workflow step. The zip's top folder (`nsis-3.13`) is renamed by the step, so
change that too on an NSIS version bump.

```bash
curl -fSL -o nsis-3.13.zip \
  https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.13/nsis-3.13.zip
curl -fSL -o nsis_tauri_utils.dll \
  https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll
sha1sum nsis-3.13.zip nsis_tauri_utils.dll
```

Until they are refreshed, a newer bundler simply sees an outdated `NSIS.exe` and downloads its own
copy, as it did before the step existed.
