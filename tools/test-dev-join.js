#!/usr/bin/env node
'use strict';

/**
 * Developer mode's Join bridge (lib/devJoin.js): what a shared address leads to, and the bridge on
 * this machine's game ports. It checks that:
 *
 * - only an https trycloudflare.com address is a share address, with or without its /web path;
 * - the WebSocket tunnel comes from the /web page and the SWF from the start page;
 * - in tunnel mode both game sockets go over the WebSocket, byte for byte both ways, and a policy
 *   request is answered on the spot;
 * - in local mode the web and login ports are handed to the developer's own server;
 * - a port already in use is said, and the bridge leaves nothing listening behind.
 *
 * Usage: node tools/test-dev-join.js
 */

const assert = require('assert');
const http = require('http');
const net = require('net');
const { EventEmitter } = require('events');

const { POLICY_FILE, openBridge, parseShareAddress, resolveTunnel, swfPathFromPage } = require('../lib/devJoin');

function freePort() {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

async function freePorts() {
    return { http: await freePort(), login: await freePort(), world: await freePort(), policy: await freePort() };
}

/** Writes `data` to 127.0.0.1:`port` and collects what comes back until `bytes` have arrived. */
function exchange(port, data, bytes) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => socket.write(data));
        let received = Buffer.alloc(0);
        socket.on('data', (chunk) => {
            received = Buffer.concat([received, chunk]);
            if (received.length >= bytes) {
                socket.destroy();
                resolve(received);
            }
        });
        socket.on('error', reject);
        setTimeout(() => {
            socket.destroy();
            reject(new Error(`only ${received.length} of ${bytes} bytes came back`));
        }, 3000);
    });
}

function checkShareAddress() {
    assert.strictEqual(parseShareAddress('https://designation-cleveland-imports-quarters.trycloudflare.com/web'), 'designation-cleveland-imports-quarters.trycloudflare.com');
    assert.strictEqual(parseShareAddress('  https://abc-def.trycloudflare.com  '), 'abc-def.trycloudflare.com');
    for (const bad of ['', 'http://abc.trycloudflare.com/web', 'https://trycloudflare.com.evil.example/web', 'https://evil.example/web', 'not a url', 'wss://abc.trycloudflare.com']) {
        assert.strictEqual(parseShareAddress(bad), '', `${bad || '(empty)'} is not a share address`);
    }
    assert.strictEqual(
        swfPathFromPage('const swf = `/p/cbp/DungeonBlitz.swf?fv=cbp&gv=cbp&clientrev=swf-eae765589aea${languageParam}`;'),
        '/p/cbp/DungeonBlitz.swf?fv=cbp&gv=cbp&clientrev=swf-eae765589aea'
    );
    assert.strictEqual(swfPathFromPage('<html>no game</html>'), '');
    console.log('[test-dev-join] share addresses and the SWF path: OK');
}

async function checkResolve() {
    const asked = [];
    const pages = {
        'https://web-one.trycloudflare.com/web': "socketProxy: [{ proxyUrl: 'wss://sock-two.trycloudflare.com' }]",
        'https://web-one.trycloudflare.com/': '"/p/cbp/DungeonBlitz.swf?fv=cbp&gv=cbp&clientrev=swf-abc"'
    };
    const fetch = async (url) => {
        asked.push(url);
        return pages[url] || '';
    };
    const tunnel = await resolveTunnel('https://web-one.trycloudflare.com/web', { fetch });
    assert.deepStrictEqual(tunnel, { webHost: 'web-one.trycloudflare.com', wsHost: 'sock-two.trycloudflare.com', swfPath: '/p/cbp/DungeonBlitz.swf?fv=cbp&gv=cbp&clientrev=swf-abc' });
    assert.deepStrictEqual(asked, Object.keys(pages));

    await assert.rejects(resolveTunnel('https://evil.example/web', { fetch }), /trycloudflare/);
    await assert.rejects(resolveTunnel('https://web-one.trycloudflare.com/web', { fetch: async () => '' }), /names no game socket/);
    console.log('[test-dev-join] a shared address resolves to its two tunnels and SWF: OK');
}

/** A stand-in WebSocket: every message sent to it comes back reversed, as the server's answer. */
class EchoSocket extends EventEmitter {
    constructor(url) {
        super();
        EchoSocket.opened.push(url);
        this.readyState = 0;
        this.binaryType = '';
        setImmediate(() => {
            this.readyState = 1;
            this.emit('open');
        });
    }

    addEventListener(type, listener) {
        this.on(type, listener);
    }

    send(chunk) {
        const reply = Buffer.from(chunk).reverse();
        setImmediate(() => this.emit('message', { data: reply.buffer.slice(reply.byteOffset, reply.byteOffset + reply.length) }));
    }

    close() {
        this.readyState = 3;
        this.emit('close');
    }
}
EchoSocket.opened = [];

async function checkTunnelMode() {
    const ports = await freePorts();
    const bridge = await openBridge({ mode: 'tunnel', webHost: 'web-one.trycloudflare.com', wsHost: 'sock-two.trycloudflare.com' }, { ports, WebSocketImpl: EchoSocket });
    assert.strictEqual(bridge.pageUrl, `http://localhost:${ports.http}/`);
    try {
        const policy = await exchange(ports.login, '<policy-file-request/>\0', POLICY_FILE.length);
        assert.strictEqual(policy.toString(), POLICY_FILE, 'a policy request on the game port is answered here');
        assert.deepStrictEqual(EchoSocket.opened, [], 'and opens no tunnel');

        for (const port of [ports.login, ports.world]) {
            const sent = Buffer.from([0x00, 0x11, 0x00, 0x02, 0xc8, 0x01]);
            const back = await exchange(port, sent, sent.length);
            assert.deepStrictEqual([...back], [...Buffer.from(sent).reverse()], `port ${port}: the bytes go over the WebSocket and back`);
        }
        assert.deepStrictEqual(EchoSocket.opened, ['wss://sock-two.trycloudflare.com/', 'wss://sock-two.trycloudflare.com/'], 'login and world each take the WebSocket tunnel');

        const policyPort = await exchange(ports.policy, '<policy-file-request/>\0', POLICY_FILE.length);
        assert.strictEqual(policyPort.toString(), POLICY_FILE, 'the policy port answers too');

        await assert.rejects(
            openBridge({ mode: 'tunnel', webHost: 'a.trycloudflare.com', wsHost: 'b.trycloudflare.com' }, { ports, WebSocketImpl: EchoSocket }),
            /is in use on this computer/,
            'a second bridge on the same ports says why it cannot open'
        );
    } finally {
        bridge.close();
    }
    await assert.rejects(
        openBridge({ mode: 'tunnel', webHost: 'a.trycloudflare.com', wsHost: 'b.trycloudflare.com' }, { ports: await freePorts(), WebSocketImpl: null }),
        /cannot open a WebSocket/
    );
    console.log('[test-dev-join] tunnel mode: both game sockets over the WebSocket, policy answered here: OK');
}

async function checkLocalMode() {
    const ports = await freePorts();
    const localPorts = { http: await freePort(), game: await freePort() };
    const page = http.createServer((_request, response) => response.end('local page'));
    const game = net.createServer((socket) => socket.on('data', (chunk) => socket.write(Buffer.concat([Buffer.from('ok:'), chunk]))));
    await new Promise((resolve) => page.listen(localPorts.http, '127.0.0.1', resolve));
    await new Promise((resolve) => game.listen(localPorts.game, '127.0.0.1', resolve));
    const bridge = await openBridge({ mode: 'local' }, { ports, localPorts });
    try {
        const body = await new Promise((resolve, reject) => {
            http.get(`http://127.0.0.1:${ports.http}/`, (response) => {
                let text = '';
                response.on('data', (chunk) => {
                    text += chunk;
                });
                response.on('end', () => resolve(text));
            }).on('error', reject);
        });
        assert.strictEqual(body, 'local page', 'the web port is the developer\'s own server');
        const back = await exchange(ports.login, 'hi', 5);
        assert.strictEqual(back.toString(), 'ok:hi', 'and so is the login port');
    } finally {
        bridge.close();
        page.close();
        game.close();
    }
    // Closed means closed: the ports are free again.
    const again = await openBridge({ mode: 'local' }, { ports, localPorts });
    again.close();
    console.log('[test-dev-join] local mode: the developer\'s own server, and close() frees the ports: OK');
}

async function main() {
    checkShareAddress();
    await checkResolve();
    await checkTunnelMode();
    await checkLocalMode();
    console.log('[test-dev-join] all assertions passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
