'use strict';

/**
 * The update path for builds electron-updater cannot install, and the rule for which build
 * takes which path.
 *
 * electron-updater replaces the Windows NSIS install (x64) and the Linux AppImage and .deb
 * in place. It cannot replace:
 *  - macOS: Squirrel.Mac only installs over a code-signed app, and these builds are not
 *    signed, so the check ends in an error every time.
 *  - the Windows portable .exe: NsisUpdater would download the x64 *setup* named by
 *    latest.yml and install a second copy next to the portable one, which the player never
 *    opens again.
 *  - the Windows ia32 setup: latest.yml only ever names the x64 setup (the ia32 run
 *    publishes no manifest), and that installer quits with "x64 Windows required" on a
 *    32-bit Windows. Silently, on quit, every quit.
 *  - the Windows 7 build (`win7`, Electron 22): latest.yml names the Windows 10 setup, which
 *    refuses Windows 7, 8 and 8.1. The win7 runs publish no manifest either.
 *
 * Those builds get a notice instead: the same schedule (a few seconds after start, then every
 * six hours) asks GitHub's API for the latest published release, and when it is newer the
 * status strip offers the matching download -- the .dmg, or the portable/ia32/win7 .exe for
 * this build and architecture -- opened in the player's browser. Nothing is downloaded or installed here.
 *
 * Everything that touches the outside (fetch, the platform, the files electron-builder
 * leaves in resources/) is a parameter, so tools/test-update-notice.js runs it with no
 * Electron and no network.
 */

const fs = require('fs');
const path = require('path');

const { CHECK_INTERVAL_MS, START_DELAY_MS } = require('./update');

const REQUEST_TIMEOUT_MS = 15000;
const USER_AGENT = 'dungeon-blitz-r-launcher-update-check';

/**
 * Which way this build updates.
 *
 *   install -- electron-updater downloads and installs (as before)
 *   notice  -- a newer release is announced with a download link; nothing is installed
 *   off     -- a checkout or an unknown platform: no checks at all
 *
 * `packageType` is the contents of resources/package-type, which electron-builder writes
 * for deb/rpm/pacman packages and which electron-updater reads to pick DebUpdater.
 * `legacyWindows` is the Windows 7 build (lib/windowsSupport.js, isLegacyWindowsBuild).
 */
function updateRoute({ isPackaged, platform, arch, env = {}, packageType = '', legacyWindows = false } = {}) {
    if (!isPackaged) {
        return { mode: 'off', build: 'checkout', reason: 'a checkout updates by git pull' };
    }

    if (platform === 'darwin') {
        return {
            mode: 'notice',
            build: 'mac',
            reason: 'macOS builds are unsigned, and macOS only installs updates over a signed app'
        };
    }

    if (platform === 'win32') {
        // Checked first: its portable and setup alike must only ever be offered win7 files.
        if (legacyWindows) {
            const portable = Boolean(env.PORTABLE_EXECUTABLE_DIR || env.PORTABLE_EXECUTABLE_FILE);
            return {
                mode: 'notice',
                build: portable ? 'win7-portable' : 'win7-setup',
                reason: 'the update feed only carries the Windows 10 installer, not the Windows 7 build'
            };
        }
        if (env.PORTABLE_EXECUTABLE_DIR || env.PORTABLE_EXECUTABLE_FILE) {
            return {
                mode: 'notice',
                build: 'win-portable',
                reason: 'the portable build is a single file the updater cannot replace'
            };
        }
        if (arch !== 'x64') {
            return {
                mode: 'notice',
                build: 'win-setup',
                reason: `the update feed only carries the x64 installer, not ${arch}`
            };
        }
        return { mode: 'install', build: 'win-setup', reason: '' };
    }

    if (platform === 'linux') {
        if (env.APPIMAGE) {
            return { mode: 'install', build: 'linux-appimage', reason: '' };
        }
        if (String(packageType).trim() === 'deb') {
            return { mode: 'install', build: 'linux-deb', reason: '' };
        }
        // Whatever else this is, electron-updater was already in charge of it and stays so;
        // it simply does nothing for a build it does not recognise.
        return { mode: 'install', build: 'linux', reason: '' };
    }

    return { mode: 'off', build: String(platform || 'unknown'), reason: 'no build of this platform is published' };
}

/** resources/package-type, or '' when it is not there (everything but deb/rpm/pacman). */
function readPackageType(resourcesPath, readFile = fs.readFileSync) {
    if (!resourcesPath) {
        return '';
    }
    try {
        return String(readFile(path.join(resourcesPath, 'package-type'), 'utf8')).trim();
    } catch {
        return '';
    }
}

function githubTarget(entry) {
    if (!entry || typeof entry !== 'object' || entry.provider !== 'github') {
        return null;
    }
    const owner = String(entry.owner || '').trim();
    const repo = String(entry.repo || '').trim();
    return owner && repo ? { owner, repo } : null;
}

/** The two flat keys that matter from electron-builder's app-update.yml. */
function parseAppUpdateYml(text) {
    const fields = {};
    for (const line of String(text || '').split(/\r?\n/)) {
        const match = /^([A-Za-z]+):\s*(.*?)\s*$/.exec(line);
        if (match) {
            fields[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
        }
    }
    return fields;
}

/**
 * The GitHub repository the releases come from: package.json's build.publish, the one place
 * it is written down.
 *
 * electron-builder strips `build` from the package.json it packs, so an installed launcher
 * reads the same entry from resources/app-update.yml, which electron-builder generates from
 * build.publish for the dmg/zip and NSIS targets (the portable .exe is packed from the same
 * folder as the NSIS setup). Whether every target really carries that file is not something a
 * test here can see, so the last resort is package.json's `repository`, which survives
 * packaging: a missing app-update.yml must not quietly switch the notice off.
 */
function resolvePublishTarget({ packageJson, resourcesPath, readFile = fs.readFileSync } = {}) {
    const publish = packageJson && packageJson.build ? packageJson.build.publish : null;
    for (const entry of [].concat(publish || [])) {
        const target = githubTarget(entry);
        if (target) {
            return target;
        }
    }

    if (resourcesPath) {
        try {
            const fromYml = githubTarget(parseAppUpdateYml(readFile(path.join(resourcesPath, 'app-update.yml'), 'utf8')));
            if (fromYml) {
                return fromYml;
            }
        } catch {
            // No app-update.yml in this build: fall through to package.json's repository.
        }
    }
    return repositoryTarget(packageJson && packageJson.repository);
}

/** `git+https://github.com/<owner>/<repo>.git` (or `{ url }`, or `github:owner/repo`) -> { owner, repo }. */
function repositoryTarget(repository) {
    const url = String((repository && typeof repository === 'object' ? repository.url : repository) || '').trim();
    const match = /^(?:git\+)?(?:https?:\/\/|git:\/\/|ssh:\/\/git@|git@)?(?:www\.)?github\.com[/:]([^/\s]+)\/([^/\s#]+?)(?:\.git)?\/?$/i.exec(url)
        || /^github:([^/\s]+)\/([^/\s#]+)$/i.exec(url);
    return match ? { owner: match[1], repo: match[2] } : null;
}

/** `v1.6.0`, `1.6.0`, `1.6.0-beta.1` -> comparable parts; anything else -> null. */
function parseVersion(value) {
    const match = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/i.exec(String(value || ''));
    if (!match) {
        return null;
    }
    return {
        core: [Number(match[1]), Number(match[2]), Number(match[3])],
        pre: match[4] ? match[4].split('.') : []
    };
}

/** Semver precedence: <0, 0, >0; null when either side is not a version. */
function compareVersions(a, b) {
    const left = parseVersion(a);
    const right = parseVersion(b);
    if (!left || !right) {
        return null;
    }
    for (let i = 0; i < 3; i += 1) {
        if (left.core[i] !== right.core[i]) {
            return left.core[i] < right.core[i] ? -1 : 1;
        }
    }
    // A pre-release sorts below its release; otherwise compare identifier by identifier.
    if (!left.pre.length || !right.pre.length) {
        return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
    }
    for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
        const x = left.pre[i];
        const y = right.pre[i];
        if (x === undefined || y === undefined) {
            return x === undefined ? -1 : 1;
        }
        const xNumeric = /^\d+$/.test(x);
        const yNumeric = /^\d+$/.test(y);
        if (xNumeric && yNumeric) {
            if (Number(x) !== Number(y)) {
                return Number(x) < Number(y) ? -1 : 1;
            }
        } else if (xNumeric !== yNumeric) {
            return xNumeric ? -1 : 1;
        } else if (x !== y) {
            return x < y ? -1 : 1;
        }
    }
    return 0;
}

/**
 * The release file this build would install by hand, by the artifact names in package.json:
 * `...-mac-<arch>.dmg`, `...-win-<arch>-portable.exe`, `...-win-<arch>-setup.exe`, and the
 * Windows 7 build's `...-win7-<arch>-portable.exe` / `-setup.exe`. Blockmaps and manifests
 * never match. null when the release does not carry one.
 */
function pickAsset(assets, { build, arch } = {}) {
    const files = (Array.isArray(assets) ? assets : []).filter(
        (asset) => asset && typeof asset.name === 'string' && typeof asset.browser_download_url === 'string'
    );
    const named = (suffix) => files.find((asset) => asset.name.toLowerCase().endsWith(suffix.toLowerCase())) || null;

    if (build === 'mac') {
        return named(`-mac-${arch}.dmg`) || named('.dmg');
    }
    if (build === 'win-portable') {
        return named(`-win-${arch}-portable.exe`);
    }
    if (build === 'win-setup') {
        return named(`-win-${arch}-setup.exe`);
    }
    if (build === 'win7-portable') {
        return named(`-win7-${arch}-portable.exe`);
    }
    if (build === 'win7-setup') {
        return named(`-win7-${arch}-setup.exe`);
    }
    return null;
}

/**
 * A fetch on Electron's network stack, so a system proxy applies as it does for
 * electron-updater. `net.fetch` came in Electron 28; the Windows 7 build runs Electron 22,
 * so there the same GET is made with `net.request`. Only what the update check uses is
 * there: method, headers, an abort signal, and a response with ok, status, text() and json().
 */
function electronFetch(net) {
    if (net && typeof net.fetch === 'function') {
        return (url, init) => net.fetch(url, init);
    }
    return (url, init = {}) =>
        new Promise((resolve, reject) => {
            const request = net.request({ url: String(url), method: init.method || 'GET', redirect: 'follow' });
            for (const [name, value] of Object.entries(init.headers || {})) {
                request.setHeader(name, value);
            }

            const signal = init.signal;
            if (signal) {
                if (signal.aborted) {
                    reject(new Error('aborted'));
                    return;
                }
                signal.addEventListener(
                    'abort',
                    () => {
                        request.abort();
                        reject(new Error('aborted'));
                    },
                    { once: true }
                );
            }

            request.on('response', (response) => {
                const chunks = [];
                response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
                response.on('error', reject);
                response.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf8');
                    const status = Number(response.statusCode) || 0;
                    resolve({
                        ok: status >= 200 && status < 300,
                        status,
                        text: async () => body,
                        json: async () => JSON.parse(body)
                    });
                });
            });
            request.on('error', reject);
            request.end();
        });
}

/**
 * Only a GitHub https page or download is ever handed to the browser. The URL comes from
 * GitHub's own response, but that response is still outside input.
 */
function isAllowedDownloadUrl(url) {
    try {
        const parsed = new URL(String(url || ''));
        return parsed.protocol === 'https:' && parsed.hostname === 'github.com';
    } catch {
        return false;
    }
}

function withTimeout(promise, ms, onTimeout) {
    let timer = null;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            onTimeout();
            reject(new Error(`no answer from GitHub within ${Math.round(ms / 1000)} s`));
        }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The notice service: the same surface as createUpdateService (on, summary, start, stop,
 * checkNow, restartToUpdate) plus downloadUrl(), so main.js and the status strip treat both
 * alike.
 *
 * States: idle, checking, available, not-available. A failed check is not a state: it is
 * logged, the previous state stands (an update already found stays offered), and the next
 * six-hour tick tries again.
 */
function createUpdateNoticeService({
    fetch,
    app,
    owner,
    repo,
    build,
    arch,
    log = () => {},
    timeoutMs = REQUEST_TIMEOUT_MS
} = {}) {
    if (typeof fetch !== 'function') {
        throw new Error('createUpdateNoticeService needs a fetch');
    }
    if (!owner || !repo) {
        throw new Error('createUpdateNoticeService needs the GitHub owner and repo');
    }

    const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`;
    const currentVersion = () => (app && typeof app.getVersion === 'function' ? String(app.getVersion()) : '');

    const service = {
        state: 'idle',
        version: '',
        downloadUrl: '',
        asset: '',
        error: '',
        lastCheckedAt: 0
    };

    const listeners = new Map();
    function emit(event) {
        for (const handler of listeners.get(event) || []) {
            handler(summary());
        }
        if (event !== 'state') {
            emit('state');
        }
    }
    function on(event, handler) {
        if (!listeners.has(event)) {
            listeners.set(event, []);
        }
        listeners.get(event).push(handler);
        return () => {
            const handlers = listeners.get(event) || [];
            const index = handlers.indexOf(handler);
            if (index >= 0) {
                handlers.splice(index, 1);
            }
        };
    }

    function summary() {
        return {
            mode: 'notice',
            state: service.state,
            percent: 0,
            version: service.version,
            asset: service.asset,
            error: service.error,
            currentVersion: currentVersion(),
            lastCheckedAt: service.lastCheckedAt
        };
    }

    async function fetchLatest() {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const request = fetch(endpoint, {
            method: 'GET',
            redirect: 'follow',
            headers: {
                Accept: 'application/vnd.github+json',
                'User-Agent': USER_AGENT
            },
            signal: controller ? controller.signal : undefined
        });
        const response = await withTimeout(Promise.resolve(request), timeoutMs, () => controller && controller.abort());
        if (!response || !response.ok) {
            // 404 is "no published release yet": a draft is invisible to this endpoint.
            throw new Error(`GitHub answered ${response ? response.status : 'nothing'}`);
        }
        return response.json();
    }

    function settle(fields, event) {
        Object.assign(service, fields);
        emit(event);
    }

    let inFlight = null;
    let previousState = 'idle';

    async function runCheck() {
        previousState = service.state === 'checking' ? previousState : service.state;
        service.lastCheckedAt = Date.now();
        settle({ state: 'checking' }, 'checking');

        let release;
        try {
            release = await fetchLatest();
        } catch (error) {
            const message = String((error && error.message) || error);
            log(`[Update] release check failed: ${message}; trying again at the next check.`);
            settle({ state: previousState, error: message }, 'error');
            return summary();
        }

        if (!release || typeof release !== 'object' || release.draft || release.prerelease) {
            // /releases/latest never answers with these; if it ever does, they are not offered.
            settle({ state: 'not-available', version: '', downloadUrl: '', asset: '', error: '' }, 'not-available');
            return summary();
        }

        const latest = String(release.tag_name || release.name || '').trim();
        const order = compareVersions(latest, currentVersion());
        if (order === null) {
            log(`[Update] cannot compare release "${latest}" with ${currentVersion()}; ignoring it.`);
            settle({ state: previousState, error: `unreadable release version "${latest}"` }, 'error');
            return summary();
        }
        if (order <= 0) {
            settle({ state: 'not-available', version: '', downloadUrl: '', asset: '', error: '' }, 'not-available');
            return summary();
        }

        const version = latest.replace(/^v/i, '');
        const asset = pickAsset(release.assets, { build, arch });
        const candidates = [asset && asset.browser_download_url, release.html_url];
        const downloadUrl = candidates.find((url) => isAllowedDownloadUrl(url)) || '';
        if (!downloadUrl) {
            log(`[Update] ${version} is out, but the release has no GitHub link to offer.`);
            settle({ state: previousState, error: 'the release has no GitHub download link' }, 'error');
            return summary();
        }

        const assetName = asset && downloadUrl === asset.browser_download_url ? asset.name : '';
        if (service.state !== 'available' || service.version !== version || service.downloadUrl !== downloadUrl) {
            log(`[Update] ${version} is available: ${assetName || 'release page'} (${downloadUrl}).`);
        }
        settle({ state: 'available', version, downloadUrl, asset: assetName, error: '' }, 'available');
        return summary();
    }

    function check() {
        if (!inFlight) {
            inFlight = runCheck().finally(() => {
                inFlight = null;
            });
        }
        return inFlight;
    }

    let started = false;
    let timer = null;

    return {
        on,
        summary,
        start() {
            if (started) {
                return;
            }
            started = true;
            const startTimer = setTimeout(check, START_DELAY_MS);
            if (startTimer && typeof startTimer.unref === 'function') {
                startTimer.unref();
            }
            timer = setInterval(check, CHECK_INTERVAL_MS);
            if (timer && typeof timer.unref === 'function') {
                timer.unref();
            }
        },
        stop() {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
            started = false;
        },
        checkNow: check,
        // Nothing is installed by this path; the button for it never shows.
        restartToUpdate() {
            return false;
        },
        /** The link this service found, and only while it is offering an update. */
        downloadUrl() {
            return service.state === 'available' ? service.downloadUrl : '';
        }
    };
}

/**
 * The launcher:updateDownload handler, kept here so it is tested with the service. The
 * renderer asks to open "the update"; it never names a URL. If something does pass one, it
 * has to be exactly the URL the service produced, or nothing opens.
 */
async function openUpdateDownload({ service, openExternal, requested } = {}) {
    const url = service && typeof service.downloadUrl === 'function' ? service.downloadUrl() : '';
    if (!url || !isAllowedDownloadUrl(url)) {
        return false;
    }
    if (requested !== undefined && requested !== null && requested !== url) {
        return false;
    }
    await openExternal(url);
    return true;
}

module.exports = {
    REQUEST_TIMEOUT_MS,
    USER_AGENT,
    compareVersions,
    createUpdateNoticeService,
    electronFetch,
    isAllowedDownloadUrl,
    openUpdateDownload,
    parseAppUpdateYml,
    parseVersion,
    pickAsset,
    readPackageType,
    resolvePublishTarget,
    updateRoute
};
