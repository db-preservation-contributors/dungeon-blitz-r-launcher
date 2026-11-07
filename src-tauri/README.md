# Dungeon Blitz: R launcher (Rust)

The launcher, in Rust on [Tauri 2](https://tauri.app). Its window is the page in `../renderer/`:
`src/shim.js` gives that page its `window.launcher` calls, answered by the Rust side. It replaced
the Electron launcher, whose last release was 1.11.3.

```bash
cargo install tauri-cli --version "^2" --locked
cargo tauri dev          # a debug build is treated as a checkout: no fingerprint checks
cargo tauri build        # installers in target/release/bundle/
cargo test
```

Engines come from the Node tools in `../tools/` (`node tools/fetch-projector.js`,
`node tools/build-air.js`, `node tools/build-flash-preload.js`). Their `lib/*.integrity.json`
fingerprints are compiled into the binary by `build.rs`.

## What it does

- Window, state shape and every status row
- `servers.json` (same format) and `launcher-state.json` in the same user-data folder, so a
  player's saved sign-in carried over from the Electron launcher
- Discord sign-in in the browser with the launcher key and login code, device token
  resume/forget, account polling and token recovery from an in-game sign-in
- AIR engine and standalone Flash Player, fingerprint checks before every game, the loader SWF,
  render mode and quality, Linux VDPAU and preload libraries, game window title
  (Win32 API on Windows, xdotool on Linux)
- Graphics settings
- Rich presence (local endpoint on 127.0.0.1:47631, Discord RPC socket, party joins)
- Presence polling and region latency while the game runs
- Lobby chat (Discord authorization in the Discord client, linked or private lobby) and the
  game chat mirror
- Game stats widget sync
- Update notice: a newer release is shown with a download link; nothing is ever installed
  without the player choosing to
- Disk image / Downloads warning and Move to Applications on macOS
- Single instance
- Developer mode: Create (game server checkout behind two cloudflared quick tunnels), Play on my
  server and Join, in AIR (`src/dev.rs`, `src/dev_join.rs`)
- The native Social SDK bridge, opt-in with `nativeBridge: true` in social.config.json
  (`src/social.rs`), and `DB_FLASH_TIMER=1` on Windows (`src/flash_timer.rs`)

## Builds

| Build | Rust target | Engine |
| --- | --- | --- |
| Windows x64 | `x86_64-pc-windows-msvc` | AIR |
| Windows ia32 | `i686-pc-windows-msvc` | Flash Player |
| Windows 7 x64 / ia32 | `x86_64-win7-windows-msvc` / `i686-win7-windows-msvc` (nightly, `-Zbuild-std`, `--features win7`) | Flash Player |
| macOS | `x86_64-apple-darwin` | AIR |
| Linux | `x86_64-unknown-linux-gnu` | Flash Player |

The Windows 7 build runs on WebView2 109, the last version for Windows 7. Its executable is built
with `--cfg windows_slim_errors` and `+crt-static`, then `tools/win7-imports.js` renames the
`combase.dll` import (Windows 8+) to `ole32.dll` and fails the build if anything it imports is
missing on Windows 7.

On every Windows build the launcher checks for WebView2 before it opens its window
(`src/webview2.rs`); when the runtime is missing it offers to download and run Microsoft's
bootstrapper, which installs the current runtime on Windows 10/11 and 109 on 7/8/8.1. `.github/workflows/rust-launcher.yml` builds all of them.

## Releases

The launcher's version is the `version` in `tauri.conf.json`, not `package.json` (which only
names the Node build tools). Versions start at 1.12.0, after the Electron launcher's last tag.

To make a release, raise the version in `tauri.conf.json`, then run the **Rust launcher**
workflow by hand (Actions, Run workflow, on `main`). It builds every installer and attaches
them to one **draft** release `v<version>`; it never publishes. Running it again for the same
version replaces the draft's installers; a published tag is refused.

The installed launcher's update notice (`src/update.rs`) reads GitHub's *latest* release and
picks the file for its build by name (`-mac-x64.dmg`, `-win-x64-setup.exe`,
`-win7-x64-setup.exe`, `.AppImage`, `.deb`), so keep the names the workflow gives.
