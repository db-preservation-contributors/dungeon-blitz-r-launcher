#!/usr/bin/env node
'use strict';

/**
 * Which engine a play starts: Legacy -- Adobe's standalone Flash Player 32 (lib/projector.js) --
 * is the main button and the default; FlashBrowser (lib/flashBrowser.js), the smoother one, is a
 * second button where this system has one.
 *
 * main.js itself runs here, with a stand-in for Electron and for the parts that would start
 * real programs (the Flash Player lookup and launch, the window title, the timer, the game
 * host, the game tunnel), and is driven through the same IPC calls the launcher window makes.
 * FlashBrowser is looked up by the real lib/flashBrowser.js, told which platform it is on and
 * pointed at a stand-in vendor/flashbrowser/ folder; main.js is loaded once per machine, since
 * it looks for its engines when it starts. It checks that:
 *
 * - FlashBrowser is offered on Windows x64 and macOS (Intel, and Apple Silicon under Rosetta),
 *   and not on 32-bit Windows or Linux;
 * - a plain play -- the start-up play of a remembered player -- starts Legacy unless the player
 *   last picked FlashBrowser with its button and it can run here;
 * - the main button starts Legacy and the FlashBrowser button starts FlashBrowser, each
 *   remembered as `chosenEngine` for the next plain play;
 * - a saved 'flashbrowser' falls back to Legacy where FlashBrowser is missing or not offered,
 *   and the FlashBrowser button there says why instead of starting anything;
 * - a saved 'ruffle', an unknown value or the older `engine` key all play Legacy;
 * - FlashBrowser runs at the game's own 100 fps unless DB_VSYNC=1;
 * - nothing anywhere in the launcher's code or state is Ruffle.
 *
 * Usage: node tools/test-legacy-engine.js
 */

const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// main.js narrates every start on the console; the suite's own lines are what matter here.
const report = console.log.bind(console);
const MAIN = path.join(ROOT, 'main.js');
const SWF_URL = 'http://dungeonblitzr.theminesa.studio/p/cbp/DungeonBlitz.swf';
const GAME_URL = 'http://dungeonblitzr.theminesa.studio/';

// Values older launchers wrote into launcher-state.json that name no engine this one has.
const UNKNOWN_ENGINES = ['ruffle', 'something-else', ''];

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'db-legacy-engine-'));
const appData = path.join(scratch, 'appData');
const userData = path.join(appData, 'dungeon-blitz-r-launcher');
const statePath = path.join(userData, 'launcher-state.json');

// Nothing from a game checkout next to this one: the official server list only.
process.env.DUNGEON_BLITZ_SERVER_ROOT = path.join(scratch, 'no-server-checkout');
// Nothing that would reach a server or Discord while the fake game runs.
process.env.DUNGEON_BLITZ_GAME_STATS = '0';
process.env.DUNGEON_BLITZ_DAMAGE_METER = '0';
delete process.env.DB_VSYNC;

/** Writes launcher-state.json as an older launcher, or an earlier play, would have left it. */
function seedState(extra = {}) {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(
        statePath,
        JSON.stringify({ serverId: 'official', startDiscordBridge: false, startSocialBridge: false, ...extra })
    );
}

function savedState() {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

// What the Flash Player lookup finds: null (none), or a stand-in projector.
let installedProjector = null;
const FAKE_PROJECTOR = {
    path: path.join(scratch, 'Flash Player.app'),
    executable: path.join(scratch, 'Flash Player.app', 'Contents', 'MacOS', 'Flash Player'),
    version: '32.0.0.465',
    source: 'vendor',
    architectures: ['x64'],
    archMismatch: false
};

function write(file, body = 'x') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
}

/** A vendor/flashbrowser/<target>/ stand-in: complete, or without its plugin. */
function makeFlashBrowser(target, { complete }) {
    const root = path.join(scratch, 'flashbrowser', `${target}-${complete ? 'complete' : 'partial'}`);
    if (target === 'win32-x64') {
        write(path.join(root, 'runtime', 'electron.exe'));
        write(path.join(root, 'runtime', 'resources', 'default_app.asar'));
        if (complete) {
            write(path.join(root, 'plugin', 'pepflashplayer64.dll'));
        }
    } else {
        write(path.join(root, 'runtime', 'Electron.app', 'Contents', 'MacOS', 'Electron'));
        write(path.join(root, 'runtime', 'Electron.app', 'Contents', 'Resources', 'default_app.asar'));
        if (complete) {
            write(path.join(root, 'plugin', 'PepperFlashPlayer.plugin', 'Contents', 'MacOS', 'PepperFlashPlayer'));
        }
    }
    write(path.join(root, 'app', 'main.js'));
    write(path.join(root, 'app', 'package.json'), '{}');
    return root;
}

// The machine main.js believes it is on, for the FlashBrowser lookup: its platform and
// architecture, and the vendor/flashbrowser/ folders it would search.
let machine = { platform: 'linux', arch: 'x64', directories: [] };

// Every program main.js starts.
const spawned = [];
function fakeSpawn(command, args) {
    const child = new EventEmitter();
    child.pid = 4242;
    child.kill = () => child.emit('exit', null, 'SIGTERM');
    spawned.push({ command, args, child });
    return child;
}

const handlers = new Map();
// Every URL main.js hands to the browser.
const openedUrls = [];
const electron = {
    app: {
        isPackaged: false,
        commandLine: { hasSwitch: () => false },
        setName() {},
        setPath(name, value) {
            this.paths[name] = value;
        },
        getPath(name) {
            return this.paths[name] || path.join(scratch, name);
        },
        paths: { appData },
        getVersion: () => '0.0.0-test',
        getAppPath: () => ROOT,
        requestSingleInstanceLock: () => true,
        // The window never opens: the test talks to main.js through its IPC handlers alone.
        whenReady: () => new Promise(() => {}),
        on() {},
        quit() {},
        exit() {},
        relaunch() {}
    },
    BrowserWindow: class {
        static getAllWindows() {
            return [];
        }
    },
    clipboard: { writeText() {} },
    dialog: {
        showErrorBox() {},
        showMessageBox: async () => ({ response: 1 }),
        showOpenDialog: async () => ({ canceled: false, filePaths: [FAKE_PROJECTOR.path] })
    },
    ipcMain: {
        handle(channel, handler) {
            handlers.set(channel, handler);
        }
    },
    shell: {
        openExternal: async (url) => {
            openedUrls.push(url);
        }
    }
};

const realFlashBrowser = require('../lib/flashBrowser');
const stubs = {
    electron,
    child_process: { ...require('child_process'), spawn: fakeSpawn },
    './lib/projector': {
        findProjector: () => (installedProjector ? { ...installedProjector } : null),
        findVendoredProjector: () => '',
        findFlashPreload: () => null,
        flashRenderMode: () => '',
        isChosenProjector: () => true,
        prepareLaunch: (projector, swfUrl) => ({ command: projector.executable, args: [swfUrl] }),
        resolveSwfUrl: async (serverUrl) => new URL('/p/cbp/DungeonBlitz.swf', serverUrl).toString(),
        verifyFlashPreload: () => ({ ok: true, reason: '' })
    },
    // The real lookup and launch, on the machine the test says this is.
    './lib/flashBrowser': {
        ...realFlashBrowser,
        findFlashBrowser: () => realFlashBrowser.findFlashBrowser(machine)
    },
    // The game port always answers here: no tunnel.
    './lib/gameTunnel': { openGameTunnel: async () => null },
    './lib/windowTitle': { keepGameTitle: () => ({ method: 'none', stop() {} }) },
    './lib/flashTimer': { boostFlashTimer() {} },
    './lib/gameHost': {
        GameHost: class {
            start() {}
            stop() {}
        }
    }
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
    if (request === 'electron') {
        return electron;
    }
    if (parent && parent.filename === MAIN && Object.prototype.hasOwnProperty.call(stubs, request)) {
        return stubs[request];
    }
    return originalLoad.call(this, request, parent, isMain);
};

/** Starts main.js afresh on `nextMachine`: it looks for its engines once, as it starts. */
function startLauncher(nextMachine) {
    machine = nextMachine;
    handlers.clear();
    delete require.cache[MAIN];
    require(MAIN);
}

async function invoke(channel, ...args) {
    const handler = handlers.get(channel);
    assert.ok(handler, `main.js handles ${channel}`);
    return handler({}, ...args);
}

/** The launcher state names Flash Player, FlashBrowser as `expected`, and no Ruffle. */
function checkState(state, expected) {
    assert.ok(state.flash && typeof state.flash === 'object', 'the state reports Flash Player');
    assert.ok(state.flashBrowser && typeof state.flashBrowser === 'object', 'and FlashBrowser');
    for (const [key, value] of Object.entries(expected)) {
        assert.strictEqual(state.flashBrowser[key], value, `flashBrowser.${key}`);
    }
    assert.ok(['projector', 'flashbrowser'].includes(state.engine), `the preferred engine is one this launcher has (${state.engine})`);
    assert.ok(!/ruffle/i.test(JSON.stringify(state)), 'Ruffle appears nowhere in the state');
}

/** Presses a play button (or makes a plain play, `requested` undefined) and closes the game again. */
async function playOnce(requested) {
    spawned.length = 0;
    const result = await invoke('launcher:play', requested);
    if (!result.ok) {
        assert.strictEqual(spawned.length, 0, 'a refused play starts nothing');
        return { result, started: null };
    }
    assert.strictEqual(spawned.length, 1, 'one program is started');
    const started = spawned[0];
    const running = await invoke('launcher:getState');
    assert.strictEqual(running.gameRunning, true);
    const engine = started.command === FAKE_PROJECTOR.executable ? 'projector' : 'flashbrowser';
    assert.strictEqual(running.gameEngine, engine, 'the state says which engine is running');
    // The program closing ends the game session.
    started.child.emit('exit', 0, null);
    const after = await invoke('launcher:getState');
    assert.strictEqual(after.gameRunning, false);
    assert.strictEqual(after.gameEngine, '');
    return { result, started, engine };
}

/** No Ruffle in the launcher's code, packaging or tests: not a module, not a button, not a path. */
function checkNoRuffle() {
    assert.ok(!fs.existsSync(path.join(ROOT, 'lib', 'ruffleWindow.js')), 'lib/ruffleWindow.js is gone');
    assert.ok(!fs.existsSync(path.join(ROOT, 'tools', 'test-ruffle-window.js')), 'and its test');
    const files = ['main.js', 'preload.js', 'package.json', 'renderer/index.html', 'renderer/renderer.js', 'renderer/styles.css', 'README.md'];
    for (const directory of ['lib', 'flashbrowser']) {
        const walk = (dir) => {
            for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
                const relative = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(relative);
                } else if (/\.(js|json|html|css)$/.test(entry.name)) {
                    files.push(relative);
                }
            }
        };
        walk(directory);
    }
    for (const file of files) {
        const body = fs.readFileSync(path.join(ROOT, file), 'utf8');
        assert.ok(!/ruffle/i.test(body), `${file} names no Ruffle`);
    }
    report('[test-legacy-engine] no Ruffle in the launcher: OK');
}

/** 32-bit Windows and Linux: no FlashBrowser, and with no Flash Player nothing at all starts. */
async function checkWithoutFlashPlayer() {
    startLauncher({ platform: 'linux', arch: 'x64', directories: [] });
    for (const saved of ['flashbrowser', 'projector', ...UNKNOWN_ENGINES]) {
        seedState({ chosenEngine: saved, engine: saved });
        for (const requested of [undefined, 'projector', 'ruffle']) {
            const { result } = await playOnce(requested);
            assert.strictEqual(result.ok, false, `saved ${saved}, asked for ${requested}: nothing can start`);
            assert.match(result.message, /Flash Player is missing/, 'it is Flash Player that is missing');
        }
        const { result } = await playOnce('flashbrowser');
        assert.deepStrictEqual(result, { ok: false, message: 'FlashBrowser is not available on this system. Play Legacy instead.' });
    }
    const state = await invoke('launcher:getState');
    checkState(state, { offered: false, found: false, ready: false });
    assert.strictEqual(state.flash.found, false);
    assert.strictEqual(state.flash.armed, false);
    assert.strictEqual(state.engine, 'projector');
    report('[test-legacy-engine] without Flash Player or FlashBrowser nothing starts, whatever was saved or asked for: OK');
}

/** Where FlashBrowser is not offered, every play is Legacy and the FlashBrowser button says why. */
async function checkNotOffered() {
    installedProjector = FAKE_PROJECTOR;
    for (const [platform, arch] of [
        ['win32', 'ia32'],
        ['linux', 'x64']
    ]) {
        // Even a complete FlashBrowser folder left lying around is not used: there is no build for here.
        startLauncher({ platform, arch, directories: [makeFlashBrowser('win32-x64', { complete: true })] });
        checkState(await invoke('launcher:getState'), { offered: false, found: false, ready: false });

        for (const saved of ['flashbrowser', 'projector', ...UNKNOWN_ENGINES]) {
            seedState({ chosenEngine: saved });
            assert.strictEqual((await invoke('launcher:getState')).engine, 'projector', `${platform}-${arch}, saved ${saved}: Legacy`);
            const plain = await playOnce(undefined);
            assert.strictEqual(plain.engine, 'projector', `${platform}-${arch}, saved ${saved}: a plain play starts Legacy`);
            assert.deepStrictEqual(plain.started.args, [SWF_URL]);

            const refused = await playOnce('flashbrowser');
            assert.deepStrictEqual(refused.result, {
                ok: false,
                message: 'FlashBrowser is not available on this system. Play Legacy instead.'
            });
        }

        const main = await playOnce('projector');
        assert.strictEqual(main.engine, 'projector', 'the main button starts Legacy');
        report(`[test-legacy-engine] ${platform}-${arch}: no FlashBrowser, every play is Legacy: OK`);
    }
}

/** Windows x64 and macOS: Legacy by default, FlashBrowser on its button, and the pick remembered. */
async function checkOffered() {
    installedProjector = FAKE_PROJECTOR;
    for (const [platform, arch, target] of [
        ['win32', 'x64', 'win32-x64'],
        ['win32', 'arm64', 'win32-x64'],
        ['darwin', 'x64', 'darwin-x64'],
        ['darwin', 'arm64', 'darwin-x64']
    ]) {
        const root = makeFlashBrowser(target, { complete: true });
        startLauncher({ platform, arch, directories: [root] });
        const label = `${platform}-${arch}`;
        checkState(await invoke('launcher:getState'), { offered: true, found: true, ready: true, tampered: false });

        // Nobody has picked anything: Legacy.
        seedState();
        assert.strictEqual((await invoke('launcher:getState')).engine, 'projector', `${label}: Legacy is the default`);
        let play = await playOnce(undefined);
        assert.strictEqual(play.engine, 'projector', `${label}: a plain play starts Legacy`);
        assert.ok(!savedState().chosenEngine, 'a plain play picks nothing');

        // Older values, and the older `engine` key, play Legacy.
        for (const saved of UNKNOWN_ENGINES) {
            seedState({ chosenEngine: saved, engine: 'flashbrowser' });
            assert.strictEqual((await invoke('launcher:getState')).engine, 'projector', `${label}, saved ${saved}: Legacy`);
            play = await playOnce(undefined);
            assert.strictEqual(play.engine, 'projector', `${label}, saved ${saved}: a plain play starts Legacy`);
            assert.ok(!('engine' in savedState()), 'the older engine key is dropped on the next write');
            // A play naming an engine this launcher does not have is a plain play.
            play = await playOnce('ruffle');
            assert.strictEqual(play.engine, 'projector');
        }

        // The FlashBrowser button: FlashBrowser, on the game page, with the plugin, at 100 fps.
        seedState();
        play = await playOnce('flashbrowser');
        assert.deepStrictEqual(play.result, { ok: true });
        assert.strictEqual(play.engine, 'flashbrowser', `${label}: the FlashBrowser button starts FlashBrowser`);
        const found = realFlashBrowser.inspectFlashBrowser(root, target);
        assert.strictEqual(play.started.command, found.executable, 'the FlashBrowser runtime is what starts');
        assert.strictEqual(play.started.args[0], found.appDir, 'on the game-window app');
        assert.ok(play.started.args.includes(`--db-game-url=${GAME_URL}`), 'on the game page');
        assert.ok(play.started.args.includes(`--db-plugin=${found.pluginPath}`), 'with the plugin');
        assert.ok(play.started.args.includes(`--db-user-data=${path.join(userData, 'flashbrowser')}`), 'in its own profile');
        assert.ok(!play.started.args.includes('--db-vsync'), 'at the game\'s own frame rate');
        assert.strictEqual(savedState().chosenEngine, 'flashbrowser', 'the pick is remembered');

        // ...so the next plain play -- the start-up play of a remembered player -- is FlashBrowser.
        assert.strictEqual((await invoke('launcher:getState')).engine, 'flashbrowser', `${label}: the saved pick is honoured`);
        play = await playOnce(undefined);
        assert.strictEqual(play.engine, 'flashbrowser', `${label}: a plain play follows the pick`);
        assert.strictEqual(savedState().chosenEngine, 'flashbrowser', 'and keeps it');

        // DB_VSYNC=1 hands the frame pacing back to Chromium.
        process.env.DB_VSYNC = '1';
        try {
            play = await playOnce('flashbrowser');
            assert.ok(play.started.args.includes('--db-vsync'), 'DB_VSYNC=1 keeps vsync');
        } finally {
            delete process.env.DB_VSYNC;
        }

        // The main button goes back to Legacy, and that is remembered too.
        play = await playOnce('projector');
        assert.strictEqual(play.engine, 'projector', `${label}: the main button starts Legacy`);
        assert.deepStrictEqual(play.started.args, [SWF_URL]);
        assert.strictEqual(savedState().chosenEngine, 'projector');
        assert.strictEqual((await invoke('launcher:getState')).engine, 'projector');
        play = await playOnce(undefined);
        assert.strictEqual(play.engine, 'projector');

        report(`[test-legacy-engine] ${label}: Legacy by default, FlashBrowser on its button and remembered: OK`);
    }
}

/** An install whose FlashBrowser is incomplete: a saved FlashBrowser pick plays Legacy. */
async function checkMissing() {
    installedProjector = FAKE_PROJECTOR;
    startLauncher({ platform: 'darwin', arch: 'x64', directories: [makeFlashBrowser('darwin-x64', { complete: false })] });
    const state = await invoke('launcher:getState');
    checkState(state, { offered: true, found: false, ready: false });
    assert.ok(state.flashBrowser.missing.length > 0, 'the state says what FlashBrowser lacks');

    seedState({ chosenEngine: 'flashbrowser' });
    assert.strictEqual((await invoke('launcher:getState')).engine, 'projector', 'a missing FlashBrowser falls back to Legacy');
    const plain = await playOnce(undefined);
    assert.strictEqual(plain.engine, 'projector', 'a plain play starts Legacy');
    assert.strictEqual(savedState().chosenEngine, 'flashbrowser', 'the pick is kept for when FlashBrowser is back');

    const refused = await playOnce('flashbrowser');
    assert.deepStrictEqual(refused.result, {
        ok: false,
        message: 'FlashBrowser is missing. Run `npm run fetch-flash-browser`, or play Legacy.'
    });

    // With no Flash Player either, a saved FlashBrowser pick says what Legacy lacks.
    installedProjector = null;
    startLauncher({ platform: 'darwin', arch: 'x64', directories: [makeFlashBrowser('darwin-x64', { complete: false })] });
    seedState({ chosenEngine: 'flashbrowser' });
    const nothing = await playOnce(undefined);
    assert.strictEqual(nothing.result.ok, false);
    assert.match(nothing.result.message, /Flash Player is missing/);

    // FlashBrowser still plays where Flash Player is missing.
    startLauncher({ platform: 'darwin', arch: 'x64', directories: [makeFlashBrowser('darwin-x64', { complete: true })] });
    seedState();
    assert.match((await playOnce(undefined)).result.message, /Flash Player is missing/, 'the default is still Legacy');
    assert.strictEqual((await playOnce('flashbrowser')).engine, 'flashbrowser', 'and the FlashBrowser button still plays');
    report('[test-legacy-engine] a missing FlashBrowser falls back to Legacy and its button says why: OK');
}

/**
 * A checkout arms no update check, so the update download has nothing to open -- and a URL
 * the window passes is never opened in its place.
 */
async function checkUpdateDownload() {
    const state = await invoke('launcher:getState');
    assert.strictEqual(state.update.state, 'disabled', 'a checkout checks for no updates');
    assert.strictEqual(await invoke('launcher:updateDownload'), false);
    assert.strictEqual(await invoke('launcher:updateDownload', 'https://evil.example/setup.exe'), false);
    assert.strictEqual(await invoke('launcher:updateInstall'), false);
    assert.deepStrictEqual(openedUrls, [], 'nothing was opened in the browser');
    report('[test-legacy-engine] the update download opens nothing it did not find itself: OK');
}

async function main() {
    seedState({ chosenEngine: 'ruffle' });
    const consoleLog = console.log;
    console.log = () => {};
    try {
        checkNoRuffle();
        await checkWithoutFlashPlayer();
        await checkNotOffered();
        await checkOffered();
        await checkMissing();
        await checkUpdateDownload();
    } finally {
        console.log = consoleLog;
        Module._load = originalLoad;
        fs.rmSync(scratch, { recursive: true, force: true });
    }
    console.log('[test-legacy-engine] all assertions passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
