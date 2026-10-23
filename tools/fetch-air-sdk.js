#!/usr/bin/env node
'use strict';

/**
 * Downloads HARMAN's AIR SDK for the platform it runs on into build/air-sdk/<platform>/, for
 * tools/build-air.js. The release workflow runs it on the Windows and macOS runners.
 *
 * HARMAN's site (airsdk.harman.com, which redirects to airsdk.wxlift.com) only serves an SDK to a
 * session that asked for the download settings first, so that request is made and its cookie sent
 * with the download. The archive is checked against the SHA-256 pinned in air-sdk.lock.json.
 *
 * Usage:
 *   node tools/fetch-air-sdk.js [--platform win32|darwin|linux] [--print-hash]
 * Prints the SDK directory as its last line.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { execFileSync } = require('child_process');

const LAUNCHER_ROOT = path.resolve(__dirname, '..');
const LOCK_PATH = path.join(LAUNCHER_ROOT, 'air-sdk.lock.json');
const WORK_ROOT = path.join(LAUNCHER_ROOT, 'build', 'air-sdk');

function parseArgs(argv) {
    const args = { platform: process.platform, printHash: false };
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === '--platform' && argv[index + 1]) {
            args.platform = String(argv[++index]);
        } else if (argv[index] === '--print-hash') {
            args.printHash = true;
        }
    }
    return args;
}

function sessionCookie(response) {
    const cookies = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie') || ''];
    return cookies.map((cookie) => cookie.split(';')[0]).filter(Boolean).join('; ');
}

async function download(lock, entry, destination) {
    const settings = await fetch(`${lock.site}/api/config-settings/download`, { headers: { Accept: 'application/json' } });
    if (!settings.ok) {
        throw new Error(`download settings: HTTP ${settings.status}`);
    }
    const cookie = sessionCookie(settings);
    const { id } = await settings.json();
    const url = `${lock.site}/api/versions/${lock.version}/sdks/${entry.file}?id=${encodeURIComponent(id)}`;
    const response = await fetch(url, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'follow' });
    if (!response.ok || !response.body) {
        throw new Error(`${entry.file}: HTTP ${response.status}`);
    }
    const hash = crypto.createHash('sha256');
    const source = Readable.fromWeb(response.body);
    source.on('data', (chunk) => hash.update(chunk));
    await pipeline(source, fs.createWriteStream(destination));
    return hash.digest('hex');
}

function extract(archive, directory, platform) {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
    if (platform === 'darwin') {
        execFileSync('ditto', ['-x', '-k', archive, directory], { stdio: 'inherit' });
    } else if (platform === 'win32') {
        // Windows' bsdtar, not Git Bash's GNU tar, which reads "D:" as a remote host.
        const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
        execFileSync(tar, ['-xf', archive, '-C', directory], { stdio: 'inherit' });
    } else {
        execFileSync('unzip', ['-q', archive, '-d', directory], { stdio: 'inherit' });
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    const entry = lock[args.platform];
    if (!entry) {
        throw new Error(`no AIR SDK for ${args.platform} in air-sdk.lock.json`);
    }
    fs.mkdirSync(WORK_ROOT, { recursive: true });
    const archive = path.join(WORK_ROOT, entry.file);
    const actual = await download(lock, entry, archive);
    if (args.printHash) {
        console.log(actual);
        return;
    }
    if (actual !== entry.sha256) {
        fs.rmSync(archive, { force: true });
        throw new Error(`${entry.file}: SHA-256 ${actual} does not match ${entry.sha256}`);
    }
    const directory = path.join(WORK_ROOT, args.platform);
    extract(archive, directory, args.platform);
    fs.rmSync(archive, { force: true });
    if (!fs.existsSync(path.join(directory, 'airsdk.xml'))) {
        throw new Error(`${directory} is not an AIR SDK`);
    }
    console.log(`[fetch-air-sdk] AIR SDK ${lock.version} for ${args.platform}`);
    console.log(directory);
}

main().catch((error) => {
    console.error(`[fetch-air-sdk] ${error.message}`);
    process.exit(1);
});
