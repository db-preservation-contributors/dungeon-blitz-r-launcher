# Vendored AppImage build tools

Tauri's AppImage bundler downloads two tools from GitHub release assets while packaging the Linux
build:

- `AppRun-x86_64` — from `tauri-apps/binary-releases`, tag `apprun-old`
- `linuxdeploy-07333c6-x86_64.AppImage` — from `tauri-apps/binary-releases`, tag `linuxdeploy-07333c6`
  (downloaded there as `linuxdeploy-x86_64.AppImage`)

Whenever GitHub's release-asset CDN is degraded those downloads return `504` and the Linux release
fails, even though nothing in our code changed. To make the Linux build independent of that, the two
tools are vendored here and copied into Tauri's tool cache (`~/.cache/tauri/`, the exact file names
`tauri-bundler` looks for) by the **Seed the AppImage build tools** step in
`.github/workflows/rust-launcher.yml`. With the files already present, the bundler skips the
downloads entirely.

`linuxdeploy-07333c6-x86_64.AppImage` is large, so it is stored with Git LFS (see `.gitattributes`);
`AppRun-x86_64` is ~31 KB and kept in Git directly.

## Refreshing them

These are pinned to the versions `tauri-bundler` currently requests. If a Tauri CLI upgrade changes
the pinned `linuxdeploy` commit hash or the AppRun tag (check
`tauri-bundler/src/bundle/linux/appimage/linuxdeploy.rs`), re-download and update the names:

```bash
curl -fSL -o AppRun-x86_64 \
  https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-x86_64
curl -fSL -o linuxdeploy-07333c6-x86_64.AppImage \
  https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy-07333c6/linuxdeploy-x86_64.AppImage
chmod +x AppRun-x86_64 linuxdeploy-07333c6-x86_64.AppImage
```

Keep the cache file name in the workflow (`linuxdeploy-<hash>-x86_64.AppImage`) in sync with the hash
the bundler expects.
