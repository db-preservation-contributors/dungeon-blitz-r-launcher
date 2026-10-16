#!/usr/bin/env node
'use strict';

/**
 * The launcher has one game engine: Legacy, Adobe's standalone Flash Player 32 (lib/projector.js).
 *
 * main.js itself runs here, with a stand-in for Electron and for the parts that would start
 * real programs (the Flash Player lookup and launch, the window title, the timer, the game
 * host), and is driven through the same IPC calls the launcher window makes. It checks that:
 *
 * - every play starts the standalone Flash Player, whatever the call names and whatever engine
 *   an older launcher saved as `chosenEngine` -- and the next write drops that saved value;
 * - with no Flash Player there is nothing else to fall back to: the play says Flash Player is
 *   missing and nothing starts;
 * - the launcher state reports Flash Player and no other engine.
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

// The engines older launchers offered, as they wrote them into launcher-state.json.
const OLD_ENGINES = ['ruffle', 'flashbrowser', 'projector', 'something-else'];

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'db-legacy-engine-'));
const appData = path.join(scratch, 'appData');
const userData = path.join(appData, 'dungeon-blitz-r-launcher');
const statePath = path.join(userData, 'launcher-state.json');

// Nothing from a game checkout next to this one: the official server list only.
process.env.DUNGEON_BLITZ_SERVER_ROOT = path.join(scratch, 'no-server-checkout');
// Nothing that would reach a server or Discord while the fake game runs.
process.env.DUNGEON_BLITZ_GAME_STATS = '0';
process.env.DUNGEON_BLITZ_DAMAGE_METER = '0';

/** Writes launcher-state.json as an older launcher would have left it. */
function seedState(extra) {
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
    shell: { openExternal: async () => {} }
};

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

async function invoke(channel, ...args) {
    const handler = handlers.get(channel);
    assert.ok(handler, `main.js handles ${channel}`);
    return handler({}, ...args);
}

/** The launcher state names Flash Player and nothing else. */
function checkState(state) {
    assert.ok(state.flash && typeof state.flash === 'object', 'the state reports Flash Player');
    for (const key of ['flashBrowser', 'engine', 'gameEngine']) {
        assert.ok(!(key in state), `the state has no "${key}"`);
    }
    assert.ok(!/ruffle|flash-?browser/i.test(JSON.stringify(state)), 'no other engine appears anywhere in the state');
}

async function checkWithoutFlashPlayer() {
    for (const saved of OLD_ENGINES) {
        seedState({ chosenEngine: saved, engine: saved });
        for (const requested of [undefined, 'ruffle', 'flashbrowser', 'projector']) {
            const result = await invoke('launcher:play', requested);
            assert.strictEqual(result.ok, false, `saved ${saved}, asked for ${requested}: nothing can start`);
            assert.match(result.message, /Flash Player is missing/, 'it is Flash Player that is missing');
        }
    }
    assert.strictEqual(spawned.length, 0, 'nothing was started');

    const state = await invoke('launcher:getState');
    checkState(state);
    assert.strictEqual(state.flash.found, false);
    assert.strictEqual(state.flash.armed, false);
    assert.strictEqual(state.gameRunning, false);
    report('[test-legacy-engine] without Flash Player nothing starts, whatever engine was saved or asked for: OK');
}

async function checkPlaysLegacy() {
    // The picker in a development checkout finds the stand-in from here on.
    installedProjector = FAKE_PROJECTOR;
    checkState(await invoke('launcher:browseFlash'));
    const ready = await invoke('launcher:getState');
    assert.strictEqual(ready.flash.armed, true, 'the Flash Player is ready');

    for (const saved of OLD_ENGINES) {
        for (const requested of [undefined, 'ruffle', 'flashbrowser']) {
            seedState({ chosenEngine: saved, engine: saved });
            spawned.length = 0;

            const result = await invoke('launcher:play', requested);
            assert.deepStrictEqual(result, { ok: true }, `saved ${saved}, asked for ${requested}: the game starts`);
            assert.strictEqual(spawned.length, 1, 'one program is started');
            assert.strictEqual(spawned[0].command, FAKE_PROJECTOR.executable, 'and it is the standalone Flash Player');
            assert.deepStrictEqual(spawned[0].args, ['http://dungeonblitzr.theminesa.studio/p/cbp/DungeonBlitz.swf']);

            const running = await invoke('launcher:getState');
            checkState(running);
            assert.strictEqual(running.gameRunning, true);

            const onDisk = savedState();
            assert.ok(!('chosenEngine' in onDisk), `the saved ${saved} is gone from launcher-state.json`);
            assert.ok(!('engine' in onDisk), 'and so is the older engine key');
            assert.strictEqual(onDisk.serverId, 'official');

            // Flash Player closing ends the game session.
            spawned[0].child.emit('exit', 0, null);
            assert.strictEqual((await invoke('launcher:getState')).gameRunning, false);
        }
    }
    report('[test-legacy-engine] every play starts the standalone Flash Player and drops the saved engine: OK');
}

async function main() {
    seedState({ chosenEngine: 'ruffle' });
    const consoleLog = console.log;
    console.log = () => {};
    require(MAIN);
    try {
        await checkWithoutFlashPlayer();
        await checkPlaysLegacy();
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
