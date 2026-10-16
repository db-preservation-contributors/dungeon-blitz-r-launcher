'use strict';

/**
 * The game socket through the server's WebSocket when the game port is blocked (lib/gameTunnel.js).
 *
 *   node tools/test-game-tunnel.js
 */

const assert = require('assert');
const net = require('net');
const { POLICY_FILE, askGameSocket, openGameTunnel } = require('../lib/gameTunnel');

function freePort() {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

function answer(status, body) {
    return async () => ({ ok: status === 200, status, json: async () => body });
}

/** Sends `data` and collects what comes back until `expected` bytes or the socket closes. */
function exchange(port, data, expected) {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        const chunks = [];
        const finish = () => {
            socket.destroy();
            resolve(Buffer.concat(chunks));
        };
        socket.on('data', (chunk) => {
            chunks.push(chunk);
            if (expected && Buffer.concat(chunks).length >= expected) {
                finish();
            }
        });
        socket.on('close', finish);
        socket.on('error', reject);
        socket.write(data);
    });
}

/** Stands in for the server's WebSocket game route: echoes every message, reversed. */
class EchoWebSocket {
    constructor(url) {
        EchoWebSocket.opened.push(url);
        this.readyState = 0;
        this.listeners = {};
        setTimeout(() => {
            this.readyState = 1;
            this.emit('open', {});
        }, 5);
    }

    addEventListener(name, listener) {
        (this.listeners[name] = this.listeners[name] || []).push(listener);
    }

    emit(name, event) {
        for (const listener of this.listeners[name] || []) {
            listener(event);
        }
    }

    send(chunk) {
        const reversed = Buffer.from(chunk).reverse();
        setTimeout(() => this.emit('message', { data: reversed.buffer.slice(reversed.byteOffset, reversed.byteOffset + reversed.length) }), 1);
    }

    close() {
        this.readyState = 3;
    }
}
EchoWebSocket.opened = [];

async function checkAsk() {
    const page = 'http://dungeonblitzr.theminesa.studio/';
    const good = { host: 'dungeonblitzr.theminesa.studio', port: 8080, webSocketUrl: 'wss://dungeonblitzr.theminesa.studio/game-ws' };
    assert.deepStrictEqual(await askGameSocket(page, { fetchImpl: answer(200, good) }), good);
    assert.strictEqual(await askGameSocket(page, { fetchImpl: answer(404, {}) }), null, 'an older server has no route');
    assert.strictEqual(await askGameSocket(page, { fetchImpl: answer(200, { ...good, webSocketUrl: null }) }), null, 'no WebSocket, no tunnel');
    assert.strictEqual(await askGameSocket(page, { fetchImpl: answer(200, { ...good, port: 0 }) }), null);
    assert.strictEqual(await askGameSocket(page, { fetchImpl: answer(200, { ...good, webSocketUrl: 'http://x/' }) }), null);
    assert.strictEqual(await askGameSocket(page, { fetchImpl: async () => { throw new Error('offline'); } }), null, 'a server that is down');

    let asked = '';
    await askGameSocket(page, { fetchImpl: async (url) => { asked = url; return { ok: false }; } });
    assert.strictEqual(asked, 'http://dungeonblitzr.theminesa.studio/api/launcher/game-socket');
    console.log('[test-game-tunnel] the server says where the game socket and its WebSocket are: OK');
}

async function checkDirect() {
    const tunnel = await openGameTunnel('http://x/', {
        fetchImpl: answer(200, { host: 'x', port: 8080, webSocketUrl: 'wss://x/game-ws' }),
        WebSocketImpl: EchoWebSocket,
        probe: async () => true
    });
    assert.strictEqual(tunnel, null, 'a game port that answers is played direct');
    console.log('[test-game-tunnel] a reachable game port is played direct: OK');
}

async function checkTunnel() {
    const gamePort = await freePort();
    const pagePort = await freePort();
    const policyPort = await freePort();
    const logs = [];

    // The real server's page port, on another loopback address so the tunnel can listen on the
    // same port number for 127.0.0.1 (Linux routes all of 127/8 to the machine).
    const pipeTarget = process.platform === 'linux' ? '127.0.0.2' : null;
    let pageServer = null;
    if (pipeTarget) {
        pageServer = net.createServer((socket) => socket.on('data', (data) => socket.end(`page:${data}`)));
        await new Promise((resolve) => pageServer.listen(pagePort, pipeTarget, resolve));
    }

    const tunnel = await openGameTunnel('http://dungeonblitzr.theminesa.studio/', {
        fetchImpl: answer(200, { host: pipeTarget || 'dungeonblitzr.theminesa.studio', port: gamePort, webSocketUrl: 'wss://dungeonblitzr.theminesa.studio/game-ws' }),
        WebSocketImpl: EchoWebSocket,
        probe: async () => false,
        pagePorts: [pagePort],
        policyPort,
        log: (message) => logs.push(message)
    });
    try {
        assert.ok(tunnel, 'a blocked game port with a WebSocket on the server is tunnelled');
        assert.strictEqual(tunnel.hostRules, `MAP ${pipeTarget || 'dungeonblitzr.theminesa.studio'} 127.0.0.1`);
        assert.ok(logs.some((line) => line.includes('wss://dungeonblitzr.theminesa.studio/game-ws')), logs.join('\n'));

        const policyRequest = '<policy-file-request/>\0';
        assert.strictEqual((await exchange(policyPort, policyRequest)).toString(), POLICY_FILE, 'the policy port is answered');
        assert.strictEqual((await exchange(gamePort, policyRequest)).toString(), POLICY_FILE, 'and so is the game port');
        assert.strictEqual(EchoWebSocket.opened.length, 0, 'a policy request never opens a WebSocket');

        const reply = await exchange(gamePort, Buffer.from([1, 2, 3, 4]), 4);
        assert.deepStrictEqual([...reply], [4, 3, 2, 1], 'the game bytes go over the WebSocket and come back');
        assert.deepStrictEqual(EchoWebSocket.opened, ['wss://dungeonblitzr.theminesa.studio/game-ws']);

        if (pipeTarget) {
            assert.strictEqual((await exchange(pagePort, 'GET /')).toString(), 'page:GET /', 'the page port is piped to the real server');
        }
    } finally {
        if (tunnel) {
            tunnel.stop();
        }
        if (pageServer) {
            pageServer.close();
        }
    }
    console.log('[test-game-tunnel] a blocked game port goes through the WebSocket, the page loads as before: OK');
}

async function checkPortInUse() {
    const busy = net.createServer();
    await new Promise((resolve) => busy.listen(0, '127.0.0.1', resolve));
    const logs = [];
    try {
        const tunnel = await openGameTunnel('http://x/', {
            fetchImpl: answer(200, { host: 'x', port: busy.address().port, webSocketUrl: 'wss://x/game-ws' }),
            WebSocketImpl: EchoWebSocket,
            probe: async () => false,
            pagePorts: [],
            log: (message) => logs.push(message)
        });
        assert.strictEqual(tunnel, null, 'a port that cannot be opened here means playing direct');
        assert.ok(logs.some((line) => line.includes('playing direct')), logs.join('\n'));
    } finally {
        busy.close();
    }
    console.log('[test-game-tunnel] a port already in use falls back to playing direct: OK');
}

(async () => {
    await checkAsk();
    await checkDirect();
    await checkTunnel();
    await checkPortInUse();
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
