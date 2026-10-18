'use strict';

/**
 * Plays through a blocked game port: the game socket over the server's WebSocket.
 *
 * The SWF opens a raw TCP socket to the game host's game port (8080). Some networks only let
 * web traffic out, so that socket never connects while the game page still loads. The server
 * also carries the same byte stream over a WebSocket behind its TLS proxy (wss://<host>/game-ws,
 * the web client's socket), and it says where on GET /api/launcher/game-socket.
 *
 * When the game port does not answer, the launcher listens on 127.0.0.1 itself and FlashBrowser
 * resolves the game host to 127.0.0.1 (--db-host-rules), so every connection the window makes to
 * that host arrives here:
 *   game port   bytes over the WebSocket, one message per write, as the web client sends them
 *   80, 443     piped to the real server unchanged: the page and the SWF's files load as before
 *   843         Flash's socket policy, answered here
 * Without a WebSocket on the server, or when a port cannot be opened, the game plays direct.
 */

const net = require('net');

const POLICY_REQUEST = '<policy-file-request/>';
const POLICY_FILE =
    '<?xml version="1.0"?><cross-domain-policy><allow-access-from domain="*" to-ports="*"/></cross-domain-policy>\0';
const POLICY_PORT = 843;
const PROBE_TIMEOUT_MS = 4000;
const ASK_TIMEOUT_MS = 5000;

function isLoopback(address) {
    const plain = String(address || '').replace(/^::ffff:/i, '');
    return plain === '::1' || /^127\./.test(plain);
}

/**
 * The server's answer to /api/launcher/game-socket, or null: an older server (404), one that is
 * down, or one without a WebSocket game server has nothing to tunnel through.
 *
 * @returns {Promise<{ host: string, port: number, webSocketUrl: string } | null>}
 */
async function askGameSocket(pageUrl, { fetchImpl = fetch, timeoutMs = ASK_TIMEOUT_MS } = {}) {
    try {
        const response = await fetchImpl(new URL('/api/launcher/game-socket', pageUrl).toString(), {
            signal: AbortSignal.timeout(timeoutMs)
        });
        if (!response.ok) {
            return null;
        }
        const body = await response.json();
        const port = Number(body && body.port);
        if (!body || typeof body.host !== 'string' || !body.host || !Number.isInteger(port) || port <= 0) {
            return null;
        }
        if (typeof body.webSocketUrl !== 'string' || !/^wss?:\/\//i.test(body.webSocketUrl)) {
            return null;
        }
        return { host: body.host, port, webSocketUrl: body.webSocketUrl };
    } catch {
        return null;
    }
}

/** Whether a TCP connection to host:port opens within the timeout. */
function canReach(host, port, timeoutMs = PROBE_TIMEOUT_MS) {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port });
        const done = (ok) => {
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(timeoutMs, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}

/**
 * Listens on 127.0.0.1:port. macOS refuses ports below 1024 there without admin rights but
 * allows them on every address, so those fall back to 0.0.0.0 -- and connections that do not
 * come from this machine are closed, so the tunnel is never anyone else's.
 */
function listen(port, onConnection) {
    const server = net.createServer({ pauseOnConnect: true }, (socket) => {
        if (!isLoopback(socket.remoteAddress)) {
            socket.destroy();
            return;
        }
        socket.on('error', () => socket.destroy());
        onConnection(socket);
    });
    return new Promise((resolve, reject) => {
        server.once('error', (error) => {
            if (error.code !== 'EACCES' || process.platform !== 'darwin') {
                reject(error);
                return;
            }
            server.once('error', reject);
            server.listen(port, '0.0.0.0', () => resolve(server));
        });
        server.listen(port, '127.0.0.1', () => resolve(server));
    });
}

/** A connection to the real server's port, unchanged (the page, its files, https calls). */
function pipeTo(host, port) {
    return (client) => {
        const upstream = net.connect({ host, port });
        const close = () => {
            client.destroy();
            upstream.destroy();
        };
        upstream.once('connect', () => {
            client.pipe(upstream);
            upstream.pipe(client);
            client.resume();
        });
        upstream.on('error', close);
        upstream.on('close', close);
        client.on('close', close);
    };
}

/**
 * The game socket over the WebSocket. Flash asks the game port itself for the socket policy
 * when nothing answers on 843; that request is answered here and never reaches the server.
 */
function bridgeToWebSocket(webSocketUrl, WebSocketImpl) {
    return (client) => {
        let ws = null;
        const queued = [];
        const close = () => {
            client.destroy();
            if (ws && ws.readyState <= 1) {
                ws.close();
            }
        };

        client.once('data', (first) => {
            if (first.toString('latin1').startsWith(POLICY_REQUEST)) {
                client.end(POLICY_FILE);
                return;
            }
            queued.push(first);
            ws = new WebSocketImpl(webSocketUrl);
            ws.binaryType = 'arraybuffer';
            ws.addEventListener('open', () => {
                for (const chunk of queued.splice(0)) {
                    ws.send(chunk);
                }
            });
            ws.addEventListener('message', (event) => client.write(Buffer.from(event.data)));
            ws.addEventListener('close', close);
            ws.addEventListener('error', close);
            client.on('data', (chunk) => {
                if (ws.readyState === 1) {
                    ws.send(chunk);
                } else {
                    queued.push(chunk);
                }
            });
        });
        client.on('close', close);
        client.resume();
    };
}

function answerPolicy(socket) {
    socket.once('data', (data) => {
        if (data.toString('latin1').startsWith(POLICY_REQUEST)) {
            socket.end(POLICY_FILE);
        } else {
            socket.destroy();
        }
    });
    socket.resume();
}

/**
 * Opens the tunnel when the game socket needs one.
 *
 * @returns {Promise<{ hostRules: string, stop: () => void } | null>} null to play direct.
 */
async function openGameTunnel(pageUrl, {
    fetchImpl = fetch,
    WebSocketImpl = globalThis.WebSocket,
    probe = canReach,
    pagePorts = [80, 443],
    policyPort = POLICY_PORT,
    log = () => {}
} = {}) {
    const socket = await askGameSocket(pageUrl, { fetchImpl });
    if (!socket || typeof WebSocketImpl !== 'function') {
        return null;
    }
    if (await probe(socket.host, socket.port)) {
        return null;
    }

    const servers = [];
    const stop = () => {
        for (const server of servers.splice(0)) {
            server.close();
        }
    };
    try {
        servers.push(await listen(socket.port, bridgeToWebSocket(socket.webSocketUrl, WebSocketImpl)));
        // The game host's page and files have to keep loading once the window resolves that
        // host to 127.0.0.1, so a page port that cannot be opened here means no tunnel.
        for (const port of pagePorts.filter((entry) => entry !== socket.port)) {
            servers.push(await listen(port, pipeTo(socket.host, port)));
        }
    } catch (error) {
        stop();
        log(`not possible here (${(error && error.message) || error}); playing direct`);
        return null;
    }
    try {
        servers.push(await listen(policyPort, answerPolicy));
    } catch {
        // Flash asks the game port itself when 843 does not answer, and that is answered too.
    }

    log(`${socket.host}:${socket.port} does not answer; the game socket goes through ${socket.webSocketUrl}`);
    return { hostRules: `MAP ${socket.host} 127.0.0.1`, stop };
}

module.exports = { POLICY_FILE, askGameSocket, canReach, openGameTunnel };
