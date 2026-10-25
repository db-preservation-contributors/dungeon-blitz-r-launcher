'use strict';

/**
 * Developer mode's Create: runs a game server checkout on this machine as a test server and opens
 * it to other players through two Cloudflare quick tunnels (lib/cloudflared.js), the way the
 * guild raid test server's start-all.js did by hand.
 *
 *   127.0.0.1:8100   the web page and files       <- https://<web>.trycloudflare.com
 *   127.0.0.1:8181   the game socket as WebSocket <- wss://<socket>.trycloudflare.com
 *   127.0.0.1:8180   the TCP game port, for this machine's own AIR (lib/devJoin.js local mode)
 *
 * The ports are the test server's, so a normal `npm run dev` (8000 / 8080) can run beside it.
 * The checkout is the game server repository's root (or its src/server folder) with its
 * dependencies installed; it runs in the system's Node, read-only towards the live server:
 * no database, Discord or health ping (the same switches start-test-server.js sets). A checkout
 * that has its own src/server/start-test-server.js is started through that instead.
 */

const EventEmitter = require('events');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const { ensureCloudflared, startQuickTunnel } = require('./cloudflared');

const PORTS = { web: 8100, game: 8180, webSocket: 8181 };
const READY_TIMEOUT_MS = 180000;
const LOG_TAIL_LINES = 40;

/** What start-test-server.js sets: a local-mode server that talks to nothing outside. */
function testServerEnv(webSocketPublicUrl) {
    return {
        MULTIPLAYER_MODE: 'false',
        STATIC_PORT: String(PORTS.web),
        GAME_PORT: String(PORTS.game),
        WEBSOCKET_GAME_PORT: String(PORTS.webSocket),
        ENABLE_POLICY_SERVER: 'false',
        ENABLE_MONGO_GAME_DATA: 'false',
        GAME_MONGODB_URI: '',
        MONGODB_URI: '',
        SPONSOR_MONGODB_URI: '',
        SPONSOR_ACCOUNT_CREATION_REQUIRED: 'false',
        HEALTH_PING_URL: '',
        HEALTH_PING_SECRET: '',
        DISCORD_LOG_URL: '',
        DISCORD_LOG_SECRET: '',
        DISCORD_BOT_TOKEN: '',
        PLAYER_REPORTS_DISCORD_BOT_TOKEN: '',
        DISCORD_SOCIAL_BRIDGE_ENABLED: 'false',
        DISCORD_SOCIAL_CHAT_WEBHOOK_URL: '',
        WIDGET_PUBLISH_ENABLED: 'false',
        PUBLIC_BASE_URL: '',
        BASE_URL: '',
        PASSWORD_RESET_URL: '',
        GAME_REGIONS: '',
        REGION_ROUTING_ENABLED: 'false',
        SERVER_LOGS: 'on',
        WEBSOCKET_PUBLIC_URL: webSocketPublicUrl
    };
}

/**
 * The server folder of a checkout, and how to start it.
 *
 * @returns {{ ok: true, serverDir: string, entry: string } | { ok: false, problem: string }}
 */
function inspectServerRoot(root) {
    const picked = String(root || '').trim();
    if (!picked) {
        return { ok: false, problem: 'Choose the game server folder first.' };
    }
    const candidates = [path.join(picked, 'src', 'server'), picked];
    const serverDir = candidates.find((dir) => fs.existsSync(path.join(dir, 'main.ts')));
    if (!serverDir) {
        return { ok: false, problem: `${picked} is not a game server checkout (no src/server/main.ts).` };
    }
    if (!fs.existsSync(path.join(serverDir, 'node_modules', 'ts-node'))) {
        return { ok: false, problem: `Its dependencies are not installed: run \`npm install\` in ${serverDir}.` };
    }
    const entry = fs.existsSync(path.join(serverDir, 'start-test-server.js')) ? 'start-test-server.js' : 'main.ts';
    return { ok: true, serverDir, entry };
}

/** The system's Node, 18 or later, or a problem to show. */
function findNode({ execFile = execFileSync } = {}) {
    try {
        const version = String(execFile('node', ['--version'], { encoding: 'utf8', windowsHide: true })).trim();
        const major = Number((/^v(\d+)/.exec(version) || [])[1] || 0);
        if (major < 18) {
            return { ok: false, problem: `Node ${version} is too old for the game server; install Node 18 or later.` };
        }
        return { ok: true, command: 'node', version };
    } catch {
        return { ok: false, problem: 'Node.js is not installed (or not on PATH). The game server runs in it.' };
    }
}

function portOpen(port) {
    return new Promise((resolve) => {
        const socket = net.connect(port, '127.0.0.1');
        const done = (open) => {
            socket.destroy();
            resolve(open);
        };
        socket.setTimeout(1000, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}

/** Stops a child and everything it started (Windows keeps grandchildren alive otherwise). */
function killTree(child) {
    if (!child || child.exitCode !== null || child.killed) {
        return;
    }
    if (process.platform === 'win32' && child.pid) {
        try {
            execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
            return;
        } catch {
            // Fall through to a plain kill.
        }
    }
    try {
        child.kill();
    } catch {
        // Already gone.
    }
}

/**
 * One test server at a time: idle -> starting -> running, or error; stop() from any of them.
 * Emits 'state' on every change.
 */
class DevServer extends EventEmitter {
    constructor({ toolsDir, logPath, log = () => {} }) {
        super();
        this.toolsDir = toolsDir;
        this.logPath = logPath;
        this.log = log;
        this.children = [];
        this.status = { state: 'idle', step: '', shareUrl: '', webSocketUrl: '', root: '', error: '' };
        this.logTail = [];
        this.runId = 0;
    }

    summary() {
        return { ...this.status, logTail: this.logTail.slice(-8) };
    }

    set(patch) {
        this.status = { ...this.status, ...patch };
        this.emit('state', this.summary());
    }

    running() {
        return this.status.state === 'running' || this.status.state === 'starting';
    }

    noteOutput(chunk) {
        const text = String(chunk);
        try {
            fs.appendFileSync(this.logPath, text);
        } catch {
            // The tail below still shows it.
        }
        for (const line of text.split(/\r?\n/)) {
            if (line.trim()) {
                this.logTail.push(line.slice(0, 300));
            }
        }
        this.logTail = this.logTail.slice(-LOG_TAIL_LINES);
    }

    async start(root) {
        if (this.running()) {
            return this.summary();
        }
        const run = ++this.runId;
        const stale = () => run !== this.runId;
        this.logTail = [];
        this.set({ state: 'starting', step: 'Checking the server folder...', shareUrl: '', webSocketUrl: '', root, error: '' });
        try {
            const checkout = inspectServerRoot(root);
            if (!checkout.ok) {
                throw new Error(checkout.problem);
            }
            const node = findNode();
            if (!node.ok) {
                throw new Error(node.problem);
            }
            for (const port of [PORTS.web, PORTS.game, PORTS.webSocket]) {
                if (await portOpen(port)) {
                    throw new Error(`Port ${port} is already in use: is another test server running?`);
                }
            }

            this.set({ step: 'Getting cloudflared...' });
            const cloudflared = await ensureCloudflared(this.toolsDir, { log: this.log });
            if (stale()) return this.summary();

            this.set({ step: 'Opening the two tunnels...' });
            const tunnelLog = (line) => this.noteOutput(`${line}\n`);
            const [web, socket] = await Promise.all([
                startQuickTunnel(cloudflared, PORTS.web, { log: tunnelLog }),
                startQuickTunnel(cloudflared, PORTS.webSocket, { log: tunnelLog })
            ]);
            this.children.push(web.child, socket.child);
            if (stale()) {
                this.stopChildren();
                return this.summary();
            }
            for (const tunnel of [web, socket]) {
                tunnel.child.once('exit', () => {
                    if (!stale() && this.running()) {
                        this.fail(new Error('A tunnel stopped; Create again for new addresses.'));
                    }
                });
            }
            const webSocketUrl = socket.url.replace(/^https:/, 'wss:');

            this.set({ step: `Starting the server (${checkout.entry})...` });
            fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
            fs.writeFileSync(this.logPath, `[launcher] ${new Date().toISOString()} ${checkout.serverDir} ${checkout.entry}\n`);
            const args = checkout.entry === 'start-test-server.js'
                ? ['start-test-server.js', webSocketUrl]
                : ['-r', 'ts-node/register/transpile-only', 'main.ts'];
            const server = spawn(node.command, args, {
                cwd: checkout.serverDir,
                env: { ...process.env, ...testServerEnv(webSocketUrl) },
                windowsHide: true
            });
            this.children.push(server);
            server.stdout.on('data', (chunk) => this.noteOutput(chunk));
            server.stderr.on('data', (chunk) => this.noteOutput(chunk));
            server.once('exit', (code) => {
                if (!stale() && this.running()) {
                    this.fail(new Error(`The server stopped (code ${code}). See the log below.`));
                }
            });

            const startedAt = Date.now();
            while (!(await portOpen(PORTS.webSocket)) || !(await portOpen(PORTS.web))) {
                if (stale() || !this.running()) {
                    return this.summary();
                }
                if (Date.now() - startedAt > READY_TIMEOUT_MS) {
                    throw new Error('The server did not open its ports within three minutes.');
                }
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
            this.set({ state: 'running', step: '', shareUrl: `${web.url}/web`, webSocketUrl });
            this.log(`[DevServer] Running: share ${web.url}/web`);
        } catch (error) {
            if (!stale()) {
                this.fail(error);
            }
        }
        return this.summary();
    }

    fail(error) {
        this.stopChildren();
        this.set({ state: 'error', step: '', shareUrl: '', webSocketUrl: '', error: String((error && error.message) || error) });
    }

    stopChildren() {
        for (const child of this.children.splice(0)) {
            killTree(child);
        }
    }

    stop() {
        this.runId += 1;
        this.stopChildren();
        this.set({ state: 'idle', step: '', shareUrl: '', webSocketUrl: '', error: '' });
        return this.summary();
    }
}

module.exports = { DevServer, PORTS, findNode, inspectServerRoot, testServerEnv };
