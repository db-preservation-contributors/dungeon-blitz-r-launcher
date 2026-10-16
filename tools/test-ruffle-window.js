#!/usr/bin/env node
'use strict';

/**
 * lib/ruffleWindow.js: the Ruffle engine, the server's /web page in a game window of the
 * launcher's own Electron.
 *
 * Nothing here starts Electron; BrowserWindow is faked. What is checked is the page it opens,
 * the window it asks for, the origin it is locked to, its keys, where links off the game go,
 * the remembered size, and that closing the window ends the game like a process exit.
 */

const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PARTITION, TITLE, allowsNavigation, openRuffleWindow, ruffleGameUrl } = require('../lib/ruffleWindow');

let nextContentsId = 1;

class FakeWebContents extends EventEmitter {
    constructor() {
        super();
        this.id = nextContentsId++;
        this.reloads = 0;
        this.devToolsToggles = 0;
        this.scripts = [];
        this.windowOpenHandler = null;
    }

    reload() {
        this.reloads += 1;
    }

    toggleDevTools() {
        this.devToolsToggles += 1;
    }

    setWindowOpenHandler(handler) {
        this.windowOpenHandler = handler;
    }

    executeJavaScript(code) {
        this.scripts.push(code);
        return Promise.resolve(true);
    }
}

class FakeBrowserWindow extends EventEmitter {
    constructor(options) {
        super();
        FakeBrowserWindow.created.push(this);
        this.options = options;
        this.webContents = new FakeWebContents();
        this.destroyed = false;
        this.visible = false;
        this.fullScreen = false;
        this.loaded = '';
        this.menuBarVisible = true;
        this.bounds = { x: 40, y: 50, width: options.width, height: options.height };
    }

    loadURL(url) {
        this.loaded = url;
        return Promise.resolve();
    }

    setMenuBarVisibility(visible) {
        this.menuBarVisible = visible;
    }

    isDestroyed() {
        return this.destroyed;
    }

    isVisible() {
        return this.visible;
    }

    show() {
        this.visible = true;
    }

    isFullScreen() {
        return this.fullScreen;
    }

    setFullScreen(value) {
        this.fullScreen = value;
    }

    getNormalBounds() {
        return { ...this.bounds };
    }

    close() {
        this.emit('close');
        this.destroyed = true;
        this.emit('closed');
    }
}
FakeBrowserWindow.created = [];

function key(win, input) {
    let prevented = false;
    win.webContents.emit('before-input-event', { preventDefault: () => (prevented = true) }, { type: 'keyDown', ...input });
    return prevented;
}

function checkGameUrl() {
    assert.strictEqual(ruffleGameUrl('http://example.test/'), 'http://example.test/web');
    assert.strictEqual(ruffleGameUrl('http://example.test'), 'http://example.test/web', 'a bare host gets its slash');
    assert.strictEqual(ruffleGameUrl('https://example.test:8443/game'), 'https://example.test:8443/game/web', 'a server under a path keeps it');
    assert.strictEqual(ruffleGameUrl('http://example.test/?x=1#y'), 'http://example.test/web', 'query and hash are dropped');
    assert.strictEqual(ruffleGameUrl('file:///C:/game.swf'), '', 'only http(s) servers');
    assert.strictEqual(ruffleGameUrl('not a url'), '');
    assert.strictEqual(ruffleGameUrl(''), '');
    console.log('[test-ruffle-window] the /web page of each server: OK');
}

function checkWindow(scratch) {
    const external = [];
    const opened = openRuffleWindow({
        BrowserWindow: FakeBrowserWindow,
        serverUrl: 'http://example.test/',
        userDataDir: scratch,
        openExternal: (url) => external.push(url)
    });
    assert.strictEqual(opened.ok, true);
    assert.strictEqual(opened.url, 'http://example.test/web');
    const win = opened.window;
    assert.strictEqual(win.loaded, 'http://example.test/web', 'the window loads the game page');

    const prefs = win.options.webPreferences;
    assert.strictEqual(prefs.partition, PARTITION, 'the game keeps its own cookies');
    assert.strictEqual(prefs.contextIsolation, true);
    assert.strictEqual(prefs.nodeIntegration, false, 'the game page gets no Node');
    assert.strictEqual(prefs.sandbox, true);
    assert.strictEqual(prefs.backgroundThrottling, false, 'the game keeps its pace without focus');
    assert.strictEqual(prefs.devTools, false, 'no developer tools unless asked');
    assert.strictEqual(win.options.title, TITLE);
    assert.strictEqual(win.options.show, false, 'shown once ready, not as a blank window');
    assert.strictEqual(win.menuBarVisible, false);

    win.emit('ready-to-show');
    assert.strictEqual(win.visible, true);

    // The page's own <title> does not rename the window.
    let titlePrevented = false;
    win.emit('page-title-updated', { preventDefault: () => (titlePrevented = true) });
    assert.strictEqual(titlePrevented, true);

    // Locked to its own origin.
    assert.strictEqual(allowsNavigation(win.webContents, 'http://example.test/web?reload=1'), true);
    assert.strictEqual(allowsNavigation(win.webContents, 'http://example.test/rankings'), true);
    assert.strictEqual(allowsNavigation(win.webContents, 'https://example.test/web'), false, 'another scheme is another origin');
    assert.strictEqual(allowsNavigation(win.webContents, 'http://example.test:8080/web'), false);
    assert.strictEqual(allowsNavigation(win.webContents, 'https://discord.com/oauth2/authorize'), false);
    assert.strictEqual(allowsNavigation(new FakeWebContents(), 'http://example.test/web'), false, 'other windows are not let through');
    assert.strictEqual(allowsNavigation(null, 'http://example.test/web'), false);

    // Keys.
    assert.strictEqual(key(win, { key: 'F11' }), true);
    assert.strictEqual(win.fullScreen, true, 'F11 goes full screen');
    key(win, { key: 'F11' });
    assert.strictEqual(win.fullScreen, false, 'and back');
    assert.strictEqual(key(win, { key: 'F5' }), true);
    assert.strictEqual(key(win, { key: 'r', control: true }), true);
    assert.strictEqual(win.webContents.reloads, 2, 'F5 and Ctrl+R reload the game');
    assert.strictEqual(key(win, { key: 'I', control: true, shift: true }), false, 'no developer tools in a player build');
    assert.strictEqual(win.webContents.devToolsToggles, 0);
    assert.strictEqual(key(win, { key: 'a' }), false, 'game keys pass through');
    let upPrevented = false;
    win.webContents.emit('before-input-event', { preventDefault: () => (upPrevented = true) }, { type: 'keyUp', key: 'F11' });
    assert.strictEqual(upPrevented, false, 'only key presses are acted on');

    // A link off the game opens in the browser, and the Discord sign-in poll is restarted.
    const answer = win.webContents.windowOpenHandler({ url: 'https://discord.com/oauth2/authorize?x=1' });
    assert.deepStrictEqual(answer, { action: 'deny' }, 'no second Electron window');
    assert.deepStrictEqual(external, ['https://discord.com/oauth2/authorize?x=1']);
    assert.ok(win.webContents.scripts[0].includes('startDiscordPendingLoginPoll'));

    // A page that cannot load still shows the window, with Chromium's error page.
    win.visible = false;
    win.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://example.test/web', true);
    assert.strictEqual(win.visible, false, 'an aborted load is not a failure');
    win.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'http://example.test/web', false);
    assert.strictEqual(win.visible, false, 'a subframe failing is not the page failing');
    win.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'http://example.test/web', true);
    assert.strictEqual(win.visible, true);

    // The stand-in process: kill() closes the window, closing it is the game's exit.
    const exits = [];
    opened.child.on('exit', (code, signal) => exits.push([code, signal]));
    assert.strictEqual(opened.child.pid, process.pid);
    win.bounds = { x: 10, y: 20, width: 1400, height: 900 };
    opened.child.kill();
    assert.strictEqual(win.destroyed, true);
    assert.deepStrictEqual(exits, [[0, null]], 'closing the window ends the game');
    opened.child.kill();
    assert.strictEqual(exits.length, 1, 'killing it again does nothing');
    assert.strictEqual(allowsNavigation(win.webContents, 'http://example.test/web'), false, 'a closed window lets nothing through');

    // The size is remembered for the next game.
    const saved = JSON.parse(fs.readFileSync(path.join(scratch, 'ruffle-window.json'), 'utf8'));
    assert.deepStrictEqual(saved, { x: 10, y: 20, width: 1400, height: 900 });
    const again = openRuffleWindow({ BrowserWindow: FakeBrowserWindow, serverUrl: 'http://example.test/', userDataDir: scratch });
    assert.strictEqual(again.window.options.width, 1400);
    assert.strictEqual(again.window.options.height, 900);
    assert.strictEqual(again.window.options.x, 10);
    assert.strictEqual(again.window.options.y, 20);

    // Closed in full screen: the windowed size from before is kept, not the screen's.
    again.window.setFullScreen(true);
    again.window.bounds = { x: 0, y: 0, width: 2560, height: 1440 };
    again.child.kill();
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(scratch, 'ruffle-window.json'), 'utf8')).width, 1400);

    console.log('[test-ruffle-window] the game window, its lock, keys, links and size: OK');
}

function checkDevelopmentAndRefusals(scratch) {
    const dev = openRuffleWindow({ BrowserWindow: FakeBrowserWindow, serverUrl: 'http://127.0.0.1:8080/', userDataDir: scratch, devTools: true });
    assert.strictEqual(dev.window.options.webPreferences.devTools, true);
    assert.strictEqual(key(dev.window, { key: 'i', control: true, shift: true }), true);
    assert.strictEqual(dev.window.webContents.devToolsToggles, 1, 'a development checkout opens developer tools');
    dev.child.kill();

    // A broken size file opens at the default size.
    fs.writeFileSync(path.join(scratch, 'ruffle-window.json'), '{not json');
    const fresh = openRuffleWindow({ BrowserWindow: FakeBrowserWindow, serverUrl: 'http://example.test/', userDataDir: scratch });
    assert.strictEqual(fresh.window.options.width, 1200);
    assert.strictEqual(fresh.window.options.height, 800);
    assert.strictEqual(fresh.window.options.x, undefined);
    fresh.child.kill();

    const before = FakeBrowserWindow.created.length;
    const refused = openRuffleWindow({ BrowserWindow: FakeBrowserWindow, serverUrl: 'ftp://example.test/', userDataDir: scratch });
    assert.strictEqual(refused.ok, false);
    assert.ok(refused.message.includes('ftp://example.test/'));
    assert.strictEqual(FakeBrowserWindow.created.length, before, 'no window for a server that cannot be played');

    console.log('[test-ruffle-window] development tools, a broken size file and unusable servers: OK');
}

function main() {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'db-ruffle-window-'));
    try {
        checkGameUrl();
        checkWindow(scratch);
        checkDevelopmentAndRefusals(scratch);
        console.log('[test-ruffle-window] all assertions passed');
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

main();
