# Dungeon Blitz: R Launcher

A desktop launcher that plays Dungeon Blitz in the AIR engine -- the game in Adobe AIR's runtime,
which ships inside the launcher -- so players do not need a browser that still has Flash. The
builds AIR has no runtime for (Windows 32-bit, the Windows 7 build, Linux) play in Adobe Flash
Player 32, the standalone player, instead. It ships for Windows, macOS and Linux.

The launcher is a sign-in screen, not a control panel. It asks for one thing — sign in
with Discord — and once that is done it opens the game and connects to the server. A player who has signed in before is not asked again.

In the background it also connects the player's Discord lobby so lobby chat works,
publishes Discord rich presence, and mirrors the player's in-game chat into that lobby — in
both directions — for as long as the game is open. A damage meter, in a window of its own,
shows the player's DPS, damage per spell and rotation as they play.

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

## Game engine: AIR, and Flash Player where AIR has none

One build, one engine, and one **Open the game** button. Nothing is picked by the player:

| Build | Engine |
| --- | --- |
| Windows x64, macOS | AIR: the game in Adobe AIR's runtime (`lib/airEngine.js`, see [AIR engine](#air-engine)). These builds carry **no Flash Player**. |
| Windows ia32, the Windows 7 build, Linux | Adobe's standalone Flash Player 32 (`flashplayer_32_sa`, `lib/projector.js`), which AIR has no runtime for there |

An AIR build never looks for a Flash Player: `main.js` `preferredEngine()` is AIR wherever the
build carries the bundle, even one whose files were changed (it then says so and plays nothing),
and Flash Player only in a build with no AIR engine. The `chosenEngine` and `engine` keys older
launchers saved in `launcher-state.json` are dropped on the next write.

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

So the launcher has Flash Player ask (`lib/flashTimer.js`): for each game the 32-bit
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

So on Windows the launcher starts Flash Player on a loader file (`lib/loaderSwf.js`) instead
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
| Renderer | GPU when Chromium's GPU compositing is on and the adapter is not a software one (Microsoft Basic Render Driver, SwiftShader, llvmpipe); CPU otherwise | `gpu`, `cpu` |
| Quality | From the machine: 2 cores or under 4 GB is `low`, 4 cores or under 8 GB is `medium`, else `high`; capped at `medium` without a GPU | `high`, `medium`, `low` |

- Flash Player: GPU is direct rendering (auto keeps software off Windows, as before), CPU is
  software rendering. Low and medium quality are set by the loader file (`_quality`) before
  the game loads. `DB_FLASH_RENDER` still overrides the renderer. Linux keeps starting on the
  game's URL: its player fetches the game through the loader but never runs it, so the
  quality setting does not reach Flash Player there.
- AIR: the quality is passed to the AIR app (`--quality=`), which sets the stage quality.
- Picking CPU also turns off the launcher window's own GPU use, after a restart.

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
fetch on all three platforms whenever any of these change: the lock file, the fetch script,
or `lib/projector.js`. It also checks Adobe's signature on the downloaded player.

The package carries the player as an extra resource. A checkout can instead drop it in a
gitignored `projector/` folder at the repository root. The launcher also looks in the usual
install places and in Downloads, and the **Choose Flash Player...** button takes one by
hand. A new choice applies on the next game with no restart, because the player is started
fresh for every game.

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
  `vendor/flashpreload/linux/` (`npm run build-flash-preload`; `predist:linux` and the
  release workflow run it). It needs a C compiler and `readelf`.
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
  `/opt/Dungeon Blitz R`. What the player already preloads, such as MangoHud, is kept.
- `DUNGEON_BLITZ_FLASH_PRELOAD=0` starts Flash Player without them.

```bash
node tools/test-flash-preload.js
```

#### The window title

The AIR app titles its own window. In Flash Player the game window always reads **Dungeon Blitz: R**, never the game's address. Flash Player
names its own window, so how that is achieved differs by platform:

| Platform | Flash Player's own title | What the launcher does |
| --- | --- | --- |
| Windows | `Adobe Flash Player 32` | Renames the window to `Dungeon Blitz: R` through the Win32 API. It repeats this every second while the game runs, because Flash Player sets its title again on its own. |
| macOS | The full game URL | No app can rename another app's window. So Flash Player is started on a local file named `Dungeon Blitz: R` (`lib/loaderSwf.js`, written to the launcher's data folder before every game), whose only job is to load the game from the server. |
| Linux | `Adobe Flash Player 32,0,0,465` | Renames the window when `xdotool` is installed. Without it, the title stays Flash Player's own name. |

On macOS, Flash Player names the window after exactly what it was started on. That is why
the launcher runs it from the file's own folder, with just the name as the argument. A
macOS runner confirmed the result: the same game window and the same graphics, titled
`Dungeon Blitz: R`.

The `Flash Player` workflow repeats this check on Windows and macOS
(`tools/check-window-title.js`). It starts the game exactly as the launcher does, and
fails unless the window reads `Dungeon Blitz: R`.

#### What the launcher does for the game page

The projector loads only the SWF, not the game page, so the page's script does not run.
While the game is open, the launcher does that script's jobs itself (`lib/gameHost.js`):

- It polls `/api/presence/self` every 4 s and publishes rich presence.
- It measures latency to each game region and reports it to `/api/region-rtt`.

Sign-in needs nothing from the page:

- On a fresh connection, the server signs the game in from the pending hand-off that the
  saved launcher token recreates.
- If the game is already open when the player signs in, the OAuth callback signs that open
  connection in.

### A build without its engine

A **packaged** launcher always ships its own engine. One that can run neither the AIR engine nor
Flash Player refuses to start: it shows an error box naming the path it is running from and
quits, rather than leaving a player on a sign-in screen that leads nowhere. Set
`DUNGEON_BLITZ_ALLOW_NO_FLASH=1` to start one anyway.

Development checkouts are exempt from that refusal. There, a missing engine is one
`npm run build-air` (or `npm run fetch-projector`) away, and the launcher window says so.

The 1.0.3 macOS release shipped exactly that refusal dialog. The macOS build packaged an app
with no Flash in it, and the build check only printed a warning that nobody read. So
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
| `Version` | This launcher's version, and any update being downloaded, ready to install, or out with a download link |

Hovering a value shows the detail: the local presence endpoint, or the last error.

Machine and engine details are not rows. A missing, changed or unrunnable engine -- the build's
own, AIR or Flash Player -- or a Windows that is too old, is said in the problem banner above
the strip instead, and turns the play button off. It is shown after a cancelled sign-in and the
answer to a hand-picked Flash Player, and before an unreachable server or a launcher run from a
disk image. An AIR build says nothing about Flash Player at all. `main.js` prints the engine
lines on the console, and `node tools/test-launcher-status.js` checks every state of the strip,
the banner and the play button.

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
- `lib/airEngine.js` finds and starts the bundle; a packaged launcher checks it against
  `lib/air.integrity.json`, like Flash Player.

Building it needs the AIR SDK (free for personal use; download it from
https://airsdk.harman.com/download after accepting its license). ADT builds only for the system it
runs on. Windows and macOS only: the Linux AIR runtime runs only for commercially licensed
developers, so `build-air` refuses Linux and Linux packages play Flash Player.

```bash
AIR_SDK_HOME=/path/to/AIRSDK npm run build-air   # -> vendor/air/<platform>/
```

ADT signs the bundle with `DB_AIR_CERT` / `DB_AIR_CERT_PASS`, or a self-signed certificate it makes
once in `build/air/`.

Releases build it on the Windows x64 and macOS runners: `tools/fetch-air-sdk.js` downloads the SDK
pinned in `air-sdk.lock.json` (version and SHA-256 per platform) into `build/air-sdk/<platform>/`,
then `build-air` packages it, and those two runs fetch no Flash Player. The ia32, Windows 7 and
Linux installers ship Flash Player instead.

```bash
AIR_SDK_HOME=$(node tools/fetch-air-sdk.js | tail -1) npm run build-air
```

## Tamper resistance

An **installed** launcher refuses to be repurposed. A development checkout is exempt from
all of this.

- **Only its own Flash Player and AIR engine.** It runs only the engines it was installed
  with. It never uses a hand-picked file or a copy found elsewhere on the machine, so the
  **Choose Flash Player...** button is hidden.
- **Fingerprint check before every game.** At build time, `tools/fetch-projector.js`
  records a SHA-256 fingerprint of that Flash Player in `lib/projector.integrity.json`. That
  file is packed into the app's own code, not left next to the player.
  - The check covers every file in the macOS bundle, so an added library counts as a change.
  - A replaced or patched player is refused: the status strip reads
    `changed - reinstall`, and the game does not start.
  - The AIR engine is fingerprinted the same way, as one tree: the app and its AIR runtime,
    recorded by `tools/build-air.js` in `lib/air.integrity.json`. A changed or added file
    anywhere in it is refused.
- **No developer tools.** The launcher window has DevTools switched off, and any DevTools
  that open are closed again.
- **Electron fuses.** The build sets Electron's fuses (`build.electronFuses` in
  `package.json`), switches baked into the packaged Electron binary:
  - `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and the Node `--inspect` flags are ignored, so
    the launcher binary cannot be used as a plain Node runtime or started with injected code.
  - The app loads only from its `app.asar`, never from an `app` folder placed beside it.
  - On macOS and Windows, Electron checks `app.asar` against a hash recorded in the app
    (`Info.plist` on macOS, the executable's resources on Windows) and refuses to start if
    the archive was edited. Linux has no such check.
  - Cookie encryption is left off: the launcher keeps no cookies, and on an unsigned macOS
    build it would ask for Keychain access after every update.
- **No debugging or injected code.** A launcher started with a debugger (`--inspect`,
  `--remote-debugging-port`, `--js-flags`) or with `NODE_OPTIONS` loading code exits at
  start. The fuses already block the Node flags; this check also covers the Chromium
  switches no fuse controls.
- **The window stays on its own page.** No page can navigate the launcher window
  elsewhere, open a new window or embed a webview. Links go to the system browser.
- **CI checks the shipped copy.** The release workflow runs `tools/verify-projector.js` on the copies inside each finished package. A package whose own check would
  refuse to play therefore cannot be published.

**What this cannot stop.** Nothing running on the player's own machine can be made
impossible to manipulate; these checks raise the cost of doing it. In particular:

- **Patching the launcher's code.** The `app.asar` hash lives inside the app itself, so
  someone who edits the code can record a new hash too. Only code signing makes that
  edit show: a signed app whose `app.asar` or `Info.plist` changes fails its signature
  check. On Linux there is no `app.asar` check at all.
- **Unsigned installers.** Installers are unsigned unless the studio's certificates are
  configured (`CSC_LINK`, `CSC_KEY_PASSWORD`, and Apple notarization). Signing is what makes
  a modified installer show as untrusted to the player.
- **The game itself.** Flash Player or the plugin runs the SWF, and memory editors work on
  any process.
  What the game accepts is decided by the server: `src/server/core/anticheat` in the game
  repository.

## Electron version

The launcher window runs on Electron 41. It used to be pinned to Electron 11 (Chromium 87),
first because Chromium 87 was the last with the PPAPI Flash host, and later to keep Windows 7
and 8 running. Electron 11 had stopped getting security fixes, so the launcher moved to a
supported Electron and gave up Windows 7, 8 and 8.1, which Electron dropped in version 23.
Those now have a build of their own, the same launcher on Electron 22 (see
[Windows versions](#windows-versions)).

Discord's consent screen still opens in the player's own browser rather than inside the app,
because the launcher window loads no remote content. The launcher still sees the result:

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
- A server without this matches the browser and the launcher by address, as it always did.
- While a sign-in is pending, the window offers **Copy the sign-in link**. On Linux, Electron
  reports the browser as opened even when `xdg-open` failed, so this is the way through when
  no browser appears.

## Binaries: `payload/` and `vendor/`

| Folder | What | In git |
| --- | --- | --- |
| `payload/` | The prebuilt Discord Social SDK bridges | Yes, via Git LFS |
| `vendor/` | Build output — what packaging reads | No, gitignored |

```text
vendor/projector/<platform>/  flashplayer_32_sa.exe | Flash Player.app | flashplayer   (tools/fetch-projector.js)
vendor/air/<platform>/        DungeonBlitzR/ | DungeonBlitzR.app (captive AIR bundle)      (tools/build-air.js)
vendor/social/<platform>/     discord_social_bridge[.exe] + the SDK runtime library   (tools/stage-vendor.js)
```

### macOS is x64 only

The package is an x64 Electron app, and Flash Player for macOS is an Intel binary. Apple
Silicon runs both under Rosetta, and CI builds on the Intel runner. Electron needs macOS 12
(Monterey) or later.

### 32-bit Windows

The Windows targets build `ia32` as well as `x64`, so the releases page carries
`-win-ia32-setup.exe` and `-win-ia32-portable.exe`. **They play**: `flashplayer_32_sa.exe`
is itself a 32-bit program in its own process, so it runs on 32-bit and 64-bit Windows
alike. The AIR engine is 64-bit, so the ia32 packages carry none and play Flash Player.

Up to 1.0.16, the 32-bit installers opened and then refused to play. The game ran in an
x86_64 PPAPI plugin loaded *into* the launcher process, and a 32-bit process cannot load
that. That refusal is gone with the plugin. `lib/windowsSupport.js` now refuses only an
architecture there is no build of at all (arm64 Windows running an arm64 build). That
refusal names the exact x64 installer to download instead.

The ia32 run still never publishes an update manifest (see "Why Windows is built as two
runs"), so `latest.yml` only ever names the x64 installer, and that one quits on 32-bit
Windows. The ia32 builds therefore do not self-update: they get the update notice described
under "Auto-update", which links the new ia32 installer (or portable .exe).

### Windows versions

Electron runs on Windows 10 and later only: it dropped Windows 7, 8 and 8.1 in version 23. So
every Windows release comes in two builds of the same launcher:

| Build | Files | Electron | Windows |
| --- | --- | --- | --- |
| Main | `...-win-x64-*`, `...-win-ia32-*` | 41 | 10 and 11 |
| Windows 7 | `...-win7-x64-*`, `...-win7-ia32-*` | 22, the last that runs on Windows 7 | 7, 8, 8.1, 10 and 11 |

Both play the current game the same way: same code, same servers, same sign-in, and the same
engine: Flash Player 32, which runs on Windows 7 (its builds carry no AIR). The Windows 7 build is `build/win7.config.js`: package.json's `build` with
Electron 22, `win7` in the file names and its own installer check. Vista and XP have no
Electron at all and are refused by both.

What the Windows 7 build gives up:

- **Security fixes.** Electron 22 stopped getting them in 2023. The launcher window loads no
  remote content, but players on Windows 10 or 11 should take the main build.
- **Self-updating.** It gets the update notice instead (see "Auto-update").
- **Discord lobby chat, maybe.** The Discord Social SDK bridge is the same binary in both builds
  and has not been tried on Windows 7; Discord itself no longer supports Windows 7. When the
  bridge cannot start, lobby chat is off and the game plays as usual.

The launcher knows which build it is from its own runtime: an Electron of 22 or older is the
Windows 7 build (`isLegacyWindowsBuild()` in `lib/windowsSupport.js`), which then takes Windows
7 as its floor. The main build refuses Windows 7, 8 and 8.1 by name, with a dialog that names
the exact `win7` setup file to download instead; on those machines Electron 41 usually fails
before any launcher code runs, so the installer says it too. `node tools/test-windows-support.js`
walks the whole matrix, for both builds, from any machine: `os.release()` and the Electron
version are parameters, not calls. The test workflow also runs every suite on Node 16, the
Windows 7 build's.

The main setup installers refuse Windows 7, 8 and 8.1 before they touch anything
(`build/installer.nsh`, wired in through `build.nsis.include`); the Windows 7 build's refuse
only Windows older than 7 (`build/installer-win7.nsh`). That matters for launchers already
installed there. 1.1.0 still auto-updates (electron-updater 4.3.9, download in the background,
install on quit) from `latest.yml`, which names the main x64 setup. Without the check it would
replace itself with a launcher that cannot start. Here is what a Windows 7/8 player on 1.1.0
sees:

- The status strip shows the download as usual (`downloading 1.x.y - 42%`, then `1.x.y
  ready - restart to install`). 1.1.0 cannot tell that the release will not run there.
- **Restart to update** closes the launcher and opens the installer, which says *"Dungeon
  Blitz R 1.x.y needs Windows 10 or later. Nothing was installed or changed"*, names the
  `win7-x64` setup for this version and offers to open the releases page.
- Quitting without clicking runs the same installer silently (`/S`). It exits at once and
  nothing is shown, opened or changed.
- The `win7` setup has the same appId, so it installs over 1.1.0 in place and keeps its
  shortcuts and its saved sign-in. From then on that player gets the update notice for `win7`
  files.

The main portable `.exe` has no installer and no check, so on Windows 7/8 it just fails to
start, like Electron does. The release notes say which files are for which Windows (`body` in
the release job), so a player who checks the releases page finds out before downloading.

## Discord rich presence

Rich presence is served **by the launcher itself** (`lib/presence.js`). The game page
pushes its state to a fixed local address (`http://127.0.0.1:47631/presence`), and the
launcher maps that onto a Discord activity — details, state, party size and join secret,
level artwork, the discipline icon and a `Play Game` button — and sends it over the same
RPC socket the sign-in uses (`SET_ACTIVITY`). Party joins from Discord are handed to the
game server's `/api/presence/discord-join`.

That endpoint is the same one the game server's own bridge exposes, so the page needs no
changes. The launcher does it itself because a packaged build cannot use the server's
bridge at all: the server checkout is not inside the app. On Electron 11 the bridge also
could not load its dependencies (express 5 needs Node 18 and `node:`-prefixed builtins,
and Electron 11 carried Node 12). It used to be spawned with its output discarded, so it
died silently and presence never appeared.

Area artwork comes from `LEVEL_AREA_IMAGE_KEYS` in `lib/presence.js`: the key the game page
pushes (`areaKey`, else `levelKey`) is matched against the Rich Presence assets uploaded to
the Discord application — every region (`blackrosemire`, `castlehocke`, `cemeteryhill`,
`emeraldglades`, `fellbridge`, `shazaridesert`, `stormshardmountain`, `valhaven`, …), the
level groups (`home`, `indungeon`, `newbieroad`, `dungeon_blitz`) and the disciplines
(`flameseer`, `frostbringer`, `justicar`, `mage`, `necromancer`, `paladin`, `rogue`,
`sentinel`, `shadowbringer`, `soulthieft`, `templar`, `viperblade`). A key that matches
nothing renders as *no* image on Discord, so an unknown key falls back to the configured
`indungeon` art — and `DUNGEON_BLITZ_LOG_PRESENCE=1` prints every key the page sends, to
spot names the asset list is missing.

`presence.config.json` holds the application id, port, artwork keys and the origins allowed
to push; a side-by-side game checkout's `discord-bridge.config.json` overrides it when
present, so an existing bridge setup keeps working. Discord does not have to be running to
play — the bridge retries in the background and the `Discord status` row says what is
happening.

```bash
node tools/test-presence.js   # publish, dedupe, origin refusal and clearing, against a mock Discord socket
```

## Game chat, mirrored

Flash chat cannot be read from the launcher and the server's relay needs either the native
Social SDK (no macOS build) or a bot token, so the game server publishes the player's own
public chat lines on a small feed and takes lines back for printing in game:

```text
GET  /api/chat/outbound?since=<cursor>   -> { cursor, messages: [{ senderName, message }] }
POST /api/chat/inbound                   -> prints "[Discord] name: message" in game
```

`lib/chatRelay.js` polls that feed while the game window is open and hands each line to the
social bridge, which posts it to the player's lobby; lobby chat comes back the other way
and is printed in game. Only **the local player's own** lines come down the feed, so a
message is mirrored exactly once — by its author's launcher — instead of once per player in
the room, and each line is sent once even if the lobby is briefly unavailable (the queue
retries). A server without the feed answers 404 and the `In-game chat` row says so, rather
than polling forever. Disable it with `DUNGEON_BLITZ_CHAT_RELAY=0`.

```bash
node tools/test-chat-relay.js   # relay, dedupe, queueing and unsupported servers, against a local mock
```

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

```bash
node tools/test-game-stats.js   # written, unlinked, unauthorized and unsupported servers
```

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

## Damage meter

`Damage meter`, under the status strip once an account is known, opens a window to keep
beside the game: a timer and DPS, damage per spell (what it scales with, crits, damage over
time, which crits set off a rune proc), the cast rotation (`MA2 s2 s3 RA1 s4`), Dungeon mode
(one run per dungeon: it pauses when the player dies or a boss falls, ends at 100% or Level
Complete, and counts the gold gained), and exports: `dbb-dps` JSON for the DPS Calculator, or
CSV for a spreadsheet. `F6` starts or stops the timer and `F7` resets it while the window has
focus; `Keep on top` holds it above the game.

The meter is DB DPS Launcher's ([db-dpsmod](https://github.com/killssingkurisu/db-dpsmod), MIT):
`lib/damageMeter` carries its packet reading, meter and export files unchanged, so a fix there
can be copied across whole, and the window's page is its in-game overlay on a page of its own.

The launcher never sees the game's traffic -- AIR and Flash Player talk to the
server themselves -- so, as with chat, the game server publishes what the meter needs on a
feed and the launcher reads it: about twice a second, and only while the meter's window is
open during a game session, so a player who never opens it costs the server nothing. Nothing
on the player's machine is read, patched or redirected:

```text
GET /api/combat/outbound[?since=<cursor>]     X-Launcher-Token: <the launcher token>
  200 { cursor, now, level, backlog, data, packets: [{ seq, at, dir, id, data }] }
  404 { "reason": "no-game-session" }    the feed is there; no game session for this caller yet
  404 (anything else)                    no feed on this server, which the meter window says
```

The token is the launcher token `/api/discord/stats/sync` takes in its body; a GET has no body,
and a header keeps it out of URLs and logs. The server finds the caller's game session from
it, and answers a missing or unknown token like a caller with no game session (`401` or `403`
also work: the meter window then says the server did not accept the sign-in).

- `packets` are the caller's own game session's, across all its connections, oldest first:
  `dir` is `"up"` for a packet the client sent and `"down"` for one the server sent it, `id`
  the packet type, `data` the payload in base64 (the bytes after the 4-byte header, exactly as
  they passed on that connection, entity ids and all), `at` the server's clock when it passed,
  in Unix epoch milliseconds, and `seq` a number that only goes up for the whole session,
  across levels.
- `cursor` is a string of the server's choosing; the next request passes it back as `since`
  and gets what came after it.
- `now` is the server's clock as it answers, in Unix epoch milliseconds. The meter plays
  packets back a second behind it, spaced as they happened, so a batch that arrives at once
  still times every hit right.
- An answer without `since` has `backlog: true`, `level` -- the level the player is in, by its
  LevelTypes name (`GoblinRiverDungeon`) -- and the packets the player's current connection has
  carried so far, from their arrival in the level. They tell the meter who the player is and
  what is around them, and none of them are counted, so a backlog can leave out casts, hits and
  ticks and should: every `0x08` and `0x0F`, and the `0x07` that changed a state (below), is
  enough. When a `since` is too old to answer, a backlog makes the meter start over the same
  way. After the backlog, `level` is not read again: enter world (`0x21`) in the stream says
  when the player moves on.
- `data`, optional, names the game's data files -- `{ "game": "/p/cbq/Game.swz", "login":
  "/p/cbp/Login.swz" }` -- for spell names, ranks and scaling, and which monsters are bosses.
  Only files on the game server itself are fetched; without them the meter uses the snapshot
  in `lib/damageMeter/data`.

The packets the meter reads; everything else can be left out:

| Packet | Up (client to server) | Down (server to client) |
| --- | --- | --- |
| `0x08` entity full update | everything the client runs: the player's character (and its id), its summons, and the monsters it runs, with names and teams | |
| `0x0F` newly relevant entity | | names and teams of what comes into view |
| `0x07` incremental update | entity state: a death, a revive, a boss dying | the same |
| `0x09` power cast | casts | |
| `0x0A` power hit | hits, crits, rune procs | |
| `0x79` damage-over-time tick | ticks | ticks on monsters another player's client runs |
| `0x35` receive gold | | gold gained |
| `0x21` enter world | | the next level, which comes on a new connection |
| `0xB7` level completion | how much of the dungeon is cleared | the same |
| `0x3F` set level complete | Level Complete | |
| `0x87` receive level complete | | Level Complete |

`0x07` comes many times a second for everything that moves. The meter needs, for each entity,
only the first one after its `0x08` or `0x0F` and every one whose state (the 2 bits after id,
dx, dy and dvx) differs from the one before; sending them all works too, at more traffic. An
answer can be up to 16 MB.

Turn the meter off with `DUNGEON_BLITZ_DAMAGE_METER=0`.

```bash
node tools/test-damage-meter.js   # the feed against a mock server: backlog, playback, a new level, exports
```

## Remembered account

The launcher's own sign-in writes the account to `launcher-state.json`. A player who signed
in *inside the game* never touches that button, so the launcher also reads the account back
from the server (`GET /api/discord/account`, resolved from the connection asking — which is
why it is polled while a game session is up) and against the social bridge's own Discord
identity. Either way the next launch shows `Signed in as <name>` instead of asking again;
`Use a different account` clears it.

## Running from a disk image or Downloads

A copy opened straight out of a mounted `.dmg`, or from the Downloads folder it was
unzipped into, is a copy the next build will not replace — the quiet way a player ends up
on a launcher that no longer works. The launcher warns once at startup, keeps a banner in
the window, and offers `Move to Applications`: it copies itself with `ditto`, restarts from
the new location and exits. A development checkout is never flagged.

```bash
node tools/test-install-location.js
```

## Discord Social SDK bridge

`native_bridge/` is a mirror of the game server's bridge sources. The launcher runs the
compiled bridge as a child process and speaks the same newline-delimited JSON protocol the
server uses:

```text
launcher -> bridge : initialize | outbound_chat | use_lobby | link_channel
bridge -> launcher : ready | auth | status | chat | lobby_ready |
                     channel_linked | channel_link_failed | send_result
```

Running it here rather than on the server is what makes lobby chat per-player: each player
authorizes their own Discord account and joins the lobby as themselves. The bridge runs
headless — lobby chat and the party roster are read in Discord's own client.

Building it needs the Discord Social SDK (headers plus the platform library) at
`native_bridge/discord_social_sdk/`, which is not redistributable and therefore not in this
repository:

```bash
npm run build:bridge
```

On Linux this also needs `libasound2-dev` and `libpulse-dev` — the SDK links against ALSA
and PulseAudio. Copy the result into `payload/social/<platform>/`.

**No macOS build of the Social SDK exists.** On darwin (and wherever the native binary is
absent) the launcher falls back to a built-in JavaScript driver — `lib/socialJs.js` over
`lib/socialRest.js`, modelled on `@minesa-org/mini-interaction`'s `DiscordRestClient` —
which speaks the same protocol events to Discord's HTTP lobby API: create-or-join by
lobby secret, linked-channel relay and message polling. It starts with the game, not with
the launcher, so nothing asks for Discord authorization until the player opens the game.

Authorization happens **inside the Discord client**: `lib/discordIpc.js` speaks Discord's
local RPC socket (`discord-ipc-0`), and its `AUTHORIZE` command raises Discord's own
consent dialog. The code it returns is swapped for a token with a PKCE verifier, so the
launcher never ships a client secret and never opens a browser. The token is cached in
`discord-social-token.json` (mode 0600) in the launcher's user-data folder — the launcher
never touches the macOS Keychain.

Requirements: the application must allow the `openid identify sdk.social_layer` scopes,
and the player must have the Discord desktop client running. `browserFallback: true` in
`social.config.json` additionally enables the browser flow, which then also needs the
loopback redirect `http://127.0.0.1/callback` registered for the application.

```bash
node tools/test-social-bridge.js   # Discord-client and browser auth against local mocks
node tools/test-discord-ipc.js     # the RPC client itself, against a mock Discord socket
```

**`deviceFlow` must stay off.** The device path requires the Discord application to allow
device authorization; without it the SDK does not return an error, it aborts the whole
process on a failed `CanAuthorizeDevice` check. The browser PKCE flow needs no such
capability.

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
only takes effect once the launcher holds a signed-in player token -- `lib/socialJs.js` calls
`linkChannelToLobby` and then keeps the lobby's `linked_channel` in step. Discord caps these
calls hard while an application is unapproved (20 per 2 hours), which is why the launcher
only calls when the lobby's channel actually differs from yours.

`lobbySecret` may stay empty: it defaults to `launcher-<appId>`, and it is not a credential
-- Discord treats an activity carrying a `secrets` field as a joinable one and hides the
buttons behind Ask to Join, so this launcher deliberately never sends one.

If you have a checkout of the game repository next to this one, put the same keys in its
`src/server/discord-social-bridge.config.json` instead and they will override
`social.config.json` (see [the game repository](#optional-the-game-repository)) -- that file
is where a shared setup belongs, since it is not part of this repository.

## Running and packaging

```bash
npm install && npm run fetch-projector && npm start
```

```bash
npm run dist:win
npm run dist:win7     # the Windows 7 build, on Electron 22 (dist:win7:ia32 for 32-bit)
```

`dist:win` and `dist:mac` are AIR packages: run `npm run build-air` first (see
[AIR engine](#air-engine)); `tools/preflight.js --engine air` fails the build without the bundle,
or with a Flash Player left in `vendor/projector/<platform>/` from another build (delete it).
The other `dist:` scripts first fetch Flash Player for their platform
(`tools/fetch-projector.js`) and fail without it. For a deliberately Flash-less Flash package,
set `DUNGEON_BLITZ_PREFLIGHT_ALLOW_NO_FLASH=1`.

The application icon comes from one source image, `build/icon.png` (1024×1024 with alpha).
`npm run make-icons` derives the rest from it on a Mac: `build/icon.icns` (macOS app, dock
and dmg), `build/icon.ico` (Windows and Linux, sizes 16–256), `renderer/assets/icon.png`
(what the windows and the Linux dock load at runtime) and `renderer/assets/favicon.ico`
(the sign-in page's tab icon). The ICO is assembled in `tools/make-icons.js` rather than
converted, because `sips` writes BMP rows top-down and an ICO wants them bottom-up -- the
generic conversion mistake that ships an upside-down taskbar icon. All of it is committed,
so packaging never needs to regenerate.

Output lands in `dist/`. What can be built where:

| Target | On Windows | On Linux (incl. WSL) | On macOS |
| --- | --- | --- | --- |
| `nsis` / `portable` | yes, needs Developer Mode | no | no |
| `AppImage` / `deb` | no (symlinks) | yes | yes |
| `zip` (mac, unsigned) | no (symlinks) | yes | yes |
| `dmg` | no | no | yes |

### Symlink privilege on Windows

electron-builder's `winCodeSign` package and the AppImage icon step both create symbolic
links, which an ordinary Windows account may not do. With Developer Mode off, `dist:win`
and `dist:linux` fail with a privilege error. Either turn on Settings → System → For
developers → Developer Mode, or build Windows unsigned:

```bash
npm run dist:win -- --dir --config.win.signAndEditExecutable=false
```

### GitHub Actions

Bumping `version` in `package.json` on `main` is what cuts a release.
`.github/workflows/release.yml` then builds on three native runners, stages the binaries,
downloads Flash Player (checked against `projector.lock.json`), runs the preflight (a missing
engine fails the job), runs electron-builder, checks that it made it into the package intact, and attaches the installers to a draft GitHub release tagged
`v<version>`:

| Platform | Files |
| --- | --- |
| Windows | `...-win-x64-setup.exe` (64-bit Windows; auto-updates), `...-win-x64-portable.exe`, `...-win-ia32-setup.exe` (32-bit Windows), `...-win-ia32-portable.exe` (all but the x64 setup get an update notice) |
| Windows 7, 8, 8.1 | `...-win7-x64-setup.exe`, `...-win7-x64-portable.exe`, `...-win7-ia32-setup.exe`, `...-win7-ia32-portable.exe` (Electron 22; update notice) |
| macOS | `...-mac-x64.dmg`, `...-mac-x64.zip` |
| Linux | `...-linux-x86_64.AppImage`, `...-linux-amd64.deb` |

### Why Windows is built as two runs

electron-builder emits a **universal** installer whenever one invocation packages more
than one architecture. Splitting `build.win.target` into separate one-architecture entries
does not prevent it -- `NsisTarget.finishBuild()` always adds the combined build
(`builds = new Set([this.archs])`) and only *additionally* builds per-architecture
installers when the artifact name contains `${arch}`:

```js
const builds = new Set([this.archs]);                       // always, all arches together
if (pattern.includes("${arch}") && this.archs.size > 1) {   // and each one on its own
  [...this.archs].forEach(([arch, appOutDir]) => builds.add(new Map().set(arch, appOutDir)));
}
```

So 1.0.12 shipped three packages per target -- `win-x64-*`, `win-ia32-*` and a ~135 MB
`win-setup.exe` carrying both -- and `latest.yml` pointed at the universal one, making
every x64 player updating from 1.0.11 download roughly twice what they needed.

The fix is one electron-builder run per architecture, which is why `package.json` only
configures x64 and the workflow has a separate Windows ia32 matrix entry. Three details
that each cost a release to learn:

- **Splitting the config's target entries does nothing.** The arches accumulate in one
  *invocation* regardless of how `build.win.target` is written.
- **`--win --ia32` does not override `build.win`.** The flag says which arches are
  *requested*; the config still contributes x64, so the run packages both and rebuilds
  the universal (1.0.14 did this). The per-target suffix does override it:
  `--win nsis:ia32 portable:ia32`.
- **`latest.yml` is not per-architecture on Windows.** `getArchPrefixForUpdateFile()` adds
  an arch suffix only on Linux, so both Windows runs write the same filename and whichever
  finishes last owns it. The ia32 run uses `--publish never` and drops its manifest, so an
  x64 player can never be offered a 32-bit installer.

The Windows 7 build (`--config build/win7.config.js`) is the same pair of runs again, also
with `--publish never` and no manifest. All four Windows jobs upload distinct artifact names
(`launcher-win32-x64-main`, `launcher-win32-ia32-main`, `launcher-win32-x64-win7`,
`launcher-win32-ia32-win7`); sharing one name makes the second upload fail.

The `win-ia32` files play; see "32-bit Windows" above.

Editing `package.json` without changing the version builds nothing; the workflow compares
against the previous commit first. A manual run builds the current version, and only
publishes when `publish` is ticked.

Packages are **unsigned**. Signing needs `CSC_LINK` and `CSC_KEY_PASSWORD` for Windows and
macOS, plus `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` for notarization.

## Auto-update

An installed launcher updates itself on the Windows x64 installer and the Linux AppImage
and .deb; macOS and the portable and 32-bit Windows builds get a notice with a download
link instead (see the table below). `lib/update.js` wraps electron-updater with GitHub
releases as the feed (`build.publish` in package.json): it checks a few seconds after
start and then every six hours, downloads a new version in the background and shows an
`Update` row in the status strip -- `downloading 1.1.0 - 42%`, then `1.1.0 ready -
restart to install` with a **Restart to update** button. There is no manual check button:
the schedule above is the only way a check is triggered, so a player waiting on a release
waits for the next six-hour tick (or the update lands on quit). Nothing forces the restart
while the game might be open; if the player ignores the prompt, the update still installs on
the next quit (`autoInstallOnAppQuit`). Dev checkouts and dev AppImages never self-update.

Two feed rules are easy to trip over: the release job uploads the `latest*.yml` metadata
alongside the installers (`--publish always`), and the draft release must be **published**
before any installed launcher sees it -- GitHub's update provider cannot read a draft.
`npm run test-updater` pins the state machine against a fake updater, no Electron or
network.

Not every build can replace itself, so which one does what is decided at start
(`updateRoute()` in `lib/updateNotice.js`):

| Build | Updates by |
| --- | --- |
| Windows x64 setup | electron-updater: download, then **Restart to update** or on quit |
| Linux AppImage | electron-updater, in place |
| Linux .deb | electron-updater's DebUpdater (`dpkg -i` behind a password prompt) |
| macOS .dmg / .zip | a notice: Squirrel.Mac only installs over a signed app, and these are unsigned |
| Windows portable .exe (x64, ia32) | a notice: the updater would install the x64 setup beside it instead |
| Windows ia32 setup | a notice: `latest.yml` only names the x64 setup, which refuses 32-bit Windows |
| Windows 7 build (`win7`, setup or portable) | a notice for its own `win7` file: `latest.yml` names the main setup, which refuses Windows 7 |

The notice keeps the same schedule. It asks GitHub's API for the latest published release
of the repository in `build.publish` (an installed launcher reads it from electron-builder's
`app-update.yml`, since the packed package.json has no `build`), and when that is newer the
Version row reads `v1.5.0 - launcher 1.6.0 is available` with a **Download 1.6.0** button.
The button opens this build's own file in the browser -- the .dmg, or the
`win-<arch>-portable.exe` / `win-ia32-setup.exe`, or the Windows 7 build's
`win7-<arch>-setup.exe` / `-portable.exe` -- or the release page if that file is
missing; the player installs it over the old copy. Nothing is downloaded by the launcher,
and an offline moment or a rate limit is only logged and retried at the next check. The
main process opens only the link the check itself produced, whatever the window asks.
`tools/test-update-notice.js` pins the routes, the version compare, the file picked for each
build and the quiet failures against a fake `fetch`. The check goes through Electron's own
network stack (so a system proxy applies): `net.fetch`, or on the Windows 7 build's Electron
22, which has none, the same GET over `net.request` (`electronFetch()`).

On Windows the update is the NSIS setup installer. electron-updater runs it with
`--updated --force-run` after **Restart to update** and with `--updated /S` on quit. That
installer refuses Windows 7, 8 and 8.1 before it uninstalls anything, so a 1.1.0 launcher
there keeps working, and points that player to the `win7` setup. "Windows versions" above
describes what that player sees.

## Servers

Targets live in `servers.json`. There is no server picker in the UI; the launcher uses the
saved choice from `launcher-state.json` in the user data folder, or `defaultServerId`.

## Tests

```bash
npm test
```

Two environment switches help debug a live install without editing it:

```bash
DUNGEON_BLITZ_LOG_PRESENCE=1   # every presence push: payload, area key, dedupe decisions
DUNGEON_BLITZ_LOG_NETWORK=1    # every Discord API call the lobby bridge makes, with results
```

Every suite runs without Electron, Discord, a game server or a Flash Player binary: each
drives the module against a local mock.

| Suite | What it pins down |
| --- | --- |
| `tools/test-presence.js` | Activity mapping, dedupe, origin refusal, clearing, against a mock Discord socket |
| `tools/test-chat-relay.js` | Own-chat mirroring once, queueing while the lobby is down, inbound printing, unsupported servers |
| `tools/test-social-bridge.js` | Discord-client and browser authorization paths, lobby join, two-way chat |
| `tools/test-discord-ipc.js` | The RPC framing, `AUTHORIZE` payload and PING/PONG |
| `tools/test-launcher-status.js` | Every state of the status strip, the account row and the play button |
| `tools/test-damage-meter.js` | The combat feed against a mock server: no feed, no session, the backlog, playback at the pace of play, a new level, game data fetched from the game server only, exports and settings |
| `tools/test-install-location.js` | Disk-image and Downloads detection, and what is deliberately not flagged |
| `tools/test-windows-support.js` | Which Windows versions and architectures start, and how the others are refused |
| `tools/test-projector.js` | Finding Flash Player, the SWF it opens, the pinned downloads, its fingerprint, and the presence and region-latency work done for the game page |
| `tools/test-engine.js` | `main.js` itself, with Electron stubbed: an AIR build plays AIR whatever was saved or asked for and never looks for a Flash Player, a build without AIR plays Flash Player, the old engine picks are dropped, and developer mode refuses everything until it is switched on |
| `tools/test-air-engine.js` | Finding the AIR bundle on each platform, how it is started, its fingerprint, and the app descriptor's version |
| `tools/test-dev-join.js` | Developer Join: share addresses, the two tunnels a shared address names, both game sockets over the WebSocket (against a stand-in), the policy answer, local mode, and a port already in use |
| `tools/test-dev-server.js` | Developer Create: the checkout and how it starts, the test-server environment, the Node check, the pinned cloudflared, the quick tunnel's ready rule, and a refused Create |
| `tools/test-updater.js` | The electron-updater state machine, the restart gate and the check cadence |
| `tools/test-update-notice.js` | Which builds self-update and which get a notice, the release feed, the download each build is offered, and quiet failures |
| `tools/test-discord-login-key.js` | The Discord sign-in's one-time key: only its hash in the browser URL, the key in a header, and a login finished at another address still reaching the launcher |

`.github/workflows/tests.yml` runs them on every push and pull request, so a broken Flash
guard, presence mapping or chat relay fails before an installer is built.
`.github/workflows/flash-player.yml` downloads and unpacks Flash Player on Windows and Linux,
the platforms whose builds still carry it, whenever the lock file or the fetch script changes.

## Developer mode: Create and Join

For people who work on the game, not for players: **Settings -> Developer mode** shows a
Developer panel (off by default, remembered as `devMode`). Everything in it plays in the AIR
engine, and none of it touches the player's sign-in, presence, lobby chat or the widget.

- **Create a server** runs a game server checkout on this machine as a test server
  (`lib/devServer.js`): choose the repository's folder (or its `src/server`, with `npm install`
  done there), press **Create server**, and share the `https://....trycloudflare.com/web`
  address it shows. It needs Node 18 or later on PATH. It runs local mode on 8100 (web),
  8180 (game) and 8181 (WebSocket) -- beside a normal `npm run dev` -- with no database, Discord,
  widget or health ping, and opens two Cloudflare quick tunnels to 8100 and 8181. A checkout
  with its own `src/server/start-test-server.js` is started through it. The server's output
  goes to `dev-server.log` in the launcher's data folder; **Stop**, or quitting the launcher,
  ends the server and its tunnels. **Play on my server** plays it from here.
- **Join a server** plays one by the address someone shared (`lib/devJoin.js`).

A test server serves the SWF in local mode, so the game loads its files from `localhost:8000` and
opens raw sockets to `localhost:8080` (login) and `localhost:8180` (the world, named by the
enter-world packet). The launcher listens on those ports and carries them to the server: over
the tunnels for Join (the web tunnel over HTTPS, both game sockets over the WebSocket, since the
server lets a world entry be redeemed only from the address that logged in), or to 8100 / 8180
for the developer's own server. Port 843 answers Flash's socket policy.

`cloudflared` is not packaged. The first Create downloads the release pinned in
`lib/cloudflared.js` from Cloudflare's GitHub releases into the launcher's data folder and
checks it against the SHA-256 GitHub publishes for it; a mismatch is deleted and never run.
Quick tunnels get new addresses on every Create.

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

## Security notes

- The launcher shell runs sandboxed, with `contextIsolation: true`,
  `nodeIntegration: false` and plugins disabled; its only contact with the main process is the fixed set of IPC calls in
  `preload.js` (state, sign-in, forget, play, choose Flash Player, move to Applications,
  open the damage meter, restart to update, open the update download, relaunch, quit) and
  it loads no remote content at all. The update download takes no URL from the window: the
  main process opens only the GitHub link its own release check found.
- The damage meter's window is locked down the same way, with a preload of its own
  (`lib/damageMeter/preload.js`) that has two calls: a command to the meter, and the view it
  sends back. The main process takes commands from that window only. The meter reads the
  combat feed of the player's own game session and the game's data files from the game
  server, and nothing else; it does not touch the game, its files or its traffic.
- No window of the launcher hosts Flash. The game runs in the AIR engine or in Adobe's
  standalone Flash Player, each a separate program started on the selected server only. Flash
  Player is pinned in `projector.lock.json`; the AIR bundle is fingerprinted at build time.
- URLs are limited to `http`/`https`, and any carrying credentials are rejected.
