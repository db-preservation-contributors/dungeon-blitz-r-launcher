#!/usr/bin/env node
'use strict';

/**
 * Which engine a play starts: Legacy -- Adobe's standalone Flash Player 32 (lib/projector.js) --
 * is the main button and the default; AIR (lib/airEngine.js) is a second button where the build
 * carries its bundle.
 *
 * main.js itself runs here, with a stand-in for Electron and for the parts that would start
 * real programs (the Flash Player and AIR lookup and launch, the window title, the timer, the
 * game host), and is driven through the same IPC calls the launcher window makes. main.js is
 * loaded once per setup, since it looks for its engines when it starts. It checks that:
 *
 * - a plain play -- the start-up play of a remembered player -- starts Legacy unless the player
 *   last picked AIR with its button and it can run here;
 * - the main button starts Legacy and the AIR button starts AIR, each remembered as
 *   `chosenEngine` for the next plain play;
 * - a saved 'air' falls back to Legacy where the build has no AIR engine, and the AIR button
 *   there says why instead of starting anything;
 * - a saved 'flashbrowser' (FlashBrowser is gone), 'ruffle', an unknown value or the older
 *   `engine` key all play Legacy;
 * - nothing anywhere in the launcher's code or state is Ruffle or FlashBrowser.
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
const UNKNOWN_ENGINES = ['flashbrowser', 'ruffle', 'something-else', ''];

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'db-legacy-engine-'));
const appData = path.join(scratch, 'appData');
const userData = path.join(appData, 'dungeon-blitz-r-launcher');
const statePath = path.join(userData, 'launcher-state.json');

// Nothing from a game checkout next to this one: the official server list only.
process.env.DUNGEON_BLITZ_SERVER_ROOT = path.join(scratch, 'no-server-checkout');
// Nothing that would reach a server or Discord while the fake game runs.
process.env.DUNGEON_BLITZ_GAME_STATS = '0';
process.env.DUNGEON_BLITZ_DAMAGE_METER = '0';

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

// The AIR bundle the build carries: null (none), or a stand-in.
const FAKE_AIR = { path: path.join(scratch, 'DungeonBlitzR'), executable: path.join(scratch, 'DungeonBlitzR', 'DungeonBlitzR.exe') };
let machine = { air: null };

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

const realAir = require('../lib/airEngine');
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
    // The real launch, on the bundle the test says this build carries.
    './lib/airEngine': {
        ...realAir,
        findAirApp: () => (machine.air ? { ...machine.air } : null)
    },
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

/** The launcher state names Flash Player, AIR as `expected`, and no Ruffle or FlashBrowser. */
function checkState(state, expected) {
    assert.ok(state.flash && typeof state.flash === 'object', 'the state reports Flash Player');
    assert.ok(state.air && typeof state.air === 'object', 'and AIR');
    for (const [key, value] of Object.entries(expected)) {
        assert.strictEqual(state.air[key], value, `air.${key}`);
    }
    assert.ok(['projector', 'air'].includes(state.engine), `the preferred engine is one this launcher has (${state.engine})`);
    assert.ok(!/ruffle|flashbrowser/i.test(JSON.stringify(state)), 'Ruffle and FlashBrowser appear nowhere in the state');
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
    const engine = started.command === FAKE_PROJECTOR.executable ? 'projector' : 'air';
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
    assert.ok(!fs.existsSync(path.join(ROOT, 'lib', 'flashBrowser.js')), 'lib/flashBrowser.js is gone');
    assert.ok(!fs.existsSync(path.join(ROOT, 'flashbrowser')), 'and its game-window app');
    const files = ['main.js', 'preload.js', 'package.json', 'renderer/index.html', 'renderer/renderer.js', 'renderer/styles.css', 'README.md'];
    for (const directory of ['lib', 'air']) {
        const walk = (dir) => {
            for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
                const relative = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(relative);
                } else if (/\.(js|json|html|css|as|xml)$/.test(entry.name)) {
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

/** Without Flash Player or AIR nothing at all starts. */
async function checkWithoutFlashPlayer() {
    installedProjector = null;
    startLauncher({ air: null });
    for (const saved of ['air', 'projector', ...UNKNOWN_ENGINES]) {
        seedState({ chosenEngine: saved, engine: saved });
        for (const requested of [undefined, 'projector', 'ruffle', 'flashbrowser']) {
            const { result } = await playOnce(requested);
            assert.strictEqual(result.ok, false, `saved ${saved}, asked for ${requested}: nothing can start`);
            assert.match(result.message, /Flash Player is missing/, 'it is Flash Player that is missing');
        }
        const { result } = await playOnce('air');
        assert.deepStrictEqual(result, {
            ok: false,
            message: 'The AIR engine is missing. Run `npm run build-air` with AIR_SDK_HOME set, or play Legacy.'
        });
    }
    const state = await invoke('launcher:getState');
    checkState(state, { found: false, ready: false });
    assert.strictEqual(state.flash.found, false);
    assert.strictEqual(state.engine, 'projector');
    report('[test-legacy-engine] without Flash Player or AIR nothing starts, whatever was saved or asked for: OK');
}

/** No AIR engine in the build: every play is Legacy, and a saved AIR pick falls back to it. */
async function checkNoAir() {
    installedProjector = FAKE_PROJECTOR;
    startLauncher({ air: null });
    checkState(await invoke('launcher:getState'), { found: false, ready: false });
    for (const saved of ['air', 'projector', ...UNKNOWN_ENGINES]) {
        seedState({ chosenEngine: saved });
        assert.strictEqual((await invoke('launcher:getState')).engine, 'projector', `saved ${saved}: Legacy`);
        const plain = await playOnce(undefined);
        assert.strictEqual(plain.engine, 'projector', `saved ${saved}: a plain play starts Legacy`);
        assert.deepStrictEqual(plain.started.args, [SWF_URL]);
        const refused = await playOnce('air');
        assert.strictEqual(refused.result.ok, false, 'the AIR button starts nothing without the engine');
    }
    report('[test-legacy-engine] no AIR engine, every play is Legacy: OK');
}

/** A build with the AIR engine: Legacy by default, AIR on its button, and the pick remembered. */
async function checkAir() {
    installedProjector = FAKE_PROJECTOR;
    startLauncher({ air: FAKE_AIR });
    checkState(await invoke('launcher:getState'), { found: true, ready: true, tampered: false });

    seedState();
    assert.strictEqual((await invoke('launcher:getState')).engine, 'projector', 'Legacy is the default');
    let play = await playOnce(undefined);
    assert.strictEqual(play.engine, 'projector', 'a plain play starts Legacy');
    assert.ok(!savedState().chosenEngine, 'a plain play picks nothing');

    for (const saved of UNKNOWN_ENGINES) {
        seedState({ chosenEngine: saved, engine: 'flashbrowser' });
        assert.strictEqual((await invoke('launcher:getState')).engine, 'projector', `saved ${saved}: Legacy`);
        play = await playOnce(undefined);
        assert.strictEqual(play.engine, 'projector', `saved ${saved}: a plain play starts Legacy`);
        assert.ok(!('engine' in savedState()), 'the older engine key is dropped on the next write');
        play = await playOnce('flashbrowser');
        assert.strictEqual(play.engine, 'projector', 'a play naming FlashBrowser is a plain play');
    }

    seedState();
    play = await playOnce('air');
    assert.deepStrictEqual(play.result, { ok: true });
    assert.strictEqual(play.engine, 'air', 'the AIR button starts AIR');
    assert.strictEqual(play.started.command, FAKE_AIR.executable, 'the AIR bundle is what starts');
    assert.strictEqual(play.started.args[0], SWF_URL, 'on the game SWF');
    assert.strictEqual(savedState().chosenEngine, 'air', 'the pick is remembered');

    assert.strictEqual((await invoke('launcher:getState')).engine, 'air', 'the saved pick is honoured');
    play = await playOnce(undefined);
    assert.strictEqual(play.engine, 'air', 'a plain play follows the pick');

    play = await playOnce('projector');
    assert.strictEqual(play.engine, 'projector', 'the main button starts Legacy');
    assert.strictEqual(savedState().chosenEngine, 'projector');
    play = await playOnce(undefined);
    assert.strictEqual(play.engine, 'projector');

    // AIR still plays where Flash Player is missing.
    installedProjector = null;
    startLauncher({ air: FAKE_AIR });
    seedState();
    assert.match((await playOnce(undefined)).result.message, /Flash Player is missing/, 'the default is still Legacy');
    assert.strictEqual((await playOnce('air')).engine, 'air', 'and the AIR button still plays');
    report('[test-legacy-engine] Legacy by default, AIR on its button and remembered: OK');
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
        await checkNoAir();
        await checkAir();
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
