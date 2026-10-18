#!/usr/bin/env node
'use strict';

/**
 * Checks what the launcher window actually renders -- the status rows (Discord rich
 * presence, lobby chat, the widget profile, the version), the problem banner and the
 * account row --
 * for every combination of state, without needing Electron: renderer.js runs against a
 * minimal DOM stub and the results are read back.
 *
 * Usage: node tools/test-launcher-status.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class StubElement {
    constructor(tag = 'div') {
        this.tagName = tag;
        this.children = [];
        this.hidden = false;
        this.disabled = false;
        this.className = '';
        this.textContent = '';
        this.title = '';
        this.value = '';
        this.listeners = {};
    }

    addEventListener(type, handler) {
        this.listeners[type] = handler;
    }

    append(...nodes) {
        this.children.push(...nodes);
    }

    replaceChildren(...nodes) {
        this.children = nodes;
    }

    querySelector() {
        if (!this.querySelectorStub) {
            this.querySelectorStub = new StubElement('span');
        }
        return this.querySelectorStub;
    }
}

/** Runs renderer/renderer.js in a stub DOM and hands back the elements it filled in. */
function loadRenderer() {
    const registry = new Map();
    const document = {
        getElementById: (id) => {
            if (!registry.has(id)) {
                registry.set(id, new StubElement());
            }
            return registry.get(id);
        },
        createElement: (tag) => new StubElement(tag)
    };

    let render = null;
    // The calls the window made: each play, with the engine it named, and the other buttons'
    // calls by name.
    const plays = [];
    const window = {
        launcher: {
            onState: (handler) => {
                render = handler;
            },
            // The test drives render() itself, so the initial fetch never settles.
            getState: () => new Promise(() => {}),
            play: async (...args) => {
                plays.push(args.length ? `play(${args.join(', ')})` : 'play');
                return { ok: true };
            },
            discordLogin: async () => ({ ok: true }),
            submitLoginCode: async (code) => {
                plays.push(`code:${code}`);
                return { ok: true };
            },
            copySignInLink: async () => {
                plays.push('copy-sign-in-link');
                return { ok: true };
            },
            forgetDiscordLogin: async () => null,
            browseFlash: async () => null,
            moveToApplications: async () => ({ ok: true }),
            relaunch: () => {},
            gameStatsSync: async () => null,
            damageMeterOpen: async () => {
                plays.push('damage-meter');
                return true;
            },
            quit: () => {}
        }
    };

    const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
    vm.runInNewContext(source, { document, window, console });

    assert.ok(render, 'renderer.js must register a state handler');
    // The suite swaps a call out now and then to see how the window answers.
    registry.launcher = window.launcher;
    return { render, registry, plays };
}

function rowsFrom(registry) {
    const status = registry.get('engine-status');
    return status.children.map((row) => {
        const [label, value] = row.children;
        return { label: label.textContent, value: value.textContent, tone: value.className, detail: value.title };
    });
}

function row(rows, label) {
    const found = rows.find((entry) => entry.label === label);
    assert.ok(found, `expected a "${label}" row`);
    return found;
}

function baseState(flash, social, extra = {}) {
    return {
        appVersion: '1.0.0',
        servers: [{ id: 'official', name: 'Dungeon Blitz: R', url: 'http://example.test/' }],
        selectedServerUrl: 'http://example.test/',
        serverReachable: true,
        gameRunning: false,
        flash,
        flashBrowser: extra.flashBrowser,
        social,
        presence: extra.presence || {
            running: false,
            ready: false,
            port: 0,
            characterName: '',
            activity: '',
            lastError: ''
        },
        chat: extra.chat || { enabled: true, running: false, supported: null, relayed: 0, received: 0, lastError: '' },
        gameStats: extra.gameStats || {
            enabled: true,
            running: false,
            state: 'idle',
            written: false,
            username: '',
            updatedAt: 0,
            lastError: ''
        },
        update: extra.update || { state: 'not-available', percent: 0, version: '', error: '', currentVersion: '1.0.0' },
        windows: extra.windows || {
            supported: true,
            product: 'Windows 10 or later',
            reason: '',
            requirements: ''
        },
        install: extra.install || { relocate: false, reason: '', message: '', sourcePath: '', targetPath: '', canMove: false },
        discord: extra.discord || { linked: false, email: '', name: '', remembered: false, loginPending: false },
        damageMeter: extra.damageMeter || {
            enabled: true,
            open: false,
            session: false,
            running: false,
            supported: null,
            live: false,
            character: '',
            lastError: ''
        }
    };
}

const ARMED_FLASH = {
    found: true,
    armed: true,
    path: '/Applications/Dungeon Blitz R.app/Contents/Resources/vendor/projector/darwin/Flash Player.app',
    version: '32.0.0.465',
    source: 'vendor',
    architectures: ['x64'],
    archMismatch: false
};

const MISSING_FLASH = {
    found: false,
    armed: false,
    path: '',
    version: '',
    source: '',
    architectures: [],
    archMismatch: false
};

const IDLE_SOCIAL = {
    enabled: true,
    running: false,
    lobbyReady: false,
    authPending: false,
    lobbyId: '',
    lastStatus: ''
};

/** The damage meter's button: offered once there is an account, and it opens the meter's window. */
async function checkDamageMeterButton(render, registry, plays) {
    const button = () => registry.get('damage-meter-open');
    const signedIn = { linked: true, email: '', name: 'Kuri', remembered: true, loginPending: false };

    // A fresh install's sign-in screen: there is nothing for the meter to read yet.
    render(baseState(ARMED_FLASH, IDLE_SOCIAL));
    assert.strictEqual(button().hidden, true, 'no damage meter before there is an account');
    assert.strictEqual(registry.get('tools').hidden, true, 'and no empty row under the status strip');

    // Signed in: offered before the first game, so the window can be placed beside it.
    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { discord: signedIn }));
    assert.strictEqual(button().hidden, false, 'the damage meter is offered once signed in');
    assert.strictEqual(registry.get('tools').hidden, false);

    await button().listeners.click();
    assert.strictEqual(plays[plays.length - 1], 'damage-meter', 'the button opens the meter window');

    // Turned off with DUNGEON_BLITZ_DAMAGE_METER=0.
    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { discord: signedIn, damageMeter: { enabled: false } }));
    assert.strictEqual(button().hidden, true, 'no button when the meter is turned off');
    assert.strictEqual(registry.get('tools').hidden, true);

    console.log('[test-launcher-status] the damage meter button shows when it should and opens the meter');
}

const READY_BROWSER = { offered: true, found: true, ready: true, locked: true, tampered: false, missing: [] };
const NO_BROWSER = { offered: false, found: false, ready: false, locked: true, tampered: false, missing: [] };

/**
 * The play buttons. The main one plays Legacy, the standalone Flash Player, everywhere.
 * FlashBrowser -- the smoother engine -- is a second button only where this system has one
 * (Windows x64 and macOS); everywhere else the window is the one-button launcher of 1.6.0.
 */
async function checkPlayButtons(render, registry, plays) {
    const press = async (id) => {
        await registry.get(id).listeners.click();
        // playWith() awaits the launcher's play call; let it settle.
        await new Promise((resolve) => setImmediate(resolve));
    };

    // No Ruffle anywhere in the window, and no separate Legacy button: the main button is Legacy.
    const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
    const script = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
    assert.ok(!/ruffle/i.test(html) && !/ruffle/i.test(script), 'the window names no Ruffle');
    assert.ok(!html.includes('play-projector') && !script.includes('play-projector'), 'there is no second Legacy button');
    const flashBrowserButton = /<button id="play-flashbrowser"[^>]*class="db-play-alt"[^>]*>([^<]*)<\/button>/.exec(html);
    assert.ok(flashBrowserButton, 'the FlashBrowser button is in the window, in the alt-engine style');
    assert.match(flashBrowserButton[1], /FlashBrowser/);
    assert.match(flashBrowserButton[1], /smoother/i, 'its label says why a player would pick it');
    assert.match(flashBrowserButton[1], /100 FPS/);
    assert.match(html, /<div id="alt-engine" class="alt-engine" hidden>/, 'it starts hidden until the state offers it');

    // Windows x64 and macOS: Legacy is the main button, FlashBrowser the second.
    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { flashBrowser: READY_BROWSER }));
    assert.strictEqual(registry.get('play').disabled, false, 'Legacy can be started');
    assert.strictEqual(registry.get('alt-engine').hidden, false, 'FlashBrowser is offered next to it');
    assert.strictEqual(registry.get('play-flashbrowser').disabled, false);
    assert.strictEqual(registry.get('problem').hidden, true);
    plays.length = 0;
    await press('play');
    await press('play-flashbrowser');
    assert.deepStrictEqual(plays, ['play(projector)', 'play(flashbrowser)'], 'the main button starts Legacy, the other FlashBrowser');

    // A player who picked FlashBrowser last time: the main button is still Legacy.
    render({ ...baseState(ARMED_FLASH, IDLE_SOCIAL, { flashBrowser: READY_BROWSER }), engine: 'flashbrowser' });
    plays.length = 0;
    await press('play');
    assert.deepStrictEqual(plays, ['play(projector)'], 'the main button never becomes FlashBrowser');

    // 32-bit Windows and Linux have no FlashBrowser: one button, exactly as in 1.6.0.
    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { flashBrowser: NO_BROWSER }));
    assert.strictEqual(registry.get('alt-engine').hidden, true, 'no FlashBrowser button without a FlashBrowser');
    assert.strictEqual(registry.get('play').disabled, false);
    assert.strictEqual(registry.get('problem').hidden, true, 'nothing is said about an engine this system never had');
    plays.length = 0;
    await press('play');
    assert.deepStrictEqual(plays, ['play(projector)'], 'the main button plays Legacy');

    // A state from a main process that names no FlashBrowser at all, or still carries Ruffle.
    render({ ...baseState(ARMED_FLASH, IDLE_SOCIAL), engine: 'ruffle', gameEngine: '' });
    assert.strictEqual(registry.get('alt-engine').hidden, true);
    assert.strictEqual(registry.get('play').disabled, false);
    assert.strictEqual(registry.get('problem').hidden, true);
    plays.length = 0;
    await press('play');
    assert.deepStrictEqual(plays, ['play(projector)']);

    // No server to play on: nothing can be started.
    render({ ...baseState(ARMED_FLASH, IDLE_SOCIAL, { flashBrowser: READY_BROWSER }), servers: [] });
    assert.strictEqual(registry.get('play').disabled, true, 'no server, no game');
    assert.strictEqual(registry.get('play-flashbrowser').disabled, true);

    // An install whose FlashBrowser is gone: said last, in the banner, and Legacy still plays.
    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { flashBrowser: { ...READY_BROWSER, found: false, ready: false } }));
    assert.strictEqual(registry.get('alt-engine').hidden, false);
    assert.strictEqual(registry.get('play-flashbrowser').disabled, true, 'a missing FlashBrowser cannot be started');
    assert.strictEqual(registry.get('play').disabled, false, 'Legacy still can');
    assert.strictEqual(
        registry.get('problem').textContent,
        'FlashBrowser is missing from this install. Reinstall the launcher to use it; the main button still plays.'
    );
    assert.strictEqual(registry.get('problem').className, 'problem');

    // A checkout that never fetched it.
    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { flashBrowser: { ...READY_BROWSER, locked: false, found: false, ready: false } }));
    assert.ok(registry.get('problem').textContent.includes('npm run fetch-flash-browser'), registry.get('problem').textContent);

    // A FlashBrowser changed after installation is refused, the same as a changed Flash Player.
    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { flashBrowser: { ...READY_BROWSER, ready: false, tampered: true } }));
    assert.strictEqual(registry.get('play-flashbrowser').disabled, true);
    assert.strictEqual(registry.get('play').disabled, false);
    assert.ok(registry.get('problem').textContent.includes('FlashBrowser files were changed after installation'));
    assert.strictEqual(registry.get('problem').className, 'problem bad');

    // A Flash Player changed after installation is refused, and so is the main button. Its
    // fault outranks FlashBrowser's.
    render(
        baseState({ ...ARMED_FLASH, armed: false, locked: true, tampered: true }, IDLE_SOCIAL, {
            flashBrowser: { ...READY_BROWSER, found: false, ready: false }
        })
    );
    assert.strictEqual(registry.get('play').disabled, true, 'a tampered Flash Player cannot be started');
    assert.ok(registry.get('problem').textContent.includes('Flash Player files were changed'), registry.get('problem').textContent);
    assert.ok(registry.get('problem').textContent.includes('Reinstall the launcher to play'));
    assert.strictEqual(registry.get('problem').className, 'problem bad');

    // A broken Flash Player leaves a ready FlashBrowser playable.
    render(baseState({ ...ARMED_FLASH, armed: false, locked: true, tampered: true }, IDLE_SOCIAL, { flashBrowser: READY_BROWSER }));
    assert.strictEqual(registry.get('play').disabled, true);
    assert.strictEqual(registry.get('play-flashbrowser').disabled, false);

    // A missing one is what stops the main button.
    render(baseState({ ...MISSING_FLASH, locked: true }, IDLE_SOCIAL));
    assert.strictEqual(registry.get('play').disabled, true);
    assert.strictEqual(registry.get('problem').className, 'problem bad');
    assert.strictEqual(registry.get('problem').textContent, 'Flash Player is missing from this install. Reinstall the launcher to play.');

    // A checkout points the launcher at one by hand.
    render(baseState(MISSING_FLASH, IDLE_SOCIAL));
    assert.strictEqual(registry.get('problem').textContent, 'Flash Player is missing. Point the launcher at it to play.');
    assert.strictEqual(registry.get('browse-flash').hidden, false, 'a checkout offers the Flash Player picker');

    // One built for an architecture this machine cannot run.
    render(baseState({ ...ARMED_FLASH, armed: false, architectures: ['arm64'], archMismatch: true }, IDLE_SOCIAL));
    assert.strictEqual(registry.get('play').disabled, true);
    assert.ok(registry.get('problem').textContent.includes('arm64 program and cannot run on this machine'));

    // The answer to the player's own pick comes before the Flash Player it is about.
    render({ ...baseState(MISSING_FLASH, IDLE_SOCIAL), notice: 'That is not the standalone Flash Player (flashplayer_32_sa).' });
    assert.strictEqual(registry.get('problem').textContent, 'That is not the standalone Flash Player (flashplayer_32_sa).');

    // Both the Flash Player and the server keep the game from starting; the Flash Player is said.
    render({ ...baseState(MISSING_FLASH, IDLE_SOCIAL), serverReachable: false });
    assert.ok(registry.get('problem').textContent.includes('Flash Player is missing'));
    render({ ...baseState(ARMED_FLASH, IDLE_SOCIAL), serverReachable: false });
    assert.strictEqual(registry.get('problem').textContent, 'Could not reach http://example.test/');
    // An unreachable server outranks a missing FlashBrowser.
    render({
        ...baseState(ARMED_FLASH, IDLE_SOCIAL, { flashBrowser: { ...READY_BROWSER, found: false, ready: false } }),
        serverReachable: false
    });
    assert.strictEqual(registry.get('problem').textContent, 'Could not reach http://example.test/');

    // A failed play says why, and both buttons come back.
    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { flashBrowser: READY_BROWSER }));
    const launcher = registry.launcher;
    const play = launcher.play;
    launcher.play = async () => ({ ok: false, message: 'Flash Player could not be started: ENOENT' });
    await press('play');
    launcher.play = play;
    assert.strictEqual(registry.get('problem').textContent, 'Flash Player could not be started: ENOENT');
    assert.strictEqual(registry.get('play').disabled, false, 'the button comes back for another try');
    assert.strictEqual(registry.get('play-flashbrowser').disabled, false);

    // The status line while the game runs: FlashBrowser is named; Legacy reads as in 1.6.0.
    for (const gameEngine of [undefined, '', 'projector', 'ruffle']) {
        render({ ...baseState(ARMED_FLASH, IDLE_SOCIAL), gameEngine, gameRunning: true });
        assert.strictEqual(registry.get('status').textContent, 'The game is running.');
    }
    render({ ...baseState(ARMED_FLASH, IDLE_SOCIAL, { flashBrowser: READY_BROWSER }), gameEngine: 'flashbrowser', gameRunning: true });
    assert.strictEqual(registry.get('status').textContent, 'The game is running (FlashBrowser).');

    console.log('[test-launcher-status] Legacy is the main button, FlashBrowser a second one where it exists: OK');
}

/** While a sign-in waits on the browser, its link can be copied -- and only then. */
async function checkCopySignInLink(render, registry, plays) {
    const pending = { linked: false, email: '', name: '', remembered: false, loginPending: true, loginLinkAvailable: true };

    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { discord: pending }));
    assert.strictEqual(registry.get('copy-login').hidden, false, 'a pending sign-in offers its link');
    assert.strictEqual(registry.get('status').textContent, 'Finish signing in in your browser...');

    plays.length = 0;
    await registry.get('copy-login').listeners.click();
    assert.deepStrictEqual(plays, ['copy-sign-in-link'], 'the button copies the link');
    assert.ok(registry.get('copy-login').textContent.includes('copied'), 'and says so');

    render(baseState(ARMED_FLASH, IDLE_SOCIAL));
    assert.strictEqual(registry.get('copy-login').hidden, true, 'no sign-in in progress, no link');
    assert.ok(registry.get('copy-login').textContent.includes("Browser didn't open"), 'the label resets for the next sign-in');

    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { discord: { ...pending, loginLinkAvailable: false } }));
    assert.strictEqual(registry.get('copy-login').hidden, true, 'nothing to copy, no button');

    console.log('[test-launcher-status] a pending sign-in offers its link to copy: OK');
}

/** A launcher the server cannot match by address asks for the code the browser page shows. */
async function checkLoginCode(render, registry, plays) {
    const pending = { linked: false, email: '', name: '', remembered: false, loginPending: true, loginLinkAvailable: true };

    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { discord: pending }));
    assert.strictEqual(registry.get('login-code').hidden, true, 'no code box until the server asks');

    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { discord: { ...pending, loginCodeRequired: true } }));
    assert.strictEqual(registry.get('login-code').hidden, false, 'the server asked: the box appears');
    assert.strictEqual(registry.get('login-code-error').hidden, true);
    assert.strictEqual(registry.get('status').textContent, 'Enter the code from your browser.');

    plays.length = 0;
    registry.get('login-code-input').value = ' k7qm-4xpa ';
    await registry.get('login-code-submit').listeners.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(plays, ['code:k7qm-4xpa'], 'Confirm sends what was typed');

    plays.length = 0;
    await registry.get('login-code-input').listeners.keydown({ key: 'Enter' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(plays, ['code:k7qm-4xpa'], 'and so does Enter');

    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { discord: { ...pending, loginCodeRequired: true, loginCodeRejected: true } }));
    assert.strictEqual(registry.get('login-code-error').hidden, false, 'a wrong code is said');

    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { discord: { ...pending, loginPending: false, loginCodeEnded: true } }));
    assert.strictEqual(registry.get('login-code').hidden, true);
    assert.strictEqual(registry.get('login-code-input').value, '', 'the box is emptied when it goes away');
    assert.ok(registry.get('problem').textContent.includes('Too many wrong codes'), 'too many wrong codes end the sign-in, and say so');

    console.log('[test-launcher-status] a launcher at another address asks for the browser code: OK');
}

async function main() {
    const { render, registry, plays } = loadRenderer();

    // Armed plugin, Discord reached, lobby chat connected, chat mirror running.
    render(
        baseState(
            ARMED_FLASH,
            { ...IDLE_SOCIAL, running: true, lobbyReady: true, lobbyId: 'lobby-1', lastStatus: 'Lobby chat connected.' },
            {
                presence: {
                    running: true,
                    ready: true,
                    port: 47631,
                    characterName: 'BridgeProbe',
                    activity: 'Home - Idling in town',
                    lastError: ''
                },
                chat: { enabled: true, running: true, supported: true, relayed: 3, received: 1, lastError: '' }
            }
        )
    );
    let rows = rowsFrom(registry);
    assert.deepStrictEqual(
        rows.map((entry) => [entry.label, entry.value, entry.tone]),
        [
            ['Discord status', 'Home - Idling in town', 'ok'],
            ['Lobby chat', 'connected', 'ok'],
            ['Game stats', 'starts with the game', 'muted'],
            ['Version', 'v1.0.0 - up to date', 'muted']
        ],
        'only the four rows a player cares about'
    );
    for (const hidden of ['Windows', 'Flash', 'In-game chat', 'Update']) {
        assert.ok(!rows.some((entry) => entry.label === hidden), `no ${hidden} row`);
    }
    assert.strictEqual(row(rows, 'Lobby chat').detail, 'Lobby chat connected.');
    assert.ok(row(rows, 'Discord status').detail.includes('47631'), 'the local presence endpoint is the tooltip');

    // A Flash Player that no longer matches the installed one: refused, and said so.
    // There is no Flash row any more: the banner is where it is said.
    render(baseState({ ...ARMED_FLASH, armed: false, locked: true, tampered: true }, IDLE_SOCIAL));
    assert.ok(registry.get('problem').textContent.includes('Reinstall'), registry.get('problem').textContent);
    assert.strictEqual(registry.get('play').disabled, true, 'a tampered Flash Player cannot be started');
    assert.strictEqual(registry.get('browse-flash').hidden, true, 'an installed launcher offers no Flash Player picker');

    // Everything idle is normal: presence and chat both start with the game.
    render(baseState(MISSING_FLASH, IDLE_SOCIAL));
    rows = rowsFrom(registry);
    assert.ok(registry.get('problem').textContent.includes('Flash Player is missing'), 'a missing Flash Player is in the banner');
    assert.strictEqual(row(rows, 'Discord status').value, 'starts with the game');
    assert.strictEqual(row(rows, 'Discord status').tone, 'muted');
    assert.strictEqual(row(rows, 'Lobby chat').value, 'starts with the game');

    // Discord closed while the game runs: presence cannot be published.
    render(
        baseState(ARMED_FLASH, IDLE_SOCIAL, {
            presence: { running: true, ready: false, port: 47631, characterName: '', activity: '', lastError: 'Discord is not running.' }
        })
    );
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Discord status').value, 'waiting for Discord');
    assert.strictEqual(row(rows, 'Discord status').tone, 'warn');
    assert.strictEqual(row(rows, 'Discord status').detail, 'Discord is not running.');

    // The widget row: a written profile is the one state that means the widget has data to
    // show -- which is exactly what a player sees, or does not see, on their own profile and
    // on a friend's.
    render(
        baseState(ARMED_FLASH, IDLE_SOCIAL, {
            gameStats: {
                enabled: true,
                running: true,
                state: 'written',
                written: true,
                username: 'BridgeProbe',
                updatedAt: 1700000000000,
                lastError: ''
            }
        })
    );
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Game stats').value, 'profile written');
    assert.strictEqual(row(rows, 'Game stats').tone, 'ok');
    assert.ok(row(rows, 'Game stats').detail.includes('BridgeProbe'), 'the account written for is the tooltip');
    assert.strictEqual(registry.get('game-stats-sync').hidden, false, 'the manual sync is offered during a session');

    // No linked Discord account: the widget has nobody to be written for, and that is a
    // different fix from a server fault.
    render(
        baseState(ARMED_FLASH, IDLE_SOCIAL, {
            gameStats: {
                enabled: true,
                running: true,
                state: 'unlinked',
                written: false,
                username: '',
                updatedAt: 0,
                lastError: 'Sign in with Discord in the game so the widget has an account to write.'
            }
        })
    );
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Game stats').value, 'no Discord account linked');
    assert.strictEqual(row(rows, 'Game stats').tone, 'warn');
    assert.ok(row(rows, 'Game stats').detail.includes('Sign in with Discord'));

    // A server that has not been redeployed with the route: said plainly, so an empty widget
    // is not mistaken for a broken account.
    render(
        baseState(ARMED_FLASH, IDLE_SOCIAL, {
            gameStats: {
                enabled: true,
                running: true,
                state: 'unsupported',
                written: false,
                username: '',
                updatedAt: 0,
                lastError: 'This server cannot write Discord widget stats yet.'
            }
        })
    );
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Game stats').value, 'server cannot write it');
    assert.strictEqual(row(rows, 'Game stats').tone, 'warn');

    // On the sign-in screen there is no session to ask, so there is no button to press.
    render(baseState(ARMED_FLASH, IDLE_SOCIAL));
    assert.strictEqual(registry.get('game-stats-sync').hidden, true, 'no sync button without a session');

    // Lobby chat turned off by configuration.
    render(baseState(ARMED_FLASH, { ...IDLE_SOCIAL, enabled: false }));
    assert.strictEqual(row(rowsFrom(registry), 'Lobby chat').value, 'off');

    // Waiting for the Discord consent dialog.
    render(
        baseState(ARMED_FLASH, { ...IDLE_SOCIAL, running: true, authPending: true, lastStatus: 'Asking Discord to authorize the launcher...' })
    );
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Lobby chat').value, 'waiting for Discord approval');
    assert.strictEqual(row(rows, 'Lobby chat').tone, 'warn');
    assert.strictEqual(row(rows, 'Lobby chat').detail, 'Asking Discord to authorize the launcher...');

    // Starting up, nothing settled yet.
    render(baseState(ARMED_FLASH, { ...IDLE_SOCIAL, running: true, lastStatus: 'JavaScript social bridge starting...' }));
    assert.strictEqual(row(rowsFrom(registry), 'Lobby chat').value, 'connecting...');

    // The Discord client being closed is the common "never connects" cause; the row must
    // name it instead of leaving an errno to decode.
    render(
        baseState(ARMED_FLASH, {
            ...IDLE_SOCIAL,
            running: true,
            lastStatus: 'The Discord desktop client is not running. Start Discord, then start the game again.'
        })
    );
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Lobby chat').value, 'Discord client not running');
    assert.strictEqual(row(rows, 'Lobby chat').tone, 'bad');

    // The Version row: this launcher's version, quiet when up to date, loud when an install
    // is waiting.
    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { update: { state: 'downloading', percent: 42, version: '1.1.0', error: '', currentVersion: '1.0.4' } }));
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Version').value, 'v1.0.0 - downloading 1.1.0 (42%)');
    assert.strictEqual(row(rows, 'Version').tone, 'warn');
    assert.strictEqual(registry.get('update-install').hidden, true, 'no restart button mid-download');

    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { update: { state: 'downloaded', percent: 100, version: '1.1.0', error: '', currentVersion: '1.0.4' } }));
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Version').value, 'v1.0.0 - 1.1.0 ready, restart to install');
    assert.strictEqual(row(rows, 'Version').tone, 'ok');
    assert.strictEqual(registry.get('update-install').hidden, false, 'the restart button appears when the update is complete');

    assert.strictEqual(registry.get('update-actions').hidden, false, 'the restart button shows with no problem banner');
    assert.strictEqual(registry.get('update-download').hidden, true, 'an installable update has no download link');

    // A build that cannot install updates itself (macOS, portable, 32-bit setup): the row says
    // which version is out and a Download button asks main.js to open it, naming no URL.
    render(
        baseState(ARMED_FLASH, IDLE_SOCIAL, {
            update: {
                mode: 'notice',
                state: 'available',
                percent: 0,
                version: '1.6.0',
                asset: 'DungeonBlitzR-Launcher-1.6.0-mac-x64.dmg',
                error: '',
                currentVersion: '1.0.0'
            }
        })
    );
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Version').value, 'v1.0.0 - launcher 1.6.0 is available');
    assert.strictEqual(row(rows, 'Version').tone, 'ok');
    assert.match(row(rows, 'Version').detail, /DungeonBlitzR-Launcher-1\.6\.0-mac-x64\.dmg/);
    assert.strictEqual(registry.get('update-install').hidden, true, 'nothing to restart into');
    assert.strictEqual(registry.get('update-download').hidden, false, 'the download button appears');
    assert.strictEqual(registry.get('update-download').textContent, 'Download 1.6.0');
    assert.strictEqual(registry.get('update-actions').hidden, false);
    const downloads = [];
    registry.launcher.updateDownload = async (...args) => {
        downloads.push(args);
        return true;
    };
    await registry.get('update-download').listeners.click();
    assert.deepStrictEqual(downloads, [[]], 'the renderer passes no URL to updateDownload');

    // The same build, up to date: no button, and the hover says why there is no install.
    render(
        baseState(ARMED_FLASH, IDLE_SOCIAL, {
            update: { mode: 'notice', state: 'not-available', percent: 0, version: '', error: '', currentVersion: '1.0.0' }
        })
    );
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Version').value, 'v1.0.0 - up to date');
    assert.match(row(rows, 'Version').detail, /cannot install it itself/);
    assert.strictEqual(registry.get('update-download').hidden, true);
    assert.strictEqual(registry.get('update-actions').hidden, true);

    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { update: { state: 'disabled', percent: 0, version: '', error: '', currentVersion: '1.0.4' } }));
    rows = rowsFrom(registry);
    assert.strictEqual(row(rows, 'Version').value, 'v1.0.0', 'a development checkout shows just its version');
    assert.strictEqual(registry.get('update-install').hidden, true);
    assert.strictEqual(registry.get('update-download').hidden, true);
    assert.strictEqual(registry.get('update-actions').hidden, true);

    // A remembered account replaces the sign-in button entirely.
    render(
        baseState(ARMED_FLASH, IDLE_SOCIAL, {
            discord: { linked: true, email: 'player@example.test', name: 'neodevils', remembered: true, loginPending: false }
        })
    );
    assert.strictEqual(registry.get('discord-login').hidden, true, 'no sign-in button once the account is known');
    assert.strictEqual(registry.get('account').hidden, false);
    assert.strictEqual(registry.get('account-name').textContent, 'Signed in as neodevils');
    assert.strictEqual(registry.get('status').textContent, 'Ready to play.');

    // Neither a name nor an email is still an account: fall back to the email, then to none.
    render(
        baseState(ARMED_FLASH, IDLE_SOCIAL, {
            discord: { linked: true, email: 'player@example.test', name: '', remembered: true, loginPending: false }
        })
    );
    assert.strictEqual(registry.get('account-name').textContent, 'Signed in as player@example.test');

    render(baseState(ARMED_FLASH, IDLE_SOCIAL));
    assert.strictEqual(registry.get('discord-login').hidden, false, 'a fresh install still offers the button');
    assert.strictEqual(registry.get('account').hidden, true);

    // A copy running from a disk image or from Downloads says so, and offers the move.
    render(
        baseState(ARMED_FLASH, IDLE_SOCIAL, {
            install: {
                relocate: true,
                reason: 'disk-image',
                message: 'The launcher is running from a mounted disk image.',
                sourcePath: '/Volumes/Dungeon Blitz R/Dungeon Blitz R.app',
                targetPath: '/Applications/Dungeon Blitz R.app',
                canMove: true
            }
        })
    );
    assert.strictEqual(registry.get('problem').hidden, false);
    assert.ok(registry.get('problem').textContent.includes('/Applications/Dungeon Blitz R.app'));
    assert.strictEqual(registry.get('move-app').hidden, false);

    // An installed copy shows neither.
    render(baseState(ARMED_FLASH, IDLE_SOCIAL, { install: { relocate: false, reason: '', message: '', sourcePath: '', targetPath: '', canMove: false } }));
    assert.strictEqual(registry.get('problem').hidden, true);
    assert.strictEqual(registry.get('move-app').hidden, true);

    console.log('[test-launcher-status] status rows and the account row render correctly in every state');

    await checkPlayButtons(render, registry, plays);
    await checkCopySignInLink(render, registry, plays);
    await checkLoginCode(render, registry, plays);
    await checkDamageMeterButton(render, registry, plays);
    console.log('[test-launcher-status] all assertions passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
