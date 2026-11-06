// The damage meter in the Rust launcher's meter window (src/damage_meter.rs).
//
// lib/damageMeter is Node code (index.js and DB DPS Launcher's files, kept as they are so fixes
// can be copied across whole). Here it runs in the meter window itself, with the few Node
// modules it uses stood in for below; network, files, dialogs and the clipboard are asked of the
// Rust side. build.rs appends the modules after this part, then __dmStart() runs them.
//
// Every value Rust puts in __DM_CONFIG__ (data folder, saved files, version) is set before this.
(function () {
    'use strict';
    if (window.__dmDefine) {
        return;
    }
    const config = window.__DM_CONFIG__ || {};
    const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args || {});

    /* ---------- Buffer: the parts the meter uses ---------- */

    const utf8 = new TextDecoder('utf-8');
    class Buffer extends Uint8Array {
        static alloc(n) {
            return new Buffer(n);
        }
        static isBuffer(value) {
            return value instanceof Buffer;
        }
        static from(value, encoding) {
            if (typeof value === 'string') {
                if (encoding === 'base64') {
                    const raw = atob(value);
                    const out = new Buffer(raw.length);
                    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
                    return out;
                }
                const bytes = new TextEncoder().encode(value);
                const out = new Buffer(bytes.length);
                out.set(bytes);
                return out;
            }
            const out = new Buffer(value.length);
            out.set(value);
            return out;
        }
        static concat(list) {
            const total = list.reduce((n, b) => n + b.length, 0);
            const out = new Buffer(total);
            let at = 0;
            for (const b of list) {
                out.set(b, at);
                at += b.length;
                // A .swz the Rust side already unpacked keeps its chunks through the join.
                if (b.__swzChunks) out.__swzChunks = b.__swzChunks;
            }
            return out;
        }
        readUInt32BE(at) {
            return ((this[at] << 24) >>> 0) + (this[at + 1] << 16) + (this[at + 2] << 8) + this[at + 3];
        }
        toString(encoding) {
            if (encoding === 'base64') {
                let raw = '';
                for (let i = 0; i < this.length; i++) raw += String.fromCharCode(this[i]);
                return btoa(raw);
            }
            return utf8.decode(this);
        }
    }

    /* ---------- events ---------- */

    class EventEmitter {
        constructor() {
            this._events = new Map();
        }
        on(name, fn) {
            if (!this._events.has(name)) this._events.set(name, []);
            this._events.get(name).push(fn);
            return this;
        }
        once(name, fn) {
            const wrapped = (...args) => {
                this.off(name, wrapped);
                fn(...args);
            };
            return this.on(name, wrapped);
        }
        off(name, fn) {
            const list = this._events.get(name);
            if (list) this._events.set(name, list.filter((f) => f !== fn));
            return this;
        }
        removeListener(name, fn) {
            return this.off(name, fn);
        }
        emit(name, ...args) {
            const list = this._events.get(name);
            if (!list || !list.length) return false;
            for (const fn of list.slice()) fn(...args);
            return true;
        }
    }
    EventEmitter.EventEmitter = EventEmitter;

    /* ---------- fs and path: the data folder's few files ---------- */

    // Saved files are read when the window opens (config.files); writes go to the Rust side,
    // which only takes the meter's own files and the export the player just chose.
    const key = (file) => String(file).replace(/\\/g, '/');
    const files = new Map(Object.entries(config.files || {}).map(([name, text]) => [key(name), text]));
    const sep = config.sep || '/';
    const path = {
        sep,
        join: (...parts) => parts.filter((p) => p !== '').join(sep).replace(/[\\/]+/g, sep),
        basename: (p) => String(p).split(/[\\/]/).pop(),
        dirname: (p) => String(p).split(/[\\/]/).slice(0, -1).join(sep)
    };
    const fs = {
        readFileSync(file) {
            if (!files.has(key(file))) {
                const error = new Error(`ENOENT: ${file}`);
                error.code = 'ENOENT';
                throw error;
            }
            return files.get(key(file));
        },
        writeFileSync(file, data) {
            const text = String(data);
            files.set(key(file), text);
            invoke('dm_write_file', { path: file, text }).catch((error) => console.error('[Damage meter]', error));
        },
        mkdirSync() {},
        existsSync: (file) => files.has(key(file))
    };

    /* ---------- http and https, through the Rust side ---------- */

    function request(target, options, onResponse) {
        if (typeof options === 'function') {
            onResponse = options;
            options = {};
        }
        options = options || {};
        const url = String(target && target.href ? target.href : target);
        const req = new EventEmitter();
        let finished = false;
        req.destroy = (error) => {
            if (finished) return;
            finished = true;
            req.emit('error', error || new Error('aborted'));
        };
        req.end = () => {
            invoke('dm_http', { method: options.method || 'GET', url, headers: options.headers || {}, timeoutMs: options.timeout || 10000 })
                .then((answer) => {
                    if (finished) return;
                    if (!answer || answer.error) {
                        finished = true;
                        req.emit('error', new Error((answer && answer.error) || 'no answer'));
                        return;
                    }
                    const response = new EventEmitter();
                    response.statusCode = answer.status;
                    response.headers = { 'content-type': answer.contentType || '' };
                    response.resume = () => {};
                    onResponse(response);
                    const body = Buffer.from(answer.body || '', 'base64');
                    if (answer.swzChunks) body.__swzChunks = answer.swzChunks;
                    if (finished) return;
                    finished = true;
                    if (body.length) response.emit('data', body);
                    response.emit('end');
                })
                .catch((error) => {
                    if (finished) return;
                    finished = true;
                    req.emit('error', new Error(String(error)));
                });
        };
        return req;
    }
    const http = {
        request,
        get(target, options, onResponse) {
            const req = request(target, options, onResponse);
            req.end();
            return req;
        }
    };

    /* ---------- swz: unpacked on the Rust side (zlib) ---------- */

    const swz = {
        unpackSwz(buf) {
            if (buf && Array.isArray(buf.__swzChunks)) return buf.__swzChunks;
            throw new Error('not a .swz file');
        },
        chunkByRoot(chunks, root) {
            const re = new RegExp('<' + root + '[\\s>]');
            for (const c of chunks) {
                if (re.test(c.slice(0, 400))) return c;
            }
            return '';
        }
    };

    /* ---------- a small CommonJS ---------- */

    const builtins = { events: EventEmitter, fs, path, http, https: http, url: { URL }, './swz': swz };
    const defined = new Map();
    const loaded = new Map();
    function load(name) {
        if (Object.prototype.hasOwnProperty.call(builtins, name)) return builtins[name];
        const key = name.replace(/\.js$/, '');
        if (loaded.has(key)) return loaded.get(key).exports;
        const factory = defined.get(key);
        if (!factory) throw new Error(`Cannot find module ${name}`);
        const module = { exports: {} };
        loaded.set(key, module);
        factory(load, module, module.exports, config.bundledDir || '/bundled', Buffer);
        return module.exports;
    }
    window.__dmDefine = (name, factory) => defined.set(name, factory);
    window.__dmFile = (name, text) => files.set(key(name), text);

    /* ---------- the meter, and window.damageMeter for meter.js ---------- */

    window.__dmStart = function () {
        const { DamageMeter } = load('./index');
        const meter = new DamageMeter({ dataDir: config.dataDir || '', version: config.version || 'dev' });
        let token = '';
        meter.io = {
            documentsDir: config.documentsDir || '',
            saveDialog: (defaultPath, filters) => invoke('dm_save_dialog', { defaultPath, filters }).then((file) => file || ''),
            writeClipboard: (text) => void invoke('dm_clipboard', { text: String(text || '') }),
            showItemInFolder: (file) => void invoke('dm_reveal', { path: String(file || '') }),
            showError: (message) => void invoke('dm_error', { message: String(message || '') })
        };
        const views = [];
        meter.on('view', (view) => views.forEach((fn) => fn(view)));
        meter.on('pin', (pinned) => void invoke('dm_pin', { on: Boolean(pinned) }));
        meter.on('state', (summary) => void invoke('dm_state', { summary }));

        const session = (next) => {
            if (next && next.serverUrl) {
                token = String(next.token || '');
                meter.attach({ serverUrl: next.serverUrl, getLauncherToken: () => token });
            } else {
                token = '';
                meter.detach();
            }
        };
        const listen = window.__TAURI__.event.listen;
        void listen('damage-meter:session', (event) => session(event.payload));
        void listen('damage-meter:watch', (event) => meter.watch(Boolean(event.payload)));
        let boundsTimer = null;
        void listen('damage-meter:bounds', (event) => {
            clearTimeout(boundsTimer);
            boundsTimer = setTimeout(() => {
                meter.settings.bounds = event.payload;
                meter.saveSettings();
            }, 500);
        });
        invoke('dm_hello')
            .then((hello) => {
                session(hello && hello.session);
                meter.watch(true);
            })
            .catch(() => meter.watch(true));
        // The device token can change while the game runs (a sign-in from Sync game stats).
        setInterval(() => {
            invoke('dm_hello')
                .then((hello) => {
                    const next = hello && hello.session;
                    if (next && next.token !== undefined) token = String(next.token || '');
                })
                .catch(() => {});
        }, 30000);

        window.damageMeter = Object.freeze({
            command: (cmd, arg) => meter.command(String(cmd || ''), arg),
            onView: (handler) => {
                views.push(handler);
                return () => {
                    const at = views.indexOf(handler);
                    if (at >= 0) views.splice(at, 1);
                };
            }
        });
    };
})();
