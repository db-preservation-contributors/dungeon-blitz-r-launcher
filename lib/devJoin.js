'use strict';

/**
 * Developer mode: playing a test server through its Cloudflare quick tunnels, or one running on
 * this machine (lib/devServer.js), in the AIR engine.
 *
 * A test server runs in local mode, so the SWF it serves loads its files from
 * http://localhost:8000 and opens raw TCP sockets to localhost:8080 (login) and localhost:8180
 * (the world, named by the enter-world packet). This listens on those ports on 127.0.0.1 and
 * carries them to the server:
 *
 *   tunnel   8000 -> the web tunnel over HTTPS; 8080 and 8180 -> the WebSocket tunnel, one
 *            message per write (the server's WebSocket carries the same byte stream as its game
 *            port). Both game sockets take the same road: the server lets a world entry be
 *            redeemed only from the address that logged in.
 *   local    8000 -> 127.0.0.1:8100, 8080 -> 127.0.0.1:8180: the developer's own server, the way
 *            its air-ports.js did it. The world socket goes to 8180 itself.
 *   843      Flash's socket policy, answered here (skipped where the system refuses the port).
 */

const http = require('http');
const https = require('https');
const net = require('net');

const POLICY_FILE =
    '<?xml version="1.0"?><cross-domain-policy><allow-access-from domain="*" to-ports="*"/></cross-domain-policy>\0';

const DEFAULT_PORTS = { http: 8000, login: 8080, world: 8180, policy: 843 };
/** Where the developer's own test server listens (lib/devServer.js). */
const LOCAL_SERVER_PORTS = { http: 8100, game: 8180 };

const TUNNEL_HOST = /^[a-z0-9-]+\.trycloudflare\.com$/;

/**
 * The web tunnel's host in an address someone shared, or '' when it is not one: an https
 * trycloudflare.com address, with or without its /web path.
 */
function parseShareAddress(address) {
    let url;
    try {
        url = new URL(String(address || '').trim());
    } catch {
        return '';
    }
    return url.protocol === 'https:' && TUNNEL_HOST.test(url.hostname) ? url.hostname : '';
}

function fetchText(url, { timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, (response) => {
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`${url} answered ${response.statusCode}`));
                return;
            }
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                body += chunk;
            });
            response.on('end', () => resolve(body));
        });
        request.setTimeout(timeoutMs, () => request.destroy(new Error(`${url} did not answer`)));
        request.on('error', reject);
    });
}

/** The game SWF a test server's start page names, as a path. */
function swfPathFromPage(html) {
    const match = /(\/p\/cbp\/DungeonBlitz\.swf\?[^"'`$\s]*)/.exec(String(html || ''));
    return match ? match[1] : '';
}

/**
 * What a shared address leads to: the web tunnel, the WebSocket tunnel its /web page names, and
 * the SWF its start page names.
 *
 * @returns {Promise<{ webHost: string, wsHost: string, swfPath: string }>}
 */
async function resolveTunnel(address, { fetch = fetchText } = {}) {
    const webHost = parseShareAddress(address);
    if (!webHost) {
        throw new Error('That is not a https://....trycloudflare.com address.');
    }
    const ws = /wss:\/\/([a-z0-9-]+\.trycloudflare\.com)/.exec(await fetch(`https://${webHost}/web`));
    if (!ws) {
        throw new Error('That server names no game socket. Is it running?');
    }
    const swfPath = swfPathFromPage(await fetch(`https://${webHost}/`));
    if (!swfPath) {
        throw new Error('That server names no game SWF.');
    }
    return { webHost, wsHost: ws[1], swfPath };
}

function listen(server, port, name, required) {
    return new Promise((resolve, reject) => {
        server.once('error', (error) => {
            if (required) {
                reject(new Error(`Port ${port} (${name}) is in use on this computer: ${error.message}`));
            } else {
                resolve(null);
            }
        });
        server.listen(port, '127.0.0.1', () => resolve(server));
    });
}

function policyServer() {
    return net.createServer((socket) => {
        socket.on('error', () => socket.destroy());
        socket.once('data', () => socket.end(POLICY_FILE));
        socket.setTimeout(5000, () => socket.end(POLICY_FILE));
    });
}

/** One TCP game socket carried over the WebSocket tunnel. */
function tunnelGameServer(wsHost, WebSocketImpl, log) {
    return net.createServer((socket) => {
        socket.setNoDelay(true);
        socket.on('error', () => socket.destroy());
        socket.once('data', (first) => {
            if (first.toString('latin1').startsWith('<policy-file-request/>')) {
                socket.end(POLICY_FILE);
                return;
            }
            socket.pause();
            const queued = [first];
            const ws = new WebSocketImpl(`wss://${wsHost}/`);
            ws.binaryType = 'arraybuffer';
            ws.addEventListener('open', () => {
                for (const chunk of queued.splice(0)) {
                    ws.send(chunk);
                }
                socket.resume();
            });
            socket.on('data', (chunk) => {
                if (ws.readyState === 1) {
                    ws.send(chunk);
                } else {
                    queued.push(chunk);
                }
            });
            ws.addEventListener('message', (event) => {
                if (!socket.destroyed) {
                    socket.write(Buffer.from(event.data));
                }
            });
            const closeBoth = () => {
                if (!socket.destroyed) {
                    socket.destroy();
                }
                if (ws.readyState === 0 || ws.readyState === 1) {
                    try {
                        ws.close();
                    } catch {
                        // Already closing.
                    }
                }
            };
            ws.addEventListener('close', closeBoth);
            ws.addEventListener('error', () => {
                log('[DevJoin] the game socket tunnel failed');
                closeBoth();
            });
            socket.on('close', closeBoth);
        });
    });
}

/** Every request re-addressed to the web tunnel. */
function tunnelHttpServer(webHost, log) {
    return http.createServer((request, response) => {
        const headers = { ...request.headers, host: webHost };
        delete headers.connection;
        delete headers['proxy-connection'];
        delete headers['keep-alive'];
        const upstream = https.request({ host: webHost, port: 443, method: request.method, path: request.url, headers }, (reply) => {
            response.writeHead(reply.statusCode || 502, reply.headers);
            reply.pipe(response);
        });
        upstream.on('error', (error) => {
            log(`[DevJoin] ${request.url}: ${error.message}`);
            if (!response.headersSent) {
                response.writeHead(502);
            }
            response.end();
        });
        request.pipe(upstream);
    });
}

/** A TCP port on this machine handed straight to another one. */
function forwardServer(targetPort) {
    return net.createServer((socket) => {
        socket.setNoDelay(true);
        const upstream = net.connect(targetPort, '127.0.0.1');
        upstream.setNoDelay(true);
        socket.pipe(upstream);
        upstream.pipe(socket);
        const close = () => {
            socket.destroy();
            upstream.destroy();
        };
        socket.on('error', close);
        upstream.on('error', close);
        socket.on('close', close);
        upstream.on('close', close);
    });
}

/**
 * Opens the bridge. `target` is `{ mode: 'tunnel', webHost, wsHost }` or `{ mode: 'local' }`.
 *
 * @returns {Promise<{ pageUrl: string, close: () => void }>} `pageUrl` is the start page through
 *   the bridge, the address the game is played from.
 */
async function openBridge(
    target,
    { ports = DEFAULT_PORTS, localPorts = LOCAL_SERVER_PORTS, WebSocketImpl = globalThis.WebSocket, log = () => {} } = {}
) {
    const servers = [];
    const close = () => {
        for (const server of servers.splice(0)) {
            try {
                server.close();
            } catch {
                // Not listening.
            }
        }
    };
    try {
        if (target.mode === 'local') {
            servers.push(await listen(forwardServer(localPorts.http), ports.http, 'web', true));
            servers.push(await listen(forwardServer(localPorts.game), ports.login, 'login', true));
        } else {
            if (typeof WebSocketImpl !== 'function') {
                throw new Error('This launcher build cannot open a WebSocket; join from a current Windows x64 or macOS build.');
            }
            servers.push(await listen(tunnelHttpServer(target.webHost, log), ports.http, 'web', true));
            servers.push(await listen(tunnelGameServer(target.wsHost, WebSocketImpl, log), ports.login, 'login', true));
            servers.push(await listen(tunnelGameServer(target.wsHost, WebSocketImpl, log), ports.world, 'world', true));
        }
        const policy = await listen(policyServer(), ports.policy, 'policy', false);
        if (policy) {
            servers.push(policy);
        }
    } catch (error) {
        close();
        throw error;
    }
    return { pageUrl: `http://localhost:${ports.http}/`, close };
}

module.exports = {
    DEFAULT_PORTS,
    LOCAL_SERVER_PORTS,
    POLICY_FILE,
    openBridge,
    parseShareAddress,
    resolveTunnel,
    swfPathFromPage
};
