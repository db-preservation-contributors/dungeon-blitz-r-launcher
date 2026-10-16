#!/usr/bin/env node
'use strict';

/**
 * Drives lib/updateNotice.js with a fake fetch and fake platform facts: no Electron, no
 * network.
 *
 * Pinned down: which build installs through electron-updater and which only gets a notice;
 * where the GitHub feed comes from (package.json in a checkout, app-update.yml once
 * electron-builder has stripped `build`); semver with a leading v; that a newer release
 * offers the file for this exact build, the release page when there is none, and nothing
 * for the same, an older, a draft or a pre-release version; that a failed request is quiet
 * and retried on the next tick; the check cadence; and that launcher:updateDownload opens
 * only the URL the service found.
 *
 * Usage: node tools/test-update-notice.js
 */

const assert = require('assert');
const path = require('path');

const { CHECK_INTERVAL_MS, START_DELAY_MS } = require('../lib/update');
const {
    USER_AGENT,
    compareVersions,
    createUpdateNoticeService,
    isAllowedDownloadUrl,
    openUpdateDownload,
    pickAsset,
    readPackageType,
    resolvePublishTarget,
    updateRoute
} = require('../lib/updateNotice');

const packageJson = require(path.join(__dirname, '..', 'package.json'));

const OWNER = 'theminesastudios';
const REPO = 'dungeon-blitz-r-launcher';
const RELEASE_BASE = 'https://github.com/db-preservation-contributors/dungeon-blitz-r-launcher';

/** A /releases/latest answer in GitHub's shape, with the files a release really carries. */
function release(version, { names, draft = false, prerelease = false } = {}) {
    const files = names || [
        `DungeonBlitzR-Launcher-${version}-linux-amd64.deb`,
        `DungeonBlitzR-Launcher-${version}-linux-x86_64.AppImage`,
        `DungeonBlitzR-Launcher-${version}-mac-x64.dmg`,
        `DungeonBlitzR-Launcher-${version}-mac-x64.dmg.blockmap`,
        `DungeonBlitzR-Launcher-${version}-mac-x64.zip`,
        `DungeonBlitzR-Launcher-${version}-mac-x64.zip.blockmap`,
        `DungeonBlitzR-Launcher-${version}-win-ia32-portable.exe`,
        `DungeonBlitzR-Launcher-${version}-win-ia32-setup.exe`,
        `DungeonBlitzR-Launcher-${version}-win-x64-portable.exe`,
        `DungeonBlitzR-Launcher-${version}-win-x64-setup.exe`,
        `DungeonBlitzR-Launcher-${version}-win-x64-setup.exe.blockmap`,
        'latest-linux.yml',
        'latest-mac.yml',
        'latest.yml'
    ];
    return {
        tag_name: `v${version}`,
        name: version,
        draft,
        prerelease,
        html_url: `${RELEASE_BASE}/releases/tag/v${version}`,
        assets: files.map((name) => ({ name, browser_download_url: `${RELEASE_BASE}/releases/download/v${version}/${name}` }))
    };
}

function download(version, file) {
    return `${RELEASE_BASE}/releases/download/v${version}/${file}`;
}

/** fetch that answers with `body` (or runs `answer`) and records each request. */
function fakeFetch(answer) {
    const calls = [];
    const fetch = (url, init) => {
        calls.push({ url, init });
        return typeof answer === 'function'
            ? answer(url, init)
            : Promise.resolve({ ok: true, status: 200, json: async () => answer });
    };
    fetch.calls = calls;
    return fetch;
}

function service({ fetch, build, arch = 'x64', current = '1.5.0', logs = [], timeoutMs }) {
    return createUpdateNoticeService({
        fetch,
        app: { getVersion: () => current },
        owner: OWNER,
        repo: REPO,
        build,
        arch,
        log: (line) => logs.push(line),
        timeoutMs
    });
}

function testRoutes() {
    const route = (facts) => {
        const { mode, build } = updateRoute(facts);
        return `${mode}:${build}`;
    };

    // A checkout never checks, whatever it runs on.
    assert.strictEqual(route({ isPackaged: false, platform: 'win32', arch: 'x64' }), 'off:checkout');
    assert.strictEqual(route({ isPackaged: false, platform: 'darwin', arch: 'x64' }), 'off:checkout');

    // Unsigned macOS: Squirrel.Mac refuses, so a notice.
    assert.strictEqual(route({ isPackaged: true, platform: 'darwin', arch: 'x64' }), 'notice:mac');
    assert.strictEqual(route({ isPackaged: true, platform: 'darwin', arch: 'arm64' }), 'notice:mac');

    // The portable .exe, either architecture: electron-builder's stub sets these variables.
    const portable = { PORTABLE_EXECUTABLE_DIR: 'C:\\Games', PORTABLE_EXECUTABLE_FILE: 'C:\\Games\\DB.exe' };
    assert.strictEqual(route({ isPackaged: true, platform: 'win32', arch: 'x64', env: portable }), 'notice:win-portable');
    assert.strictEqual(route({ isPackaged: true, platform: 'win32', arch: 'ia32', env: portable }), 'notice:win-portable');
    assert.strictEqual(
        route({ isPackaged: true, platform: 'win32', arch: 'x64', env: { PORTABLE_EXECUTABLE_FILE: 'C:\\DB.exe' } }),
        'notice:win-portable',
        'either portable variable is enough'
    );

    // The x64 setup is what latest.yml names: electron-updater keeps installing it.
    assert.strictEqual(route({ isPackaged: true, platform: 'win32', arch: 'x64', env: {} }), 'install:win-setup');
    // The ia32 setup would be handed the x64 installer, which refuses 32-bit Windows.
    assert.strictEqual(route({ isPackaged: true, platform: 'win32', arch: 'ia32', env: {} }), 'notice:win-setup');

    // Linux: AppImage and deb both install through electron-updater, as before.
    assert.strictEqual(
        route({ isPackaged: true, platform: 'linux', arch: 'x64', env: { APPIMAGE: '/home/p/DB.AppImage' } }),
        'install:linux-appimage'
    );
    assert.strictEqual(route({ isPackaged: true, platform: 'linux', arch: 'x64', env: {}, packageType: 'deb\n' }), 'install:linux-deb');
    assert.strictEqual(route({ isPackaged: true, platform: 'linux', arch: 'x64', env: {} }), 'install:linux');

    assert.strictEqual(route({ isPackaged: true, platform: 'freebsd', arch: 'x64' }), 'off:freebsd');

    // resources/package-type is read when present and '' otherwise.
    const files = { '/res/package-type': 'deb\n' };
    const readFile = (file) => {
        if (!(file in files)) {
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return files[file];
    };
    assert.strictEqual(readPackageType('/res', readFile), 'deb');
    assert.strictEqual(readPackageType('/other', readFile), '');
    assert.strictEqual(readPackageType('', readFile), '');

    console.log('[test-update-notice] which build installs and which gets a notice: OK');
}

function testFeed() {
    // A checkout reads build.publish itself.
    assert.deepStrictEqual(resolvePublishTarget({ packageJson }), { owner: OWNER, repo: REPO });

    // A packaged app has no `build` key; app-update.yml is electron-builder's copy of it.
    const yml = `owner: ${OWNER}\nrepo: ${REPO}\nprovider: github\nupdaterCacheDirName: dungeon-blitz-r-launcher-updater\n`;
    const stripped = { ...packageJson };
    delete stripped.build;
    const readFile = (file) => {
        assert.strictEqual(file, path.join('/res', 'app-update.yml'));
        return yml;
    };
    assert.deepStrictEqual(resolvePublishTarget({ packageJson: stripped, resourcesPath: '/res', readFile }), { owner: OWNER, repo: REPO });

    // Neither: no feed, so main.js does not arm a check.
    const missing = () => {
        throw new Error('ENOENT');
    };
    assert.strictEqual(resolvePublishTarget({ packageJson: stripped, resourcesPath: '/res', readFile: missing }), null);
    assert.strictEqual(
        resolvePublishTarget({ packageJson: stripped, resourcesPath: '/res', readFile: () => 'provider: generic\nurl: https://x\n' }),
        null,
        'only a GitHub feed has a releases API'
    );

    console.log('[test-update-notice] the feed comes from build.publish or app-update.yml: OK');
}

function testVersions() {
    assert.strictEqual(compareVersions('v1.6.0', '1.5.0'), 1);
    assert.strictEqual(compareVersions('1.6.0', 'v1.6.0'), 0);
    assert.strictEqual(compareVersions('V1.4.9', '1.5.0'), -1);
    assert.strictEqual(compareVersions('1.10.0', '1.9.9'), 1, 'numeric, not string, order');
    assert.strictEqual(compareVersions('2.0.0', '1.99.99'), 1);
    assert.strictEqual(compareVersions('1.6.0-beta.1', '1.6.0'), -1, 'a pre-release is below its release');
    assert.strictEqual(compareVersions('1.6.0-beta.2', '1.6.0-beta.10'), -1);
    assert.strictEqual(compareVersions('1.6.0+build.5', '1.6.0'), 0, 'build metadata does not count');
    assert.strictEqual(compareVersions('latest', '1.5.0'), null);
    assert.strictEqual(compareVersions('', '1.5.0'), null);

    console.log('[test-update-notice] semver with a leading v: OK');
}

function testAssets() {
    const assets = release('1.6.0').assets;
    const name = (build, arch) => {
        const asset = pickAsset(assets, { build, arch });
        return asset ? asset.name : null;
    };
    assert.strictEqual(name('mac', 'x64'), 'DungeonBlitzR-Launcher-1.6.0-mac-x64.dmg', 'the dmg, not its blockmap');
    assert.strictEqual(name('mac', 'arm64'), 'DungeonBlitzR-Launcher-1.6.0-mac-x64.dmg', 'any dmg when there is none for the arch');
    assert.strictEqual(name('win-portable', 'x64'), 'DungeonBlitzR-Launcher-1.6.0-win-x64-portable.exe');
    assert.strictEqual(name('win-portable', 'ia32'), 'DungeonBlitzR-Launcher-1.6.0-win-ia32-portable.exe');
    assert.strictEqual(name('win-setup', 'ia32'), 'DungeonBlitzR-Launcher-1.6.0-win-ia32-setup.exe');
    assert.strictEqual(name('win-portable', 'arm64'), null);
    assert.strictEqual(pickAsset(null, { build: 'mac', arch: 'x64' }), null);

    assert.strictEqual(isAllowedDownloadUrl(download('1.6.0', 'x.dmg')), true);
    assert.strictEqual(isAllowedDownloadUrl('http://github.com/x'), false, 'https only');
    assert.strictEqual(isAllowedDownloadUrl('https://github.com.evil.example/x'), false);
    assert.strictEqual(isAllowedDownloadUrl('file:///etc/passwd'), false);
    assert.strictEqual(isAllowedDownloadUrl('javascript:alert(1)'), false);
    assert.strictEqual(isAllowedDownloadUrl(''), false);

    console.log('[test-update-notice] the file for this build is picked by name: OK');
}

async function testAvailable() {
    const expectations = [
        { build: 'mac', arch: 'x64', file: 'DungeonBlitzR-Launcher-1.6.0-mac-x64.dmg' },
        { build: 'win-portable', arch: 'x64', file: 'DungeonBlitzR-Launcher-1.6.0-win-x64-portable.exe' },
        { build: 'win-portable', arch: 'ia32', file: 'DungeonBlitzR-Launcher-1.6.0-win-ia32-portable.exe' },
        { build: 'win-setup', arch: 'ia32', file: 'DungeonBlitzR-Launcher-1.6.0-win-ia32-setup.exe' }
    ];

    for (const { build, arch, file } of expectations) {
        const fetch = fakeFetch(release('1.6.0'));
        const logs = [];
        const notice = service({ fetch, build, arch, logs });
        const states = [];
        notice.on('state', (s) => states.push(s.state));

        assert.strictEqual(notice.summary().state, 'idle');
        assert.strictEqual(notice.downloadUrl(), '', 'no link before a check');

        const summary = await notice.checkNow();
        assert.deepStrictEqual(states, ['checking', 'available'], `${build}/${arch}`);
        assert.strictEqual(summary.mode, 'notice');
        assert.strictEqual(summary.state, 'available');
        assert.strictEqual(summary.version, '1.6.0', 'the leading v is dropped');
        assert.strictEqual(summary.currentVersion, '1.5.0');
        assert.strictEqual(summary.asset, file);
        assert.strictEqual(notice.downloadUrl(), download('1.6.0', file), `${build}/${arch} offers its own file`);
        assert.strictEqual(notice.restartToUpdate(), false, 'nothing is ever installed by this path');
        assert.ok(logs.some((line) => line.includes('1.6.0 is available')), 'the find is logged');

        // The request: the releases API for build.publish's repository, followed through
        // GitHub's redirect for the transferred repository, with a User-Agent.
        assert.strictEqual(fetch.calls.length, 1);
        assert.strictEqual(fetch.calls[0].url, `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`);
        assert.strictEqual(fetch.calls[0].init.redirect, 'follow');
        assert.strictEqual(fetch.calls[0].init.headers['User-Agent'], USER_AGENT);
        assert.ok(fetch.calls[0].init.signal, 'the request can be aborted by the timeout');
    }

    console.log('[test-update-notice] a newer release offers the file for this build: OK');
}

async function testNotNewer() {
    for (const latest of ['1.5.0', '1.4.2', '1.5.0-beta.3']) {
        const notice = service({ fetch: fakeFetch(release(latest)), build: 'mac', current: '1.5.0' });
        const summary = await notice.checkNow();
        assert.strictEqual(summary.state, 'not-available', `${latest} is not newer than 1.5.0`);
        assert.strictEqual(summary.version, '');
        assert.strictEqual(notice.downloadUrl(), '');
    }

    // An update found and then published over by... the same version: back to up to date.
    let body = release('1.6.0');
    const notice = service({ fetch: fakeFetch(() => Promise.resolve({ ok: true, status: 200, json: async () => body })), build: 'mac' });
    assert.strictEqual((await notice.checkNow()).state, 'available');
    body = release('1.5.0');
    assert.strictEqual((await notice.checkNow()).state, 'not-available');
    assert.strictEqual(notice.downloadUrl(), '');

    console.log('[test-update-notice] the same or an older version is not offered: OK');
}

async function testFallbackToReleasePage() {
    // A release that forgot the dmg still points somewhere useful.
    const withoutDmg = release('1.6.0', {
        names: ['DungeonBlitzR-Launcher-1.6.0-win-x64-setup.exe', 'DungeonBlitzR-Launcher-1.6.0-mac-x64.zip', 'latest.yml']
    });
    let notice = service({ fetch: fakeFetch(withoutDmg), build: 'mac' });
    let summary = await notice.checkNow();
    assert.strictEqual(summary.state, 'available');
    assert.strictEqual(summary.asset, '', 'no file name when the link is the page');
    assert.strictEqual(notice.downloadUrl(), `${RELEASE_BASE}/releases/tag/v1.6.0`);

    const noAssets = { ...release('1.6.0'), assets: undefined };
    notice = service({ fetch: fakeFetch(noAssets), build: 'win-portable', arch: 'x64' });
    await notice.checkNow();
    assert.strictEqual(notice.downloadUrl(), `${RELEASE_BASE}/releases/tag/v1.6.0`);

    // A file link off GitHub is not handed to the browser; the page is.
    const offsite = release('1.6.0');
    offsite.assets = offsite.assets.map((asset) => ({ ...asset, browser_download_url: `https://downloads.example/${asset.name}` }));
    notice = service({ fetch: fakeFetch(offsite), build: 'mac' });
    await notice.checkNow();
    assert.strictEqual(notice.downloadUrl(), `${RELEASE_BASE}/releases/tag/v1.6.0`);

    // And with no GitHub link at all, nothing is offered.
    const nowhere = { ...offsite, html_url: 'https://downloads.example/release' };
    const logs = [];
    notice = service({ fetch: fakeFetch(nowhere), build: 'mac', logs });
    summary = await notice.checkNow();
    assert.notStrictEqual(summary.state, 'available');
    assert.strictEqual(notice.downloadUrl(), '');

    console.log('[test-update-notice] a missing file falls back to the release page: OK');
}

async function testQuietFailures() {
    // Drafts and pre-releases: /releases/latest should never return them; if it does, they
    // are not offered.
    for (const body of [release('1.6.0', { draft: true }), release('1.6.0', { prerelease: true })]) {
        const notice = service({ fetch: fakeFetch(body), build: 'mac' });
        const summary = await notice.checkNow();
        assert.strictEqual(summary.state, 'not-available');
        assert.strictEqual(notice.downloadUrl(), '');
    }

    // A network error, a 404 (no published release), a 403 (rate limit), junk JSON, an
    // unreadable tag: logged, never the 'error' state, and the state before the check stands.
    const failures = [
        () => Promise.reject(new Error('getaddrinfo ENOTFOUND api.github.com')),
        () => Promise.resolve({ ok: false, status: 404, json: async () => ({ message: 'Not Found' }) }),
        () => Promise.resolve({ ok: false, status: 403, json: async () => ({ message: 'rate limit' }) }),
        () => Promise.resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }),
        () => Promise.resolve({ ok: true, status: 200, json: async () => ({ ...release('1.6.0'), tag_name: 'nightly', name: 'nightly' }) }),
        () => {
            throw new Error('fetch threw synchronously');
        }
    ];
    for (const failure of failures) {
        const logs = [];
        const notice = service({ fetch: fakeFetch(failure), build: 'mac', logs });
        const states = [];
        notice.on('state', (s) => states.push(s.state));
        let summary;
        try {
            summary = await notice.checkNow();
        } catch (error) {
            assert.fail(`a failed check must not throw: ${error.message}`);
        }
        assert.strictEqual(summary.state, 'idle', 'back to the resting state, not an error');
        assert.ok(!states.includes('error'), 'the error state is never reported');
        assert.ok(summary.error, 'the reason is kept for the hover');
        assert.strictEqual(logs.length, 1, 'and logged once');
    }

    // A failure after an update was found keeps offering it.
    let fail = false;
    const flaky = fakeFetch(() =>
        fail ? Promise.reject(new Error('ECONNRESET')) : Promise.resolve({ ok: true, status: 200, json: async () => release('1.6.0') })
    );
    const notice = service({ fetch: flaky, build: 'mac' });
    await notice.checkNow();
    fail = true;
    const summary = await notice.checkNow();
    assert.strictEqual(summary.state, 'available', 'a blip does not take the offer away');
    assert.strictEqual(notice.downloadUrl(), download('1.6.0', 'DungeonBlitzR-Launcher-1.6.0-mac-x64.dmg'));

    // A request that never answers is cut off by the timeout and aborted.
    let aborted = false;
    const hanging = fakeFetch((_url, init) => {
        init.signal.addEventListener('abort', () => {
            aborted = true;
        });
        return new Promise(() => {});
    });
    const slow = service({ fetch: hanging, build: 'mac', timeoutMs: 20 });
    const slowSummary = await slow.checkNow();
    assert.strictEqual(slowSummary.state, 'idle');
    assert.match(slowSummary.error, /no answer from GitHub/);
    assert.strictEqual(aborted, true, 'the hung request is aborted');

    // Two checks at once share one request.
    const once = fakeFetch(release('1.6.0'));
    const shared = service({ fetch: once, build: 'mac' });
    await Promise.all([shared.checkNow(), shared.checkNow()]);
    assert.strictEqual(once.calls.length, 1, 'overlapping checks make one request');

    console.log('[test-update-notice] drafts, pre-releases and failed requests stay quiet: OK');
}

function testCadence() {
    const captured = { timeouts: [], intervals: [] };
    const realSetTimeout = global.setTimeout;
    const realSetInterval = global.setInterval;
    const fetch = fakeFetch(release('1.6.0'));
    const notice = service({ fetch, build: 'mac' });

    // Captured only around start(), so the checks themselves run on real timers.
    global.setTimeout = (fn, ms) => captured.timeouts.push({ fn, ms });
    global.setInterval = (fn, ms) => captured.intervals.push({ fn, ms });
    try {
        notice.start();
        notice.start();
    } finally {
        global.setTimeout = realSetTimeout;
        global.setInterval = realSetInterval;
    }

    assert.strictEqual(captured.timeouts.length, 1, 'one first check, however often start() is called');
    assert.strictEqual(captured.timeouts[0].ms, START_DELAY_MS, 'the same start delay as electron-updater');
    assert.strictEqual(captured.intervals.length, 1);
    assert.strictEqual(captured.intervals[0].ms, CHECK_INTERVAL_MS, 'the same six-hour cadence');
    assert.strictEqual(fetch.calls.length, 0, 'nothing is asked before the delay');

    captured.timeouts[0].fn();
    assert.strictEqual(fetch.calls.length, 1, 'the delayed first check asks GitHub');
    notice.stop();

    console.log('[test-update-notice] the check cadence matches electron-updater: OK');
}

async function testDownloadIpc() {
    const opened = [];
    const openExternal = async (url) => {
        opened.push(url);
    };
    const notice = service({ fetch: fakeFetch(release('1.6.0')), build: 'win-portable', arch: 'x64' });
    const own = download('1.6.0', 'DungeonBlitzR-Launcher-1.6.0-win-x64-portable.exe');

    // Before an update is found there is nothing to open.
    assert.strictEqual(await openUpdateDownload({ service: notice, openExternal }), false);
    // No service (a checkout), or electron-updater's service, which has no download link.
    assert.strictEqual(await openUpdateDownload({ service: null, openExternal }), false);
    assert.strictEqual(await openUpdateDownload({ service: { restartToUpdate: () => false }, openExternal }), false);

    await notice.checkNow();
    // Anything the renderer names that is not the service's own URL is refused.
    for (const requested of ['https://evil.example/setup.exe', 'file:///C:/Windows/System32/calc.exe', `${own}?x=1`, 42, '']) {
        assert.strictEqual(await openUpdateDownload({ service: notice, openExternal, requested }), false, String(requested));
    }
    assert.deepStrictEqual(opened, [], 'nothing opened for a foreign URL');

    // The renderer's real call names nothing; naming the service's own URL is also fine.
    assert.strictEqual(await openUpdateDownload({ service: notice, openExternal }), true);
    assert.strictEqual(await openUpdateDownload({ service: notice, openExternal, requested: own }), true);
    assert.deepStrictEqual(opened, [own, own]);

    // A service that somehow produced a non-GitHub link is not trusted either.
    const rogue = { downloadUrl: () => 'https://evil.example/setup.exe' };
    assert.strictEqual(await openUpdateDownload({ service: rogue, openExternal }), false);
    assert.deepStrictEqual(opened, [own, own]);

    console.log('[test-update-notice] launcher:updateDownload opens only the service URL: OK');
}

function testConstruction() {
    assert.throws(() => createUpdateNoticeService({ owner: OWNER, repo: REPO }), /needs a fetch/);
    assert.throws(() => createUpdateNoticeService({ fetch: () => {}, owner: '', repo: REPO }), /owner and repo/);
}

async function main() {
    testRoutes();
    testFeed();
    testVersions();
    testAssets();
    await testAvailable();
    await testNotNewer();
    await testFallbackToReleasePage();
    await testQuietFailures();
    testCadence();
    await testDownloadIpc();
    testConstruction();
    console.log('[test-update-notice] all assertions passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
