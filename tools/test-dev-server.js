#!/usr/bin/env node
'use strict';

/**
 * Developer mode's Create (lib/devServer.js, lib/cloudflared.js), without starting a real server
 * or tunnel. It checks that:
 *
 * - a checkout is its root or its src/server folder, needs its dependencies installed, and is
 *   started through its own start-test-server.js where it has one;
 * - the server runs as a local-mode test server on 8100 / 8180 / 8181 that talks to nothing
 *   outside: no database, Discord, widget or health ping, and the WebSocket's public address set;
 * - Node is found, and one too old or missing is said;
 * - every cloudflared asset is pinned to a sha256, and an unknown platform is refused;
 * - a quick tunnel is ready only with its address AND a registered connection, and one that
 *   stops first is an error;
 * - Create on a folder that is no checkout ends in an error that says so, and Stop is idle again.
 *
 * Usage: node tools/test-dev-server.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { DevServer, PORTS, findNode, inspectServerRoot, testServerEnv } = require('../lib/devServer');
const { ASSETS, CLOUDFLARED_VERSION, assetFor, ensureCloudflared, startQuickTunnel } = require('../lib/cloudflared');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'db-dev-server-'));

function write(file, body = '') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
}

function checkServerRoot() {
    assert.match(inspectServerRoot('').problem, /Choose the game server folder/);
    assert.match(inspectServerRoot(path.join(scratch, 'nothing')).problem, /not a game server checkout/);

    const repo = path.join(scratch, 'private-dungeon-blitz-r');
    write(path.join(repo, 'src', 'server', 'main.ts'));
    assert.match(inspectServerRoot(repo).problem, /npm install/, 'dependencies have to be installed');
    write(path.join(repo, 'src', 'server', 'node_modules', 'ts-node', 'package.json'), '{}');
    assert.deepStrictEqual(inspectServerRoot(repo), { ok: true, serverDir: path.join(repo, 'src', 'server'), entry: 'main.ts' });
    assert.deepStrictEqual(inspectServerRoot(path.join(repo, 'src', 'server')), inspectServerRoot(repo), 'its src/server folder is the same checkout');

    write(path.join(repo, 'src', 'server', 'start-test-server.js'));
    assert.strictEqual(inspectServerRoot(repo).entry, 'start-test-server.js', 'a test server copy starts through its own script');
    console.log('[test-dev-server] the checkout and how it is started: OK');
}

function checkEnv() {
    const env = testServerEnv('wss://sock.trycloudflare.com');
    assert.deepStrictEqual(PORTS, { web: 8100, game: 8180, webSocket: 8181 });
    assert.strictEqual(env.STATIC_PORT, '8100');
    assert.strictEqual(env.GAME_PORT, '8180');
    assert.strictEqual(env.WEBSOCKET_GAME_PORT, '8181');
    assert.strictEqual(env.MULTIPLAYER_MODE, 'false', 'a local-mode server: the SWF loads from localhost:8000');
    assert.strictEqual(env.WEBSOCKET_PUBLIC_URL, 'wss://sock.trycloudflare.com', 'the web page names the public socket');
    assert.strictEqual(env.ENABLE_MONGO_GAME_DATA, 'false');
    for (const key of ['MONGODB_URI', 'GAME_MONGODB_URI', 'DISCORD_BOT_TOKEN', 'HEALTH_PING_URL', 'DISCORD_LOG_URL', 'PUBLIC_BASE_URL']) {
        assert.strictEqual(env[key], '', `${key} is blanked: the test server talks to nothing outside`);
    }
    assert.strictEqual(env.WIDGET_PUBLISH_ENABLED, 'false');
    console.log('[test-dev-server] a local-mode test server that talks to nothing outside: OK');
}

function checkNode() {
    assert.deepStrictEqual(findNode({ execFile: () => 'v22.12.0\n' }), { ok: true, command: 'node', version: 'v22.12.0' });
    assert.match(findNode({ execFile: () => 'v16.20.0' }).problem, /too old/);
    assert.match(
        findNode({
            execFile: () => {
                throw new Error('ENOENT');
            }
        }).problem,
        /Node\.js is not installed/
    );
    console.log('[test-dev-server] Node is found, and a missing or old one is said: OK');
}

async function checkCloudflared() {
    assert.match(CLOUDFLARED_VERSION, /^\d{4}\.\d+\.\d+$/);
    for (const [key, asset] of Object.entries(ASSETS)) {
        assert.match(asset.sha256, /^[0-9a-f]{64}$/, `${key} is pinned to a sha256`);
        assert.ok(asset.name.startsWith('cloudflared-'), `${key} names a cloudflared asset`);
    }
    assert.strictEqual(assetFor('win32', 'x64').name, 'cloudflared-windows-amd64.exe');
    assert.strictEqual(assetFor('darwin', 'arm64').archive, true, 'macOS comes as a .tgz');
    assert.strictEqual(assetFor('win32', 'ia32'), null);
    await assert.rejects(ensureCloudflared(scratch, { platform: 'win32', arch: 'ia32' }), /publishes no cloudflared/);

    // Already downloaded and checked: nothing is fetched again.
    const home = path.join(scratch, 'tools', `cloudflared-${CLOUDFLARED_VERSION}`);
    write(path.join(home, 'cloudflared.exe'), 'x');
    write(path.join(home, 'verified.json'), '{}');
    assert.strictEqual(await ensureCloudflared(path.join(scratch, 'tools'), { platform: 'win32', arch: 'x64' }), path.join(home, 'cloudflared.exe'));
    console.log('[test-dev-server] cloudflared is pinned and checked: OK');
}

/** A cloudflared that prints `lines` and then stays up (or exits, with `exitCode`). */
function fakeCloudflared(lines, exitCode = null) {
    const spawned = [];
    const spawnImpl = (command, args) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => child.emit('exit', null);
        spawned.push({ command, args });
        setImmediate(() => {
            for (const line of lines) {
                child.stderr.emit('data', Buffer.from(`${line}\n`));
            }
            if (exitCode !== null) {
                child.emit('exit', exitCode);
            }
        });
        return child;
    };
    return { spawnImpl, spawned };
}

async function checkQuickTunnel() {
    const ready = fakeCloudflared([
        'INF Requesting new quick Tunnel on trycloudflare.com...',
        'INF |  https://tractor-blues-cemetery-easy.trycloudflare.com  |',
        'INF Registered tunnel connection connIndex=0'
    ]);
    const tunnel = await startQuickTunnel('/bin/cloudflared', 8100, { spawnImpl: ready.spawnImpl });
    assert.strictEqual(tunnel.url, 'https://tractor-blues-cemetery-easy.trycloudflare.com');
    assert.deepStrictEqual(ready.spawned[0].args, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', 'http://localhost:8100']);

    const noConnection = fakeCloudflared(['INF |  https://abc.trycloudflare.com  |']);
    await assert.rejects(
        startQuickTunnel('/bin/cloudflared', 8181, { spawnImpl: noConnection.spawnImpl, timeoutMs: 200 }),
        /not connected after/,
        'an address with no registered connection is not ready'
    );
    const died = fakeCloudflared(['ERR failed to connect'], 1);
    await assert.rejects(startQuickTunnel('/bin/cloudflared', 8181, { spawnImpl: died.spawnImpl }), /stopped \(1\)/);
    console.log('[test-dev-server] a quick tunnel is ready with its address and a connection: OK');
}

async function checkCreateRefused() {
    const server = new DevServer({ toolsDir: path.join(scratch, 'tools'), logPath: path.join(scratch, 'dev-server.log') });
    const states = [];
    server.on('state', (summary) => states.push(summary.state));
    const summary = await server.start(path.join(scratch, 'nothing'));
    assert.strictEqual(summary.state, 'error');
    assert.match(summary.error, /not a game server checkout/);
    assert.deepStrictEqual(states, ['starting', 'error']);
    assert.strictEqual(server.stop().state, 'idle');
    console.log('[test-dev-server] Create on a folder that is no checkout says so, and Stop is idle again: OK');
}

async function main() {
    try {
        checkServerRoot();
        checkEnv();
        checkNode();
        await checkCloudflared();
        await checkQuickTunnel();
        await checkCreateRefused();
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
    console.log('[test-dev-server] all assertions passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
