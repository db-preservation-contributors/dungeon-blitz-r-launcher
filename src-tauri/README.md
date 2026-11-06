# Dungeon Blitz: R launcher (Rust)

The launcher rewritten in Rust on [Tauri 2](https://tauri.app). It reuses the launcher window in
`../renderer/` unchanged: `src/shim.js` gives that page the same `window.launcher` calls the
Electron preload did, answered by the Rust side.

```bash
cargo install tauri-cli --version "^2" --locked
cargo tauri dev          # a debug build is treated as a checkout: no fingerprint checks
cargo tauri build        # installers in target/release/bundle/
cargo test
```

Engines come from the same tools as before (`node tools/fetch-projector.js`,
`node tools/build-air.js`, `node tools/build-flash-preload.js`). Their `lib/*.integrity.json`
fingerprints are compiled into the binary by `build.rs`.

## Ported

- Window, state shape and every status row, unchanged UI
- `servers.json` (same format) and `launcher-state.json` in the same user-data folder, so a
  player's saved sign-in carries over from the Electron launcher
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

## Not yet ported

- Damage meter window
- Developer mode (Create / Join test servers)
- The native Social SDK bridge (the JavaScript driver, the default, is ported)
- `DB_FLASH_TIMER` (off by default in the Electron launcher)

## Builds

| Build | Rust target | Engine |
| --- | --- | --- |
| Windows x64 | `x86_64-pc-windows-msvc` | AIR |
| Windows ia32 | `i686-pc-windows-msvc` | Flash Player |
| Windows 7 x64 / ia32 | `x86_64-win7-windows-msvc` / `i686-win7-windows-msvc` (nightly, `-Zbuild-std`, `--features win7`) | Flash Player |
| macOS | `x86_64-apple-darwin` | AIR |
| Linux | `x86_64-unknown-linux-gnu` | Flash Player |

The Windows 7 build runs on WebView2 109, the last version for Windows 7; the installer sets it
up when it is missing. `.github/workflows/rust-launcher.yml` builds all of them.
