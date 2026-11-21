# Dungeon Blitz: R Launcher

A desktop launcher that plays Dungeon Blitz in the AIR engine -- the game in Adobe AIR's runtime,
which ships inside the launcher -- so players do not need a browser that still has Flash. Linux
plays the Windows AIR build in a Wine the launcher carries. The builds AIR has no runtime for
(Windows 32-bit, the Windows 7 build) play in Adobe Flash Player 32, the standalone player,
instead. It ships for Windows, macOS and Linux.

The launcher is a sign-in screen, not a control panel. It asks for one thing — sign in
with Discord — and once that is done it opens the game and connects to the server. A player who has signed in before is not asked again.

In the background it also connects the player's Discord lobby so lobby chat works,
publishes Discord rich presence, writes the player's Discord Game Stats widget, and mirrors
the player's in-game chat into that lobby — in both directions — for as long as the game is open.

The launcher is a Rust program on [Tauri 2](https://tauri.app) (`src-tauri/`). Its window is
the web page in `renderer/`; `src-tauri/src/shim.js` gives that page its `window.launcher`
calls, answered by the Rust side. Up to 1.11.3 the launcher was an Electron app; a player on
it installs this one from the Releases page.

## A free, non-commercial preservation project

Dungeon Blitz was a game a lot of us grew up with, and when Flash was switched off it
became almost impossible to play. This project exists so it is not lost: so the people who
remember it can play it again, and so people who never got the chance can see what it was.

We want to be clear about what this is and what it is not:

- **It is free, and it will stay free.** You do not pay anything to download the launcher
  or to play. There is no price, no subscription, no paid item and no advertising.
- **Donations are optional, and they buy nothing.** The Minesa Studios accepts donations
  from people who want to support the project, but a donation unlocks nothing in the game.
  A player who donates gets exactly the same game as one who does not.
- **It is not a commercial product, and nobody may make it one.** The launcher was made by
  The Minesa Studios and is given away free. The Minesa Studios is a group made up only of
  the project's contributors and sponsors, and we work on it in our spare time because we
  care about the game. The launcher is licensed under the
  [PolyForm Noncommercial License 1.0.0](LICENSE): you can use, change and share it for
  free, but nobody can sell it, charge for it or build a paid product on it.
- **It is a fan project, not an official one.** We are not affiliated with, endorsed by or
  working on behalf of the original developers or publishers of Dungeon Blitz. The game's
  name, art, music, characters and everything else that makes it Dungeon Blitz belong to
  their owners. We claim none of it as ours.
- **Adobe Flash Player and the Discord Social SDK belong to Adobe and Discord.** They ship
  with the launcher only so the game can run and connect, and nothing here gives anyone
  rights to them. See [LICENSE](LICENSE) for what our own license does and does not cover.

### Where to download it

The only official place to get the launcher is the
[Releases page](https://github.com/theminesastudios/dungeon-blitz-r-launcher/releases) of
this repository. If anyone asks you to pay for it, or offers a "premium" or modified copy,
it did not come from us. Please do not pay for it, and please let us know.

### For rights holders

If you own rights to Dungeon Blitz, or to anything else used here, and you are not
comfortable with this project, please talk to us. Open an
[issue](https://github.com/theminesastudios/dungeon-blitz-r-launcher/issues) or contact
The Minesa Studios directly. We will listen, and we will take down or change whatever you
ask us to without argument. We would much rather work with you than against you.

## What is where

| Path | What |
| --- | --- |
| `src-tauri/` | The launcher: Rust sources (`src/`), Tauri config, Rust tests. See [src-tauri/README.md](src-tauri/README.md). |
| `renderer/` | The launcher window (HTML, CSS, JS), loaded by Tauri as the app's front end |
| `servers.json`, `presence.config.json`, `social.config.json` | Runtime configuration, bundled into every build |
| `air/` | The AIR engine's ActionScript app (`air/src/DungeonBlitzAir.as`) |
| `native_flash/` | The Linux Flash Player preload libraries |
| `native_bridge/` | The Discord Social SDK bridge sources (optional native lobby driver) |
| `tools/`, `lib/` | Node build tools that fetch, build and fingerprint the game engines (`vendor/`), and their tests |
| `build/` | Application icons |
| `vendor/` | Build output: the engines a build ships (gitignored) |

## Game engine: AIR, and Flash Player where AIR has none

One build, one engine, and one **Open the game** button. Nothing is picked by the player:

| Build | Engine |
| --- | --- |
| Windows x64, macOS | AIR: the game in Adobe AIR's runtime (`src-tauri/src/engine/air.rs`, see [AIR engine](#air-engine)). These builds carry **no Flash Player**. |
| Linux | AIR in Wine: the Windows AIR bundle, run in a Wine built from WineHQ's source and shipped with the launcher (see [AIR on Linux, in Wine](#air-on-linux-in-wine)). Flash Player stays as the **Legacy** button. |
| Windows ia32, the Windows 7 build | Adobe's standalone Flash Player 32 (`flashplayer_32_sa`, `src-tauri/src/engine/projector.rs`), which AIR has no runtime for there |

An AIR build never looks for a Flash Player: it plays AIR wherever the build carries the bundle,
even one whose files were changed (it then says so and plays nothing), and Flash Player only in a
build with no AIR engine.

### The standalone Flash Player

In the builds AIR has no runtime for, the game runs in **Adobe Flash Player itself** -- `flashplayer_32_sa`,
the standalone player Adobe calls the projector. The launcher starts it on the game's SWF,
straight from the selected server:

```
flashplayer_32_sa.exe http://<server>/p/cbp/DungeonBlitz.swf?fv=cbp&gv=cbp&clientrev=...
```

On Windows it goes through a small loader file instead, for direct rendering (see
[below](#direct-hardware-rendering-on-windows)); the game still comes from the same URL.

Flash Player runs as its own process, with its own window and renderer. Nothing sits
between it and the game. The standalone player also has no 2021-01-12 kill switch; the
browser plugins do.

#### A steady 60 fps on Windows

Flash Player 32 paces its frames off the Windows timer and tops out at 60 fps, however high
the game asks (it asks for 100) and however fast the display (measured on a 200 Hz screen).
At Windows' default 15.6 ms timer tick a 16.7 ms frame keeps landing a tick late, so about
one frame in nine takes 31-32 ms. Since Windows 10 2004 the timer resolution belongs to each
process, so nothing outside Flash Player can lend it a finer one, and Flash Player never asks
for one itself.

So the launcher can have Flash Player ask (`src-tauri/src/flash_timer.rs`): for each game the 32-bit
PowerShell starts one thread in Flash Player at winmm.dll's own `timeBeginPeriod`, with the
argument 1. Nothing is written into Flash Player's memory, the thread only runs once it has
checked that winmm.dll sits at the same address in both processes, and the request lasts
until Flash Player exits. The log says `[Flash] Timer resolution: ok: 1 ms`. Measured with a
bare 60 fps movie in 32.0.0.465, per 180 frames:

| Timer | Average | Frames over 20 ms | Worst frame |
| --- | --- | --- | --- |
| Windows default (15.6 ms) | 60 fps | 15-21 | 33 ms |
| 1 ms (`DB_FLASH_TIMER=1`) | 60 fps | 6-9 | 22-24 ms |

This is off unless `DB_FLASH_TIMER=1` is set on the launcher. A thread started in another
process is what process injection looks like, and antivirus software flags the assembly
PowerShell compiles for it into `%TEMP%` (Bitdefender blocked it as
`Gen:Variant.MSILHeracles` on every game start). Linux has its own fix for the same tick
(`native_flash/flash_short_tick.c`).

What is left is the game's own frame cost: a frame whose work takes longer than 16.7 ms still
drops below 60. With software rendering the window size decided it: in the same fight Legacy
held 57-61 fps with the game at 84% scale, and 40-45 fps at its 125% cap in a large window.

#### Direct (hardware) rendering on Windows

So on Windows the launcher starts Flash Player on a loader file (`src-tauri/src/engine/loader_swf.rs`) instead
of the game's URL. Its FileAttributes ask for hardware rendering (UseDirectBlit, the
projector's form of wmode "direct"); the game's own SWF asks for none, and the first movie's
flags are what Flash Player goes by. The loader then loads the game into level 0, as it
already does on macOS. In that same fight at the 125% cap, direct rendering held 57 fps.
Single frames of about 60 ms remain at any window size; those are the game's own work.

| `DB_FLASH_RENDER` | Rendering |
| --- | --- |
| unset | `direct` on Windows; software on macOS and Linux, where direct is untried |
| `direct` / `gpu` | UseDirectBlit / UseGPU, on any system |
| `software` | Flash Player's own software rendering, started on the game's URL as before |

The log says `[Flash] Render mode: direct` (or `software`).

#### Graphics settings

The launcher window has a **Graphics** panel with two choices, both saved in `launcher-state.json`
(`renderer`, `graphicsQuality`) and applied to the next game:

| Setting | Auto | Manual |
| --- | --- | --- |
| Renderer | GPU unless the machine's GPU driver is a software one (llvmpipe, SwiftShader, a software rasterizer); CPU then | `gpu`, `cpu` |
| Quality | From the machine: 2 cores or under 4 GB is `low`, 4 cores or under 8 GB is `medium`, else `high`; capped at `medium` without a GPU | `high`, `medium`, `low` |

- Flash Player: GPU is direct rendering (auto keeps software off Windows), CPU is
  software rendering. Low and medium quality are set by the loader file (`_quality`) before
  the game loads. `DB_FLASH_RENDER` still overrides the renderer. Linux keeps starting on the
  game's URL: its player fetches the game through the loader but never runs it, so the
  quality setting does not reach Flash Player there.
- AIR: the quality is passed to the AIR app (`--quality=`), which sets the stage quality.

| Platform | What ships | Notes |
| --- | --- | --- |
| Windows | `flashplayer_32_sa.exe` | 32-bit; runs on 32-bit and 64-bit Windows |
| macOS | `Flash Player.app` (from `flashplayer_32_sa.dmg`) | Intel; runs under Rosetta on Apple Silicon |
| Linux | `flashplayer` (from `flash_player_sa_linux.x86_64.tar.gz`) | x86_64; needs GTK 2 |

#### Where it comes from

```bash
npm run fetch-projector                                   # this machine's platform
node tools/fetch-projector.js --platform win32            # another platform
```

`tools/fetch-projector.js` downloads the player into `vendor/projector/<platform>/`:

- It tries Adobe's own update server (`fpdownload.macromedia.com`) first. That server
  still serves all three builds.
- It falls back to the Internet Archive's copy of the same URL.
- Whichever mirror answers, it checks the file against the SHA-256 pinned in
  `projector.lock.json`. A file that does not match is never used.

The macOS disk image is unpacked with `hdiutil` and `ditto`, so it has to be fetched on a
Mac -- which is where the macOS package is built anyway. The `Flash Player` workflow runs the
fetch on all three platforms whenever the lock file, the fetch script or `lib/projector.js`
changes. It also checks Adobe's signature on the downloaded player.

The package carries the player as a bundled resource (`vendor/`). A development build also
looks in a gitignored `projector/` folder at the repository root, the usual install places and
Downloads, and the **Choose Flash Player...** button takes one by hand.

#### Colours on Linux

On Linux, Flash Player draws the game through VDPAU when it can. It hands VDPAU the
picture with two colour planes swapped. libvdpau corrects that only for the browser
plugin, never for the standalone player. Left alone, the game shows up in false colours: a
yellow sky and a green wash over everything, with true-colour boxes here and there.

So the launcher starts Flash Player on Linux with `VDPAU_DRIVER=none`. No such VDPAU
backend exists, so VDPAU does not open and Flash Player draws in software, as it does on
any machine without VDPAU. A player whose driver does draw the game correctly can keep
hardware drawing by starting the launcher with `DUNGEON_BLITZ_FLASH_VDPAU=1`.

#### Frame rate on Linux

The Linux Flash Player asks the kernel for its stack limit (`getrlimit`) many times per
frame. Each ask is a system call. On a kernel that mitigates SRSO, the default on AMD Zen 1
to 4, a system call costs about 200 ns. Profiled in a dungeon on a Ryzen 7 3700X, that one
call took 40% of Flash Player's main thread, and the game ran at 15-30 fps.

A process's limits only change when it sets them, so the answer can be kept.
`native_flash/flash_rlimit_cache.c` does that: it answers `getrlimit` from memory and
forgets the kept answer on `setrlimit`. The launcher loads it into Flash Player with
`LD_PRELOAD`, and the same dungeon then runs at roughly 30-60 fps.

Flash Player also paces itself with three GLib timers of 10 ms, and starts each step of a
frame on a tick. A frame that runs a little past one tick waits for the next, so frame
times came in two bands, 10-14 ms and 18-24 ms, and the main thread spent about a quarter
of its time waiting. `native_flash/flash_short_tick.c` makes `g_timeout_add` timers of
10 ms tick every 2 ms; other timers are left alone. Flash Player still decides on its own
clock when a frame is due, so the game keeps its speed and its 100 fps cap. Standing still
in the same spot of a dungeon, full screen at high quality: 78.5 fps before, 85.3 fps
after, with the two-tick frames down from 21% to 0.5%.

- `tools/build-flash-preload.js` compiles every `native_flash/*.c` into
  `vendor/flashpreload/linux/` (`npm run build-flash-preload`; the Rust launcher workflow runs
  it for Linux). It needs a C compiler and `readelf`.
- Each library is checked as it is built. It must need nothing newer than glibc 2.17, and
  a program without GLib must still start with it, even with `LD_BIND_NOW`: whatever Flash
  Player starts inherits `LD_PRELOAD`. For the `getrlimit` cache, a shell started with it
  must get its `getrlimit` and `setrlimit` from it and still see the kernel's limits.
- Neither library looks anything up with `dlsym`, which moved to a newer glibc symbol
  version in 2.34. The cache calls the kernel through `syscall`, and the short tick calls
  GLib's `g_timeout_add_full`, which `g_timeout_add` is.
- The folder is fingerprinted into `lib/flashpreload.integrity.json`, and a packaged
  launcher checks it before every game, as it checks Flash Player.
- The libraries go into `LD_PRELOAD` by bare name, with their folder first in
  `LD_LIBRARY_PATH`. `LD_PRELOAD` splits on spaces, and the .deb installs into
  a folder whose name has one. What the player already preloads, such as MangoHud, is kept.
- `DUNGEON_BLITZ_FLASH_PRELOAD=0` starts Flash Player without them.

```bash
node tools/test-flash-preload.js
```

#### The window title

The AIR app titles its own window. In Flash Player the game window always reads **Dungeon Blitz: R**, never the game's address. Flash Player
names its own window, so how that is achieved differs by platform (`src-tauri/src/title.rs`):

| Platform | Flash Player's own title | What the launcher does |
| --- | --- | --- |
| Windows | `Adobe Flash Player 32` | Renames the window to `Dungeon Blitz: R` through the Win32 API. It repeats this every second while the game runs, because Flash Player sets its title again on its own. |
| macOS | The full game URL | No app can rename another app's window. So Flash Player is started on a local file named `Dungeon Blitz: R` (the loader SWF, written to the launcher's data folder before every game), whose only job is to load the game from the server. |
| Linux | `Adobe Flash Player 32,0,0,465` | Renames the window when `xdotool` is installed. Without it, the title stays Flash Player's own name. |

#### What the launcher does for the game page

The projector and AIR load only the SWF, not the game page, so the page's script does not run.
While the game is open, the launcher does that script's jobs itself (`src-tauri/src/game_host.rs`):

- It polls `/api/presence/self` every 4 s and publishes rich presence.
- It measures latency to each game region and reports it to `/api/region-rtt`.

Sign-in needs nothing from the page:

- On a fresh connection, the server signs the game in from the pending hand-off that the
  saved launcher token recreates.
- If the game is already open when the player signs in, the OAuth callback signs that open
  connection in.

### A build without its engine

A **packaged** launcher always ships its own engine. One that can run neither the AIR engine nor
Flash Player says so in the window and turns the play button off. Set
`DUNGEON_BLITZ_ALLOW_NO_FLASH=1` to allow it anyway.

`tools/preflight.js` **fails** the build when the package lacks its engine:
`--engine air` (the Windows x64 and macOS builds) needs the AIR bundle in `vendor/air/<platform>/`
matching its fingerprint, and fails if a Flash Player sits in `vendor/projector/<platform>/`,
where it would ship beside it; `--engine flash` (the default) needs Flash Player in
`vendor/projector/`. A deliberately Flash-less Flash build must set
`DUNGEON_BLITZ_PREFLIGHT_ALLOW_NO_FLASH=1`.

### The status strip

The sign-in screen carries a status strip with four rows, the ones a player cares about:

| Row | Shows |
| --- | --- |
| `Discord status` | Whether Discord shows the player as playing |
| `Lobby chat` | Whether the player's Discord lobby is connected |
| `Game stats` | Whether the Discord widget profile was written |
| `Version` | This launcher's version, and a newer release with a download link |

Hovering a value shows the detail: the local presence endpoint, or the last error.

Machine and engine details are not rows. A missing, changed or unrunnable engine is said in the
problem banner above the strip instead, and turns the play button off.
`node tools/test-launcher-status.js` checks every state of the strip, the banner and the play
button against the window's own code.

Once an account is known, the sign-in button is replaced by `Signed in as <name>`. That holds
whether the sign-in happened in the launcher or inside the game, where the SWF's own Discord
flow lands the player (see [Remembered account](#remembered-account)).

## AIR engine

The engine of the Windows x64 and macOS builds: the game in Adobe AIR's runtime (HARMAN's AIR
SDK) instead of Flash Player 32. It is 64-bit, has no 4 GB memory ceiling and is still
maintained. It draws the same way Flash Player does, so it is not faster; the point is memory and
a supported runtime. A build plays in it whenever `vendor/air/<platform>/` has a bundle.

- `air/src/DungeonBlitzAir.as` fetches the game SWF the launcher passes it and runs it with
  `loadBytes` in AIR's application sandbox, with the URL's query as flashvars.
- The game needs the server's AirCompat client patch (`scripts/patch-dungeonblitz-air-compat.ts`
  in the game repository): it loads the level and art SWFs the same way, and skips
  `Security.allowDomain` and `ExternalInterface`, which throw in AIR.
- `src-tauri/src/engine/air.rs` finds and starts the bundle; a packaged launcher checks it against
  `lib/air.integrity.json`, like Flash Player.
- The game SWF is kept on disk (`client-cache/` in the AIR app's storage folder: `Local Store` on
  macOS, `%APPDATA%\studio.theminesa.dungeonblitzr.air\Local Store` on Windows), named after
  its URL. The URL's `clientrev` is the SWF's content hash, so a start whose build is already
  there plays it without downloading it, and a new build is downloaded once and replaces the
  old one. A URL without a `clientrev` is never kept.
- The level and art SWFs are kept too (`game-files/<host>/` beside it), by content hash
  (`air/src/GameAssetCache.as`). At start the app fetches the server's `/asset-manifest.json`,
  which names each game file by its hash. A file already on disk loads with no request; a new or
  changed one is downloaded once from `/_h/<hash>` (falling back to HTTPS, then to the game's own
  URL), checked against its hash and kept; files the manifest no longer names are deleted. When
  the manifest cannot be fetched, the last one is used. The game SWF, `Game.swz` and the XML files
  are computed per server, are not in the manifest and still come from the server.
- In AIR the game sees no download progress for a SWF until all of it is in, and it restarts a
  download with no progress after 10 s (+5 s per attempt). Each restart used to start one more
  download of the same file beside the ones still running, so on a slow connection a file never
  finished (the loading screen's climbing `R=`). Now a restart joins the running download, and
  only one with no bytes for 20 s is started again.
- The game's loads reach the cache through `air/src/AirCompat.as`, the app's own copy of the
  game's AirCompat: a class the parent ApplicationDomain defines wins over the child's. It is
  used only when the game SWF carries the same `AirCompat.SOURCE_DIGEST`; any other game runs in
  a domain of its own with its own AirCompat, as before, and keeps nothing. When the server's
  `scripts/air-compat/AirCompat.as` changes, update this copy and its digest to match.
- While the SWF downloads, the window shows a progress bar. When it cannot be had, it says why
  in a player's words (server busy, version missing, no connection, a broken download), with
  **Try again**, an automatic retry after 20 s, and the technical detail underneath. Both
  screens wear the site's look, as the launcher window does: the hero art, the ornament and
  title, and Averia Serif Libre and Vollkorn SC, embedded from `air/assets/` (TrueType copies of
  `renderer/assets/fonts/`, under the OFL in `air/assets/OFL.txt`).

Building it needs the AIR SDK (free for personal use; download it from
https://airsdk.harman.com/download after accepting its license). ADT builds only for the system it
runs on. Windows and macOS only: the Linux AIR runtime runs only for commercially licensed
developers, so `build-air` refuses Linux. Linux plays the Windows bundle in Wine instead.

```bash
AIR_SDK_HOME=/path/to/AIRSDK npm run build-air   # -> vendor/air/<platform>/
```

ADT signs the bundle with `DB_AIR_CERT` / `DB_AIR_CERT_PASS`, or a self-signed certificate it makes
once in `build/air/`.

Releases build it on the Windows x64 and macOS runners: `tools/fetch-air-sdk.js` downloads the SDK
pinned in `air-sdk.lock.json` (version and SHA-256 per platform) into `build/air-sdk/<platform>/`,
then `build-air` packages it.

```bash
AIR_SDK_HOME=$(node tools/fetch-air-sdk.js | tail -1) npm run build-air
```

### AIR on Linux, in Wine

HARMAN's Linux AIR runtime is only for commercially licensed developers, so the Linux launcher
carries the Windows AIR bundle (`vendor/air/win32/`) and a Wine to run it in
(`vendor/wine/linux/wine/`). **Open the game** starts `wine DungeonBlitzR.exe <swf>`; **Legacy**
still starts Flash Player.

- The Wine is built from WineHQ's own source by `tools/build-wine.js`: `wine.lock.json` pins the
  source tarball (SHA-256) and the configure options. It is 64-bit only (`--enable-archs=x86_64`),
  so players need no 32-bit libraries, and it leaves out what only building programs for Wine
  needs (headers, import libraries, winegcc, ...). CI caches the build by the lock and the script.
- The game gets a Wine folder of its own, `wine-prefix/` in the launcher's data folder, made on
  the first start (some seconds). Wine is kept from offering Mono and Gecko, which AIR does not
  use, and from adding menu entries (`WINEDLLOVERRIDES`).
- Wine draws through X11 (XWayland on a Wayland desktop) and, with no X display at all, through
  its own Wayland driver.
- Both folders are fingerprinted: `lib/air.integrity.json` (made for win32) and
  `lib/wine.integrity.json`. CI builds the Windows bundle once (`air-windows` job), for the
  Windows installer and the Linux packages.

```bash
node tools/build-wine.js                 # -> vendor/wine/linux/wine, lib/wine.integrity.json
```

Wine is LGPL-2.1-or-later; its source is the tarball in `wine.lock.json`.

## Tamper resistance

An **installed** (release) launcher refuses to be repurposed. A debug build is treated as a
checkout and is exempt from all of this.

- **Only its own Flash Player and AIR engine.** It runs only the engines it was installed
  with, never a hand-picked file or a copy found elsewhere on the machine.
- **Fingerprint check before every game.** At build time, `tools/fetch-projector.js`,
  `tools/build-air.js` and `tools/build-flash-preload.js` record SHA-256 fingerprints in
  `lib/projector.integrity.json`, `lib/air.integrity.json` and
  `lib/flashpreload.integrity.json`, and `src-tauri/build.rs` compiles them into the binary.
  - The check covers every file in the macOS bundle and in the AIR tree, so an added file
    counts as a change.
  - A replaced or patched engine is refused: the status strip reads `changed - reinstall`,
    and the game does not start.
- **The window stays on its own page.** The launcher window navigates only within the app's
  own content; links open in the system browser.
- **CI checks the shipped copy.** The Rust launcher workflow runs `tools/preflight.js` on each
  build's engine before it bundles it.

**What this cannot stop.** Nothing running on the player's own machine can be made
impossible to manipulate; these checks raise the cost of doing it. In particular:

- **Patching the launcher.** The fingerprints live inside the launcher itself, so someone who
  rebuilds it can record new ones too. Only code signing makes such an edit show.
- **Unsigned installers.** Installers are unsigned unless the studio's certificates are
  configured. Signing is what makes a modified installer show as untrusted to the player.
- **The game itself.** Flash Player or AIR runs the SWF, and memory editors work on
  any process. What the game accepts is decided by the server: `src/server/core/anticheat` in
  the game repository.

## Signing in

Discord's consent screen opens in the player's own browser rather than inside the app,
because the launcher window loads no remote content. The launcher still sees the result
(`src-tauri/src/auth.rs`):

- Each sign-in has a one-time key of the launcher's own. The browser opens
  `/auth/discord?launcher=<sha256 of the key>`, and the server signs that hash into the OAuth
  state and files the finished login under it.
- The launcher's poll and its device-token request send the key itself in an
  `X-Launcher-Login-Key` header. So the login is found even when the browser reaches the server
  from another address than the launcher, for example through a browser VPN or proxy.
- The key is never in the browser, a URL or a log.
- When the launcher and the browser are at different addresses, the key alone is not enough.
  Anyone can make a key and send a player a sign-in link, so the server also wants the one-time
  code its "Discord Login Successful" page shows. The launcher asks for it in a small box, and
  only the person who just signed in can see that code. Five wrong codes cancel the sign-in.
- While a sign-in is pending, the window offers **Copy the sign-in link**, for when no browser
  appears.

The saved sign-in (`launcher-state.json` and the device token in the launcher's user-data
folder) is the one the Electron launcher wrote, so a player moving from it is not asked again.

## Platforms

| Build | Rust target | Engine | Runs on |
| --- | --- | --- | --- |
| Windows x64 | `x86_64-pc-windows-msvc` | AIR | Windows 10 and 11 |
| Windows ia32 | `i686-pc-windows-msvc` | Flash Player | 32-bit Windows 10 |
| Windows 7 x64 / ia32 | `x86_64-win7-windows-msvc` / `i686-win7-windows-msvc` | Flash Player | Windows 7, 8, 8.1 (and later) |
| macOS | `x86_64-apple-darwin` | AIR | macOS 10.15 and later; Apple Silicon runs it under Rosetta |
| Linux | `x86_64-unknown-linux-gnu` | AIR in Wine, Flash Player as Legacy | x86_64, AppImage or .deb |

The window is the system's web view: WebView2 on Windows, WKWebView on macOS, WebKitGTK on
Linux. The Windows 7 build runs on WebView2 109, the last version for Windows 7. If WebView2 is missing
when the launcher starts (the installer could not set it up, or another Windows account
installed it), the launcher offers to install it from Microsoft before it opens.

**32-bit Windows plays**: `flashplayer_32_sa.exe` is itself a 32-bit program in its own process,
so it runs on 32-bit and 64-bit Windows alike. The AIR engine is 64-bit, so the ia32 and
Windows 7 builds carry none and play Flash Player.

## Discord rich presence

Rich presence is served **by the launcher itself** (`src-tauri/src/presence.rs`). It listens on a
fixed local address (`http://127.0.0.1:47631/presence`), maps the player's state onto a Discord
activity — details, state, party size and join secret, level artwork, the discipline icon and a
`Play Game` button — and sends it over Discord's local RPC socket (`SET_ACTIVITY`). While the
game runs, the state comes from the game server's `/api/presence/self` (see
[What the launcher does for the game page](#what-the-launcher-does-for-the-game-page)). Party
joins from Discord are handed to the game server's `/api/presence/discord-join`.

Area artwork is matched by key: the key the server sends (`areaKey`, else `levelKey`) is matched
against the Rich Presence assets uploaded to the Discord application — every region
(`blackrosemire`, `castlehocke`, `cemeteryhill`, `emeraldglades`, `fellbridge`, `shazaridesert`,
`stormshardmountain`, `valhaven`, …), the level groups (`home`, `indungeon`, `newbieroad`,
`dungeon_blitz`) and the disciplines (`flameseer`, `frostbringer`, `justicar`, `mage`,
`necromancer`, `paladin`, `rogue`, `sentinel`, `shadowbringer`, `soulthieft`, `templar`,
`viperblade`). A key that matches nothing renders as *no* image on Discord, so an unknown key
falls back to the configured `indungeon` art — and `DUNGEON_BLITZ_LOG_PRESENCE=1` prints every
key, to spot names the asset list is missing.

`presence.config.json` holds the application id, port, artwork keys and the origins allowed
to push; a side-by-side game checkout's `discord-bridge.config.json` overrides it when
present. Discord does not have to be running to play — the launcher retries in the background
and the `Discord status` row says what is happening.

## Game chat, mirrored

Flash chat cannot be read from the launcher, so the game server publishes the player's own
public chat lines on a small feed and takes lines back for printing in game:

```text
GET  /api/chat/outbound?since=<cursor>   -> { cursor, messages: [{ senderName, message }] }
POST /api/chat/inbound                   -> prints "[Discord] name: message" in game
```

`src-tauri/src/chat_relay.rs` polls that feed while the game is open and posts each line to the
player's lobby; lobby chat comes back the other way and is printed in game. Only **the local
player's own** lines come down the feed, so a message is mirrored exactly once — by its author's
launcher — instead of once per player in the room, and each line is sent once even if the lobby
is briefly unavailable (the queue retries). A server without the feed answers 404 and the relay
stops asking. Disable it with `DUNGEON_BLITZ_CHAT_RELAY=0`.

## Discord widgets

A player's Game Stats widget is rendered from an *Application Identity Profile*, and the
only writer for one is `PATCH /applications/{app}/users/{user}/identities/{player}/profile`
with the application's **bot token**. A bot token inside a desktop app is a token anyone can
read out of the bundle, so the write stays on the game server and the launcher only asks for
it:

```text
POST /api/discord/stats/sync   { token }   -> { ok, written, username, updatedAt, fields }
```

Discord creates the profile record on the **first** write, so a widget that has never been
written is empty for everyone who looks at it -- the player and their friends alike. The
launcher asks once per game session, identified by the launcher token it resumed at launch,
and the `Game stats` row reports what came back: `profile written`; `no Discord account
linked` (the server answered `discord-not-linked`, or an HTTP 409); `server cannot write it`
(a 404 -- no such route yet); or `failed` with the server's own words. `Sync game stats`
under the status rows retries by hand, which is what a player does right after linking
inside the game. Disable all of it with `DUNGEON_BLITZ_GAME_STATS=0`.

Writing also needs the player's link to grant `application_identities.write`. The consent
dialog normally asks for it as part of the Social SDK scopes; if a write comes back
unauthorized, add it to `scopes` in `social.config.json` (an empty list keeps the default
`openid identify sdk.social_layer`). **The application must allow the scope in the
Developer Portal first** -- otherwise Discord rejects the whole authorize with
`invalid_scope`, which would take lobby chat down with it.

The portal half is not code, and it is where an invisible widget usually stops:

1. The game must be **claimed**; Game Stats Widgets are not offered otherwise.
2. Widget Top, Widget Bottom and Add Widget Preview each need a layout, and **Publish**
   unlocks only once all three have their required fields -- an unpublished widget is
   visible to developer-team members alone.
3. Testing a draft needs **Developer Mode** on, then Add Widget > Game Widgets > Add to
   profile, and a client refresh (`Cmd+R`): widget configs are cached per client session.
4. Every asset a field references must be **Public** on the Assets page. A non-public asset
   renders as a skeleton placeholder, which is what an empty widget looks like.

Until the server route exists the row reads `server cannot write it`, so a portal-side
problem and a data-side problem can be told apart without guessing.

## Remembered account

The launcher's own sign-in writes the account to `launcher-state.json`. A player who signed
in *inside the game* never touches that button, so the launcher also reads the account back
from the server (`GET /api/discord/account`, resolved from the connection asking — which is
why it is polled while a game session is up). Either way the next launch shows
`Signed in as <name>` instead of asking again; `Use a different account` clears it.

## Running from a disk image or Downloads

A copy opened straight out of a mounted `.dmg`, or from the Downloads folder it was
unzipped into, is a copy the next build will not replace — the quiet way a player ends up
on a launcher that no longer works. On macOS the launcher keeps a banner in the window and
offers `Move to Applications`: it copies itself with `ditto`, restarts from the new location
and exits (`src-tauri/src/install.rs`). A development build is never flagged.

## Discord lobby chat

Lobby chat is per-player: each player authorizes their own Discord account and joins the lobby
as themselves (`src-tauri/src/social.rs`). It starts with the game, not with the launcher, so
nothing asks for Discord authorization until the player opens the game.

Authorization happens **inside the Discord client**: `src-tauri/src/discord_ipc.rs` speaks
Discord's local RPC socket (`discord-ipc-0`), and its `AUTHORIZE` command raises Discord's own
consent dialog. The code it returns is swapped for a token with a PKCE verifier, so the
launcher never ships a client secret and never opens a browser. The token is cached in
`discord-social-token.json` (mode 0600) in the launcher's user-data folder — the launcher
never touches the macOS Keychain.

The lobby itself goes through Discord's HTTP lobby API: create-or-join by lobby secret,
linked-channel relay and message polling. Requirements: the application must allow the
`openid identify sdk.social_layer` scopes, and the player must have the Discord desktop client
running. `browserFallback: true` in `social.config.json` additionally enables the browser
flow, which then also needs the loopback redirect `http://127.0.0.1/callback` registered for
the application.

**The native Social SDK bridge** (`native_bridge/`, a mirror of the game server's bridge) is
optional, opt-in with `nativeBridge: true` in `social.config.json`. It needs the Discord Social
SDK, which is not redistributable and therefore not in this repository
(`native_bridge/discord_social_sdk/`), then `npm run build:bridge`. On Linux this also needs
`libasound2-dev` and `libpulse-dev`. No macOS build of the Social SDK exists. **`deviceFlow`
must stay off**: without device authorization allowed for the application, the SDK aborts the
whole process on a failed `CanAuthorizeDevice` check.

### Linking a lobby to your own channel

Linking a lobby to a Discord text channel is **per-player and off by default**, so a fresh
checkout never points at somebody else's channel. `social.config.json` ships both values
empty:

```json
{ "channelId": "", "enableChannelLinking": false }
```

To link your own, set your channel's ID and turn the feature on, then restart the launcher:

```bash
# right-click the channel -> Copy Channel ID
"channelId": "your-channel-id",
"enableChannelLinking": true
```

The channel has to be one the Discord application (the `appId` above) can see, and the link
only takes effect once the launcher holds a signed-in player token -- `src-tauri/src/social.rs` calls
`linkChannelToLobby` and then keeps the lobby's `linked_channel` in step. Discord caps these
calls hard while an application is unapproved (20 per 2 hours), which is why the launcher
only calls when the lobby's channel actually differs from yours.

`lobbySecret` may stay empty: it defaults to `launcher-<appId>`, and it is not a credential
-- Discord treats an activity carrying a `secrets` field as a joinable one and hides the
buttons behind Ask to Join, so this launcher deliberately never sends one.

If you have a checkout of the game repository next to this one, put the same keys in its
`src/server/discord-social-bridge.config.json` instead and they will override
`social.config.json` (see [the game repository](#optional-the-game-repository)).

## Running and packaging

```bash
cargo install tauri-cli --version "^2" --locked
npm run fetch-projector        # or: AIR_SDK_HOME=... npm run build-air
cd src-tauri
cargo tauri dev                # a debug build is treated as a checkout: no fingerprint checks
cargo tauri build              # installers in src-tauri/target/release/bundle/
```

The application icon comes from one source image, `build/icon.png` (1024×1024 with alpha).
`npm run make-icons` derives the rest from it on a Mac: `build/icon.icns`, `build/icon.ico`
(sizes 16–256), `renderer/assets/icon.png` and `renderer/assets/favicon.ico`. The ICO is
assembled in `tools/make-icons.js` rather than converted, because `sips` writes BMP rows
top-down and an ICO wants them bottom-up -- the generic conversion mistake that ships an
upside-down taskbar icon. All of it is committed, so packaging never needs to regenerate.

## Releases and updates

The launcher's version is the `version` in `src-tauri/tauri.conf.json`. To make a release,
raise it, then run the **Rust launcher** workflow by hand (Actions, Run workflow, on `main`).
It builds every installer on its own native runner and attaches them to one **draft** release
`v<version>`; it never publishes. Running it again for the same version replaces the draft's
installers; a published tag is refused.

| Platform | Files |
| --- | --- |
| Windows 10/11 | `...-win-x64-setup.exe` (64-bit), `...-win-ia32-setup.exe` (32-bit) |
| Windows 7, 8, 8.1 | `...-win7-x64-setup.exe`, `...-win7-ia32-setup.exe` |
| macOS | `...-mac-x64.dmg` |
| Linux | `...-linux-x86_64.AppImage`, `...-linux-amd64.deb` |

Updates are a **notice**: a few seconds after start and then every six hours, the launcher asks
GitHub for the latest *published* release (`src-tauri/src/update.rs`). When it is newer, the
Version row says so with a download button for this build's own file (picked by name, so keep
the names the workflow gives). Nothing is downloaded or installed by the launcher; the player
installs the new version over the old one. A draft is invisible to this check until it is
published. `DUNGEON_BLITZ_UPDATE_CHECK=0` turns the check off.

Packages are **unsigned**.

## Servers

Targets live in `servers.json`. There is no server picker in the UI; the launcher uses the
saved choice from `launcher-state.json` in the user data folder, or `defaultServerId`.

## Tests

```bash
cargo test --manifest-path src-tauri/Cargo.toml   # the launcher itself
npm test                                         # the window and the engine build tools
```

| Suite | What it pins down |
| --- | --- |
| `cargo test` | The launcher's Rust modules: state and config, presence mapping, sign-in, updates and the rest, against local stand-ins |
| `tools/test-launcher-status.js` | Every state of the status strip, the account row and the play button, in the window's own code |
| `tools/test-flash-preload.js` | The Linux Flash Player preload: how Flash Player is started with it, and its fingerprint |
| `tools/test-air-engine.js` | Finding the AIR bundle on each platform, its fingerprint, and the app descriptor's version |

`DUNGEON_BLITZ_LOG_PRESENCE=1` prints every presence push, to debug a live install without
editing it.

`.github/workflows/tests.yml` runs the Node suites on every push and pull request; the Rust
launcher workflow runs `cargo test` before it builds. `.github/workflows/flash-player.yml`
downloads and unpacks Flash Player on every platform whenever the lock file or the fetch
script changes.

## Developer mode: Create and Join

For people who work on the game, not for players: **Settings -> Developer mode** shows a
Developer panel (off by default, remembered as `devMode`). Everything in it plays in the AIR
engine, and none of it touches the player's sign-in, presence, lobby chat or the widget.

- **Create a server** runs a game server checkout on this machine as a test server
  (`src-tauri/src/dev.rs`): choose the repository's folder (or its `src/server`, with
  `npm install` done there), press **Create server**, and share the
  `https://....trycloudflare.com/web` address it shows. It needs Node 18 or later on PATH. It
  runs local mode on 8100 (web), 8180 (game) and 8181 (WebSocket) -- beside a normal
  `npm run dev` -- with no database, Discord, widget or health ping, and opens two Cloudflare
  quick tunnels to 8100 and 8181. The server's output goes to `dev-server.log` in the
  launcher's data folder; **Stop**, or quitting the launcher, ends the server and its tunnels.
  **Play on my server** plays it from here.
- **Join a server** plays one by the address someone shared (`src-tauri/src/dev_join.rs`).

A test server serves the SWF in local mode, so the game loads its files from `localhost:8000` and
opens raw sockets to `localhost:8080` (login) and `localhost:8180` (the world, named by the
enter-world packet). The launcher listens on those ports and carries them to the server: over
the tunnels for Join (the web tunnel over HTTPS, both game sockets over the WebSocket), or to
8100 / 8180 for the developer's own server. Port 843 answers Flash's socket policy.

`cloudflared` is not packaged. The first Create downloads the release pinned in
`src-tauri/src/dev.rs` from Cloudflare's GitHub releases into the launcher's data folder and
checks it against its pinned SHA-256; a mismatch is deleted and never run. Quick tunnels get
new addresses on every Create.

## Optional: the game repository

Only the server's own Social SDK settings (`discord-social-bridge.config.json`) and the
presence overrides (`discord-bridge.config.json`) come from a checkout of the game
repository. The launcher looks for it next to this one, and `DUNGEON_BLITZ_SERVER_ROOT`
overrides that. Without it the launcher uses its own `social.config.json` and
`presence.config.json`, which is what a packaged build does.

## Game window shortcuts

In Flash Player the window is Flash Player's own, so its shortcuts are Flash Player's:
`Ctrl+F` (`Cmd+F` on macOS) toggles full screen, `Esc` leaves it, and `Ctrl+Q` (`Cmd+Q`)
closes the game.

In AIR, `F11`, `Alt+Enter`, `Ctrl+F` (`Cmd+F`) and the button in the window's top-right corner
toggle full screen, and `Esc` leaves it. The game lays itself out to the full screen 1:1, as it
does in Flash Player, rather than being scaled up (`air/src/DungeonBlitzAir.as`).

## Security notes

- The launcher window loads only its own bundled page (`renderer/`); it navigates nowhere else
  and loads no remote content. Its only contact with the Rust side is the fixed set of calls in
  `src-tauri/src/shim.js`. The update download takes no URL from the window: the launcher opens
  only the GitHub link its own release check found.
- No window of the launcher hosts Flash. The game runs in the AIR engine or in Adobe's
  standalone Flash Player, each a separate program started on the selected server only. Flash
  Player is pinned in `projector.lock.json`; the engines are fingerprinted at build time.
- URLs are limited to `http`/`https`, and any carrying credentials are rejected.
