'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

/**
 * The Ruffle engine: the selected server's /web page -- the game page with Ruffle, the
 * Flash emulator, in front of it -- in a game window of the launcher's own Electron.
 *
 * Ruffle draws the game on the GPU (WebGL / WebGPU), where Adobe's Flash Player rasterises
 * it on one CPU core. In the same fight at the game's 125% scale, with 161 entities on
 * screen, Ruffle in Chrome held 100 fps with a longest frame of about 12 ms; Legacy held 57
 * fps with frames of about 60 ms. And Ruffle needs no plugin, so the launcher's own modern
 * Chromium runs it on every system it ships for.
 *
 * The page runs its own script, as in FlashBrowser: rich presence, region latency and the
 * in-game Discord sign-in, so lib/gameHost.js stays off. The game socket goes through the
 * server's WebSocket (the page's Ruffle socketProxy), so a blocked game port does not matter.
 *
 * The window is locked to the game's origin: main.js's web-contents-created handler refuses
 * every other navigation and opens it in the player's browser, as it does for every page.
 */

const TITLE = 'Dungeon Blitz: R';
const DEFAULT_BOUNDS = { width: 1200, height: 800 };
const MIN_SIZE = { width: 800, height: 600 };
const BACKGROUND_COLOR = '#484955';
// Its own persistent profile: the game's cookies (its sign-in) are not the launcher window's.
const PARTITION = 'persist:dungeon-blitz-game';
const WEB_PATH = 'web';

/** The /web page of a server: http://host/ -> http://host/web. '' for anything unusable. */
function ruffleGameUrl(serverUrl) {
    try {
        const base = new URL(serverUrl);
        if (base.protocol !== 'http:' && base.protocol !== 'https:') {
            return '';
        }
        if (!base.pathname.endsWith('/')) {
            base.pathname += '/';
        }
        base.search = '';
        base.hash = '';
        return new URL(WEB_PATH, base).toString();
    } catch {
        return '';
    }
}

function originOf(url) {
    try {
        return new URL(url).origin;
    } catch {
        return '';
    }
}

function readBounds(file) {
    try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        return saved && typeof saved === 'object' ? saved : {};
    } catch {
        return {};
    }
}

function writeBounds(file, bounds) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(bounds));
    } catch {
        // A window that opens at the default size next time is all that is lost.
    }
}

/**
 * The game windows the launcher has open, by webContents id, with the origin each may stay
 * on. main.js asks this before refusing a navigation.
 */
const gameOrigins = new Map();

/** Whether `contents` is a Ruffle game window and `url` is on that game's own origin. */
function allowsNavigation(contents, url) {
    const origin = contents ? gameOrigins.get(contents.id) : '';
    return Boolean(origin) && originOf(url) === origin;
}

/**
 * Opens the game in a Ruffle window.
 *
 * Returns a stand-in for a game process, so main.js keeps one game at a time the same way
 * for all three engines: it has `pid`, `kill()` (closes the window) and emits 'exit' once the
 * window is gone.
 *
 * @param {object} options
 * @param {typeof import('electron').BrowserWindow} options.BrowserWindow
 * @param {string} options.serverUrl the selected server
 * @param {string} options.userDataDir where the window remembers its size
 * @param {string} [options.icon]
 * @param {boolean} [options.devTools]
 * @param {(url: string) => void} [options.openExternal] where links off the game go
 * @param {(message: string) => void} [options.log]
 * @returns {{ ok: true, child: EventEmitter, window: object, url: string } | { ok: false, message: string }}
 */
function openRuffleWindow({ BrowserWindow, serverUrl, userDataDir, icon, devTools = false, openExternal = () => {}, log = () => {} }) {
    const url = ruffleGameUrl(serverUrl);
    if (!url) {
        return { ok: false, message: `The server address ${serverUrl} cannot be played in Ruffle.` };
    }

    const boundsPath = path.join(userDataDir, 'ruffle-window.json');
    const bounds = readBounds(boundsPath);
    const win = new BrowserWindow({
        width: Number.isFinite(bounds.width) ? bounds.width : DEFAULT_BOUNDS.width,
        height: Number.isFinite(bounds.height) ? bounds.height : DEFAULT_BOUNDS.height,
        x: Number.isFinite(bounds.x) ? bounds.x : undefined,
        y: Number.isFinite(bounds.y) ? bounds.y : undefined,
        minWidth: MIN_SIZE.width,
        minHeight: MIN_SIZE.height,
        backgroundColor: BACKGROUND_COLOR,
        title: TITLE,
        show: false,
        icon,
        webPreferences: {
            partition: PARTITION,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webviewTag: false,
            webSecurity: true,
            // The game keeps its pace when another window has focus.
            backgroundThrottling: false,
            devTools
        }
    });
    const contentsId = win.webContents.id;
    gameOrigins.set(contentsId, originOf(url));

    const child = new EventEmitter();
    // The game runs in the launcher's own process; its pid is what presence reports.
    child.pid = process.pid;
    child.kill = () => {
        if (!win.isDestroyed()) {
            win.close();
        }
    };

    win.setMenuBarVisibility(false);
    // The window is the game, not the page's <title>.
    win.on('page-title-updated', (event) => event.preventDefault());

    win.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') {
            return;
        }
        if (input.key === 'F11') {
            win.setFullScreen(!win.isFullScreen());
            event.preventDefault();
            return;
        }
        if (input.key === 'F5' || (input.control && String(input.key).toLowerCase() === 'r')) {
            win.webContents.reload();
            event.preventDefault();
            return;
        }
        if (devTools && input.control && input.shift && String(input.key).toLowerCase() === 'i') {
            win.webContents.toggleDevTools();
            event.preventDefault();
        }
    });

    // Discord's sign-in finishes in the player's browser, so the page never sees the
    // localStorage event it waits on. Restarting its poll keeps the in-game sign-in working.
    win.webContents.setWindowOpenHandler(({ url: target }) => {
        openExternal(target);
        void win.webContents
            .executeJavaScript(
                'typeof startDiscordPendingLoginPoll === "function" ? (startDiscordPendingLoginPoll(), true) : false',
                true
            )
            .catch(() => false);
        return { action: 'deny' };
    });

    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) {
            return;
        }
        log(`The game page could not be opened: ${validatedUrl} (${errorDescription}, ${errorCode})`);
        // Chromium's own error page says what went wrong; a window that never shows would not.
        if (!win.isDestroyed() && !win.isVisible()) {
            win.show();
        }
    });
    win.webContents.on('render-process-gone', (_event, details) => {
        log(`The game page's renderer ended (${details && details.reason})`);
    });

    win.on('close', () => {
        if (!win.isFullScreen()) {
            writeBounds(boundsPath, win.getNormalBounds());
        }
    });
    win.on('closed', () => {
        gameOrigins.delete(contentsId);
        child.emit('exit', 0, null);
    });

    win.once('ready-to-show', () => win.show());
    void win.loadURL(url);
    return { ok: true, child, window: win, url };
}

module.exports = { PARTITION, TITLE, allowsNavigation, openRuffleWindow, ruffleGameUrl };
