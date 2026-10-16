#!/usr/bin/env node
'use strict';

/**
 * Assembles FlashBrowser -- the second, smoother game engine, see lib/flashBrowser.js -- for one
 * target into vendor/flashbrowser/<target>/, which is where packaging picks it up
 * (build.extraResources) and where the launcher looks:
 *
 *   runtime/   Electron 11, downloaded from Electron's releases and checked against the
 *              SHA-256 pinned in flashbrowser.lock.json, unpacked untouched
 *   app/       the game-window app, copied from flashbrowser/ (plus the window icon)
 *   plugin/    FlashBrowser's PPAPI Flash plugin, copied from payload/flash/<platform>/ (Git
 *              LFS) and checked file by file against the lock
 *
 * The whole folder is then fingerprinted into lib/flashbrowser.integrity.json, which is packed
 * into the app's own code: a packaged launcher refuses to start a FlashBrowser that does not
 * match it (lib/integrity.js).
 *
 * A target with no FlashBrowser (32-bit Windows, Linux: there is no plugin for them) is not an
 * error: the folder and the fingerprint are cleared and that build offers the standalone
 * Flash Player only.
 *
 * Usage:
 *   node tools/fetch-flash-browser.js [--platform win32|darwin|linux] [--arch x64|ia32] [--force]
 *
 * Needs Node 18+ (global fetch). The macOS runtime is unpacked with ditto, which keeps the
 * symlinks inside Electron.app, so the darwin target has to be assembled on a Mac -- which is
 * where the macOS package is built anyway.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LAUNCHER_ROOT = path.resolve(__dirname, '..');
const LOCK_PATH = path.join(LAUNCHER_ROOT, 'flashbrowser.lock.json');
const VENDOR_ROOT = path.join(LAUNCHER_ROOT, 'vendor', 'flashbrowser');
const APP_SOURCE = path.join(LAUNCHER_ROOT, 'flashbrowser');
const ICON_SOURCE = path.join(LAUNCHER_ROOT, 'renderer', 'assets', 'icon.png');

function parseArgs(argv) {
    const args = { platform: process.platform, arch: process.arch, force: false };
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === '--platform' && argv[index + 1]) {
            args.platform = String(argv[index + 1]);
            index += 1;
        } else if (argv[index] === '--arch' && argv[index + 1]) {
            args.arch = String(argv[index + 1]);
            index += 1;
        } else if (argv[index] === '--force') {
            args.force = true;
        }
    }
    return args;
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function download(url) {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
}

/** Tries each mirror in turn and returns the first download whose hash matches. */
async function fetchVerified(entry) {
    const failures = [];
    for (const url of entry.urls) {
        let body;
        try {
            body = await download(url);
        } catch (error) {
            failures.push(`${url}: ${error.message}`);
            continue;
        }
        const hash = sha256(body);
        console.log(`[fetch-flash-browser] ${url} -> ${body.length} bytes, sha256 ${hash}`);
        if (hash === entry.sha256) {
            return body;
        }
        failures.push(`${url}: sha256 ${hash} does not match the pinned ${entry.sha256}`);
    }
    throw new Error(`could not fetch ${entry.file}:\n  ${failures.join('\n  ')}`);
}

/** Unpacks a zip with whatever this machine has that keeps it intact. */
function unzip(archive, target) {
    fs.mkdirSync(target, { recursive: true });
    if (process.platform === 'darwin') {
        // ditto keeps the symlinks inside Electron.app's frameworks; unzip would too, but ditto
        // is what Apple ships for exactly this.
        execFileSync('ditto', ['-x', '-k', archive, target], { stdio: 'inherit' });
        return;
    }
    if (process.platform === 'win32') {
        // Windows' own bsdtar reads zips; the GNU tar a Git Bash puts first on PATH does not.
        const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
        if (fs.existsSync(systemTar)) {
            execFileSync(systemTar, ['-xf', archive, '-C', target], { stdio: 'inherit' });
            return;
        }
        execFileSync(
            'powershell.exe',
            [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `Expand-Archive -LiteralPath ${JSON.stringify(archive)} -DestinationPath ${JSON.stringify(target)} -Force`
            ],
            { stdio: 'inherit' }
        );
        return;
    }
    execFileSync('unzip', ['-q', archive, '-d', target], { stdio: 'inherit' });
}

function copyRecursive(source, target) {
    if (fs.statSync(source).isDirectory()) {
        fs.mkdirSync(target, { recursive: true });
        for (const entry of fs.readdirSync(source)) {
            copyRecursive(path.join(source, entry), path.join(target, entry));
        }
        return;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
}

/**
 * Copies the plugin out of payload/ and checks every file of it against the lock. A Git LFS
 * pointer (a checkout made without `git lfs pull`) is named as such: it is the usual reason the
 * bytes are wrong.
 */
function stagePlugin(plugin, target) {
    const source = path.join(LAUNCHER_ROOT, plugin.payload);
    if (!fs.existsSync(source)) {
        throw new Error(`${plugin.payload} is missing`);
    }

    const destination = path.join(target, 'plugin', plugin.name);
    copyRecursive(source, destination);

    for (const [relative, expected] of Object.entries(plugin.files)) {
        const file = relative ? path.join(destination, ...relative.split('/')) : destination;
        if (!fs.existsSync(file)) {
            throw new Error(`${plugin.payload}/${relative} is missing`);
        }
        const body = fs.readFileSync(file);
        if (body.subarray(0, 40).toString('utf8').startsWith('version https://git-lfs.github.com/spec/')) {
            throw new Error(
                `${path.join(plugin.payload, relative)} is a Git LFS pointer, not the plugin. Run \`git lfs pull\` first.`
            );
        }
        const actual = sha256(body);
        if (actual !== expected) {
            throw new Error(`${path.join(plugin.payload, relative)}: sha256 ${actual} does not match the pinned ${expected}`);
        }
    }
}

function stageApp(target) {
    const appTarget = path.join(target, 'app');
    copyRecursive(APP_SOURCE, appTarget);
    fs.copyFileSync(ICON_SOURCE, path.join(appTarget, 'icon.png'));
}

function clear(target, integrityPath) {
    fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(integrityPath, { force: true });
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    const { INTEGRITY_PATH, flashBrowserTarget, inspectFlashBrowser } = require('../lib/flashBrowser');
    const { writeExpected } = require('../lib/integrity');

    // The build's own architecture decides, not the machine: a 32-bit Windows package gets
    // none even when it is built on x64.
    const key = flashBrowserTarget({ platform: args.platform, arch: args.arch });
    const entry = key && args.arch === key.split('-')[1] ? lock.targets[key] : null;
    if (!entry) {
        clear(path.join(VENDOR_ROOT, `${args.platform}-${args.arch}`), INTEGRITY_PATH);
        console.log(
            `[fetch-flash-browser] ${args.platform}-${args.arch}: no FlashBrowser for this build; it offers the standalone Flash Player only.`
        );
        return;
    }

    const target = path.join(VENDOR_ROOT, key);
    const existing = fs.existsSync(target) ? inspectFlashBrowser(target, key) : null;
    if (existing && !existing.missing.length && !args.force) {
        // The game-window app is cheap to refresh, and a stale copy of it is the one part a
        // checkout edits; the runtime and the plugin are left as they are.
        fs.rmSync(path.join(target, 'app'), { recursive: true, force: true });
        stageApp(target);
        console.log(`[fetch-flash-browser] ${key}: already present -> ${target} (--force to fetch again)`);
    } else {
        clear(target, INTEGRITY_PATH);
        fs.mkdirSync(target, { recursive: true });
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'db-flashbrowser-'));
        try {
            const body = await fetchVerified(entry.runtime);
            const archive = path.join(scratch, entry.runtime.file);
            fs.writeFileSync(archive, body);
            unzip(archive, path.join(target, 'runtime'));
            stageApp(target);
            stagePlugin(entry.plugin, target);
        } catch (error) {
            // A half-built folder would pass for a whole one next time.
            fs.rmSync(target, { recursive: true, force: true });
            throw error;
        } finally {
            fs.rmSync(scratch, { recursive: true, force: true });
        }

        const installed = inspectFlashBrowser(target, key);
        if (installed.missing.length) {
            throw new Error(`${target} is incomplete: missing ${installed.missing.join(', ')}`);
        }
        console.log(`[fetch-flash-browser] ${key}: Electron ${lock.electron} + Flash ${lock.flash} -> ${target}`);
    }

    const record = writeExpected(target, { platform: key, version: lock.flash }, INTEGRITY_PATH);
    console.log(`[fetch-flash-browser] fingerprint ${record.digest} -> lib/flashbrowser.integrity.json`);
}

main().catch((error) => {
    console.error(`[fetch-flash-browser] ERROR: ${error.message}`);
    process.exit(1);
});
