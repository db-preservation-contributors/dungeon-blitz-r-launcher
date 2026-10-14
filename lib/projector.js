'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { URL } = require('url');

const {
    macBundleExecutable,
    parseBinaryArchitectures,
    versionFromMacBundle,
    versionFromWindowsMetadata
} = require('./binary');
const { verifyTree } = require('./integrity');

// The game engine: Adobe's standalone Flash Player (the "projector",
// flashplayer_32_sa.exe and its macOS and Linux siblings).
//
// The projector is Flash Player itself: its own process, its own window, its own renderer,
// with no browser in between. The launcher used to run the game in a PPAPI plugin inside a
// Chromium 87 window, where every frame went through the browser's plugin host, compositor
// and IPC -- the source of the input and frame delay players felt. The projector is also
// the build Adobe left without the 2021-01-12 kill switch the browser plugins carry.
//
// The projector cannot host the game page, only the SWF. Everything that page's script did
// for the game -- rich presence, region latency -- the launcher does itself while the
// projector runs (lib/gameHost.js). Sign-in needs nothing from the page: the server signs a
// fresh game connection in from the hand-off the launcher's saved token recreates, and the
// OAuth callback signs in an open one.

// Where a build carries its own projector: vendor/projector/<platform>/, filled by
// tools/fetch-projector.js. A packaged build keeps it as an extra resource next to
// the app, because nothing inside the asar archive can be executed.
const VENDOR_DIRECTORIES = [];
if (process.resourcesPath) {
    VENDOR_DIRECTORIES.push(path.join(process.resourcesPath, 'vendor', 'projector', process.platform));
}
VENDOR_DIRECTORIES.push(path.join(__dirname, '..', 'vendor', 'projector', process.platform));

// Release and debug ("content debugger") builds both play; release sorts first.
const PROJECTOR_NAME_PATTERNS = {
    win32: /^flashplayer.*\.exe$/i,
    darwin: /^Flash Player.*\.app$/i,
    linux: /^flashplayer(debugger)?$/i
};

// The path a game SWF is served from when the page cannot be read for the exact one. The
// server redirects a request without its canonical version keys to the canonical URL.
const DEFAULT_SWF_PATH = '/p/cbp/DungeonBlitz.swf?fv=cbp&gv=cbp';

function fileExists(candidate) {
    try {
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}

function directoryExists(candidate) {
    try {
        return fs.statSync(candidate).isDirectory();
    } catch {
        return false;
    }
}

function isProjector(candidate, platform = process.platform) {
    const pattern = PROJECTOR_NAME_PATTERNS[platform];
    if (!pattern || !pattern.test(path.basename(candidate))) {
        return false;
    }
    return platform === 'darwin' ? directoryExists(candidate) : fileExists(candidate);
}

/**
 * Whether a file the player chose by hand is a projector, whatever it is called: players
 * rename downloads ("Flash Player 32.exe"), so a hand-picked file goes by its kind -- an
 * .exe on Windows, an .app on macOS, any executable but a plugin library on Linux.
 */
function isChosenProjector(candidate, platform = process.platform) {
    if (isProjector(candidate, platform)) {
        return true;
    }
    if (platform === 'win32') {
        return /\.exe$/i.test(candidate) && fileExists(candidate);
    }
    if (platform === 'darwin') {
        return /\.app$/i.test(candidate) && directoryExists(candidate);
    }
    if (/\.so(\.\d+)*$/i.test(candidate) || !fileExists(candidate)) {
        return false;
    }
    try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function projectorInDirectory(directory, platform = process.platform) {
    if (!directoryExists(directory)) {
        return '';
    }

    let entries = [];
    try {
        entries = fs.readdirSync(directory).sort();
    } catch {
        return '';
    }

    // A debugger build is only the fallback: it opens a trace prompt on script errors.
    entries.sort((left, right) => Number(/debug/i.test(left)) - Number(/debug/i.test(right)));
    for (const entry of entries) {
        const candidate = path.join(directory, entry);
        if (isProjector(candidate, platform)) {
            return candidate;
        }
    }
    return '';
}

function searchDirectories(extraDirectories) {
    const directories = VENDOR_DIRECTORIES.slice();
    if (Array.isArray(extraDirectories)) {
        directories.push(...extraDirectories);
    }

    const home = os.homedir();
    if (process.platform === 'win32') {
        const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
        const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        directories.push(
            path.join(programFiles, 'Adobe', 'Flash Player'),
            path.join(programFilesX86, 'Adobe', 'Flash Player'),
            path.join(home, 'Downloads')
        );
    } else if (process.platform === 'darwin') {
        directories.push('/Applications', path.join(home, 'Applications'), path.join(home, 'Downloads'));
    } else {
        directories.push('/usr/local/bin', '/usr/bin', '/opt/flashplayer', path.join(home, '.local', 'bin'));
    }

    return directories;
}

/** The executable to spawn: the binary itself, or the one inside a macOS .app bundle. */
function projectorExecutable(projectorPath) {
    if (process.platform === 'darwin') {
        return macBundleExecutable(projectorPath);
    }
    return projectorPath;
}

function detectVersion(projectorPath) {
    if (process.platform === 'darwin') {
        return versionFromMacBundle(projectorPath);
    }
    if (process.platform === 'win32') {
        return versionFromWindowsMetadata(projectorPath);
    }
    const match = path.basename(projectorPath).match(/(\d+)[._](\d+)[._](\d+)[._](\d+)/);
    return match ? `${match[1]}.${match[2]}.${match[3]}.${match[4]}` : '';
}

/**
 * Whether this machine can execute a projector built for these architectures.
 *
 * Unlike the plugin, the projector is a separate process, so it does not have to match the
 * launcher -- only the machine. Windows runs the 32-bit projector everywhere; macOS runs
 * the Intel one under Rosetta; Linux runs only its own architecture.
 */
function canExecute(architectures, { platform = process.platform, arch = process.arch } = {}) {
    if (!architectures.length) {
        return true;
    }
    if (architectures.includes(arch)) {
        return true;
    }
    if (platform === 'win32') {
        return architectures.includes('ia32') || (architectures.includes('x64') && arch === 'arm64');
    }
    if (platform === 'darwin') {
        return architectures.includes('x64') && arch === 'arm64';
    }
    return false;
}

function describe(projectorPath, source) {
    const executable = projectorExecutable(projectorPath);
    const architectures = executable ? parseBinaryArchitectures(executable) : [];
    return {
        path: projectorPath,
        executable,
        version: detectVersion(projectorPath),
        source,
        architectures,
        archMismatch: !canExecute(architectures)
    };
}

/**
 * Resolves the standalone Flash Player the launcher runs the game in.
 *
 * @param {{ preferredPath?: string, extraDirectories?: string[], vendorOnly?: boolean }} options
 * @returns {{ path: string, executable: string, version: string, source: string,
 *   architectures: string[], archMismatch: boolean } | null}
 */
function findProjector(options = {}) {
    // A packaged launcher runs only the Flash Player it shipped with: no hand-picked file,
    // no copy found elsewhere on the machine. That is what lets lib/integrity.js vouch for
    // the binary it is about to start.
    if (options.vendorOnly) {
        const vendored = findVendoredProjector();
        return vendored ? describe(vendored, 'vendor') : null;
    }

    const preferred = String(options.preferredPath || '').trim();
    if (preferred) {
        if (isChosenProjector(preferred)) {
            return describe(preferred, 'manual');
        }
        const inPreferredDirectory = projectorInDirectory(preferred);
        if (inPreferredDirectory) {
            return describe(inPreferredDirectory, 'manual');
        }
    }

    for (const directory of searchDirectories(options.extraDirectories)) {
        const candidate = projectorInDirectory(directory);
        if (candidate) {
            return describe(candidate, VENDOR_DIRECTORIES.includes(directory) ? 'vendor' : 'auto');
        }
    }

    return null;
}

/** The projector this build ships with, if any (vendor/projector/<platform>). */
function findVendoredProjector() {
    for (const directory of VENDOR_DIRECTORIES) {
        const candidate = projectorInDirectory(directory);
        if (candidate) {
            return candidate;
        }
    }
    return '';
}

/**
 * The SWF the game page embeds, read off the page itself.
 *
 * The page names the exact client revision (`clientrev=...`), which is what keeps a
 * cached SWF from outliving a deploy. A template piece such as `${languageParam}` is
 * dropped: the launcher asks for no language, which is what the page does by default.
 *
 * @param {string} html The game page.
 * @param {string} pageUrl The address it was read from.
 * @returns {string} An absolute SWF URL, or '' when the page names none.
 */
function swfUrlFromPage(html, pageUrl) {
    const match = String(html || '').match(/["'`]((?:https?:\/\/[^"'`\s]+)?\/[^"'`\s]*DungeonBlitz\.swf[^"'`\s]*)["'`]/);
    if (!match) {
        return '';
    }

    const cleaned = match[1].replace(/\$\{[^}]*\}/g, '');
    try {
        return new URL(cleaned, pageUrl).toString();
    } catch {
        return '';
    }
}

/** The SWF to hand the projector when the page cannot be read. */
function defaultSwfUrl(pageUrl) {
    try {
        return new URL(DEFAULT_SWF_PATH, pageUrl).toString();
    } catch {
        return '';
    }
}

/** GETs a page as text; '' on anything but a 2xx answer. */
function fetchText(url, { timeoutMs = 8000, maxBytes = 512 * 1024 } = {}) {
    return new Promise((resolve) => {
        let parsed;
        try {
            parsed = new URL(url);
        } catch {
            resolve('');
            return;
        }
        const transport = parsed.protocol === 'https:' ? https : http;
        const request = transport.get(parsed, { headers: { 'Cache-Control': 'no-store' }, timeout: timeoutMs }, (response) => {
            if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
                response.resume();
                resolve('');
                return;
            }
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                body += chunk;
                if (body.length > maxBytes) {
                    request.destroy();
                }
            });
            response.on('end', () => resolve(body));
            response.on('error', () => resolve(''));
        });
        request.on('timeout', () => request.destroy(new Error('timed out')));
        request.on('error', () => resolve(''));
    });
}

/**
 * The SWF URL to start the projector on for a server: the one its game page embeds, or
 * the canonical path when the page cannot be read.
 */
async function resolveSwfUrl(serverUrl, { fetchPage = fetchText } = {}) {
    const html = await fetchPage(serverUrl);
    return swfUrlFromPage(html, serverUrl) || defaultSwfUrl(serverUrl);
}

// What the macOS Flash Player window is titled: it names the window after the movie exactly
// as it was given on the command line.
const MAC_TITLE_FILE = 'Dungeon Blitz: R';

// What VDPAU_DRIVER is set to so libvdpau finds no backend: there is no libvdpau_none.so.
const NO_VDPAU_DRIVER = 'none';

/**
 * The environment the Linux Flash Player runs in: the launcher's own, with VDPAU turned off.
 *
 * The Linux player draws the stage through VDPAU when it can open a backend, and it hands
 * VDPAU its picture with the U and V planes in the wrong order. libvdpau corrects that (and
 * a bad presentation-queue background colour) only for a process whose command line names
 * "libflashplayer" -- the browser plugin's host, never the standalone `flashplayer`. So the
 * projector shows the game in false colours: a yellow sky, a green wash over everything,
 * with true-colour boxes here and there. Pointing VDPAU_DRIVER at a backend that does not
 * exist makes libvdpau fail to open, and Flash Player then draws in software, exactly as it
 * does on a machine with no VDPAU at all. The game needs nothing the hardware path adds.
 *
 * DUNGEON_BLITZ_FLASH_VDPAU=1 leaves VDPAU as it is, for a player whose driver draws the
 * game correctly and who wants it back.
 *
 * `preload`, what findFlashPreload found, is loaded into Flash Player (see withFlashPreload).
 */
function linuxFlashEnv(env = process.env, preload = null) {
    if (env.DUNGEON_BLITZ_FLASH_VDPAU === '1') {
        return withFlashPreload({ ...env }, preload);
    }
    return withFlashPreload({ ...env, VDPAU_DRIVER: NO_VDPAU_DRIVER }, preload);
}

// Where a build carries the libraries it loads into the Linux Flash Player:
// vendor/flashpreload/linux/, built from native_flash/ by tools/build-flash-preload.js and
// shipped as an extra resource next to the projector.
const PRELOAD_DIRECTORIES = [];
if (process.resourcesPath) {
    PRELOAD_DIRECTORIES.push(path.join(process.resourcesPath, 'vendor', 'flashpreload', 'linux'));
}
PRELOAD_DIRECTORIES.push(path.join(__dirname, '..', 'vendor', 'flashpreload', 'linux'));

// The preload folder's fingerprint, written by tools/build-flash-preload.js and packed into
// the asar like Flash Player's own (lib/integrity.js).
const PRELOAD_INTEGRITY_PATH = path.join(__dirname, 'flashpreload.integrity.json');

/**
 * The libraries to load into the Linux Flash Player, or null when this build has none.
 *
 * There are two, both for frame rate:
 *   - native_flash/flash_rlimit_cache.c: Flash Player asks the kernel for its stack limit
 *     many times per frame, and on an AMD Zen processor that system call alone took a third
 *     of its main thread. The library answers from memory instead.
 *   - native_flash/flash_short_tick.c: Flash Player starts each step of a frame on a 10 ms
 *     GLib timer, so a frame that runs past one tick waited for the next. Its 10 ms timers
 *     tick every 2 ms instead.
 *
 * @param {string[]} [directories] replaces the vendor folders (the tests use it).
 * @returns {{ directory: string, libraries: string[] } | null}
 */
function findFlashPreload(directories = PRELOAD_DIRECTORIES) {
    for (const directory of directories) {
        let entries;
        try {
            entries = fs.readdirSync(directory);
        } catch {
            continue;
        }
        const libraries = entries.filter((entry) => entry.endsWith('.so') && fileExists(path.join(directory, entry))).sort();
        if (libraries.length > 0) {
            return { directory, libraries };
        }
    }
    return null;
}

/**
 * Whether a preload folder is the one this build shipped. Anything loaded into Flash Player
 * runs as Flash Player, so a packaged launcher checks it as it checks the player itself.
 */
function verifyFlashPreload(directory, { integrityPath = PRELOAD_INTEGRITY_PATH } = {}) {
    return verifyTree(directory, { integrityPath, platform: 'linux', label: 'Flash Player preload' });
}

/**
 * `env` with the preload libraries added to LD_PRELOAD.
 *
 * LD_PRELOAD splits its list on spaces and colons, and the .deb installs into
 * "/opt/Dungeon Blitz R", so a full path would not survive. The libraries go in by bare name
 * instead, and their folder goes first in LD_LIBRARY_PATH, which splits on colons only:
 * ld.so looks a bare LD_PRELOAD name up the way it looks up any library. A folder whose own
 * name holds a colon cannot be written either way, and Flash Player then starts without them.
 * Whatever the player already preloads (MangoHud, for one) is kept, ahead of these.
 *
 * DUNGEON_BLITZ_FLASH_PRELOAD=0 starts Flash Player without them.
 */
function withFlashPreload(env, preload) {
    if (!preload || preload.libraries.length === 0 || env.DUNGEON_BLITZ_FLASH_PRELOAD === '0') {
        return env;
    }
    if (preload.directory.includes(':')) {
        return env;
    }
    return {
        ...env,
        LD_LIBRARY_PATH: [preload.directory, env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
        LD_PRELOAD: [env.LD_PRELOAD, ...preload.libraries].filter(Boolean).join(' ')
    };
}

/**
 * How to start Flash Player on the game, ready to spawn.
 *
 * Windows and Linux start it on the game's URL; their window title is Flash Player's own
 * name and lib/windowTitle.js renames it. macOS titles the window with the movie's address
 * -- the full game URL -- and no other app can rename it. So on macOS Flash Player is started
 * on a local file named "Dungeon Blitz: R", run from its own folder so that bare name is the
 * whole title, and that file loads the game from the server into level 0
 * (lib/loaderSwf.js). Tried on a macOS runner: the same game, the same window, a clean title.
 *
 * On Linux Flash Player is also kept off VDPAU and started with the preload libraries (see
 * linuxFlashEnv).
 *
 * @param {{ path: string, executable?: string }} projector
 * @param {string} swfUrl
 * @param {{ platform?: string, workDir: string, env?: object, preload?: object }} options
 *   `workDir` holds the loader file; it is rewritten before every game, so it always points
 *   at the server being played. `env` is the environment to start from (the launcher's own
 *   by default). `preload` is what findFlashPreload found, once its fingerprint was checked.
 * @returns {{ command: string, args: string[], cwd?: string, env?: object }}
 */
function prepareLaunch(projector, swfUrl, { platform = process.platform, workDir, env = process.env, preload = null } = {}) {
    const command = projector.executable || projector.path;
    if (platform === 'linux') {
        return { command, args: [swfUrl], env: linuxFlashEnv(env, preload) };
    }
    if (platform !== 'darwin' || !workDir) {
        return { command, args: [swfUrl] };
    }

    const { buildLoaderSwf } = require('./loaderSwf');
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, MAC_TITLE_FILE), buildLoaderSwf(swfUrl));
    return { command, args: [MAC_TITLE_FILE], cwd: workDir };
}

module.exports = {
    VENDOR_DIRECTORIES,
    MAC_TITLE_FILE,
    NO_VDPAU_DRIVER,
    PRELOAD_DIRECTORIES,
    PRELOAD_INTEGRITY_PATH,
    findFlashPreload,
    verifyFlashPreload,
    linuxFlashEnv,
    prepareLaunch,
    resolveSwfUrl,
    isChosenProjector,
    PROJECTOR_NAME_PATTERNS,
    canExecute,
    defaultSwfUrl,
    findProjector,
    findVendoredProjector,
    projectorInDirectory,
    swfUrlFromPage
};
