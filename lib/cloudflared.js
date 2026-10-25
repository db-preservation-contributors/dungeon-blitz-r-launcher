'use strict';

/**
 * cloudflared, for developer mode's Create (lib/devServer.js): the program that opens a
 * Cloudflare quick tunnel (https://<words>.trycloudflare.com) to a port on this machine.
 *
 * It is not packaged with the launcher. The first Create downloads the pinned release below from
 * Cloudflare's GitHub releases into the launcher's data folder and checks it against the digest
 * GitHub publishes for that asset; a file that does not match is deleted and never run.
 */

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const CLOUDFLARED_VERSION = '2026.10.3';

// sha256 of each release asset, as GitHub lists it for cloudflare/cloudflared 2026.10.3.
const ASSETS = {
    'win32-x64': {
        name: 'cloudflared-windows-amd64.exe',
        sha256: '76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2'
    },
    'darwin-x64': {
        name: 'cloudflared-darwin-amd64.tgz',
        sha256: '81b7b85f2376815c4f59b1aa323887b62e16ce8b67555c2e1577dc23f2a82000',
        archive: true
    },
    'darwin-arm64': {
        name: 'cloudflared-darwin-arm64.tgz',
        sha256: '1165d14b6f6360a3b8c283d7d1100024d6ec7cd9bc9e32519e96150645f3ec55',
        archive: true
    },
    'linux-x64': {
        name: 'cloudflared-linux-amd64',
        sha256: '053b80b0a23031a038fdbf3c073f59f82b8f1f152aa67971d7383ffafc0dbab0'
    },
    'linux-arm64': {
        name: 'cloudflared-linux-arm64',
        sha256: '89297ebfb9e8c99c0dc013a1140601453cf3798d8306c5591651f4a3f5210be8'
    }
};

/** The release asset for this machine, or null where Cloudflare builds none. */
function assetFor(platform = process.platform, arch = process.arch) {
    return ASSETS[`${platform}-${arch}`] || null;
}

function sha256File(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** GETs `url` into `file`, following GitHub's redirect to its download host. */
function download(url, file, redirects = 5) {
    return new Promise((resolve, reject) => {
        https
            .get(url, { headers: { 'User-Agent': 'dungeon-blitz-r-launcher' } }, (response) => {
                if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && redirects > 0) {
                    response.resume();
                    resolve(download(new URL(response.headers.location, url).toString(), file, redirects - 1));
                    return;
                }
                if (response.statusCode !== 200) {
                    response.resume();
                    reject(new Error(`cloudflared download answered ${response.statusCode}`));
                    return;
                }
                const out = fs.createWriteStream(file);
                response.pipe(out);
                out.on('finish', () => out.close(() => resolve()));
                out.on('error', reject);
            })
            .on('error', reject);
    });
}

/**
 * The cloudflared binary in `directory`, downloaded and checked the first time.
 *
 * @returns {Promise<string>} its path
 */
async function ensureCloudflared(directory, { platform = process.platform, arch = process.arch, log = () => {} } = {}) {
    const asset = assetFor(platform, arch);
    if (!asset) {
        throw new Error(`Cloudflare publishes no cloudflared for ${platform}-${arch}.`);
    }
    const home = path.join(directory, `cloudflared-${CLOUDFLARED_VERSION}`);
    const binary = path.join(home, platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
    const marker = path.join(home, 'verified.json');
    if (fs.existsSync(binary) && fs.existsSync(marker)) {
        return binary;
    }

    fs.mkdirSync(home, { recursive: true });
    const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset.name}`;
    const downloaded = path.join(home, `${asset.name}.part`);
    log(`[DevServer] Downloading cloudflared ${CLOUDFLARED_VERSION} (${asset.name})...`);
    await download(url, downloaded);
    const digest = sha256File(downloaded);
    if (digest !== asset.sha256) {
        fs.rmSync(downloaded, { force: true });
        throw new Error(`The cloudflared download does not match its published checksum (${digest}); it was deleted.`);
    }
    if (asset.archive) {
        execFileSync('tar', ['-xzf', downloaded, '-C', home]);
        fs.rmSync(downloaded, { force: true });
    } else {
        fs.renameSync(downloaded, binary);
    }
    if (!fs.existsSync(binary)) {
        throw new Error('The cloudflared download held no cloudflared program.');
    }
    if (platform !== 'win32') {
        fs.chmodSync(binary, 0o755);
    }
    fs.writeFileSync(marker, JSON.stringify({ version: CLOUDFLARED_VERSION, asset: asset.name, sha256: asset.sha256 }));
    return binary;
}

/**
 * A quick tunnel to 127.0.0.1:`port`, once it has its address AND a registered connection (an
 * address without a connection answers 530).
 *
 * @returns {Promise<{ url: string, child: import('child_process').ChildProcess }>}
 */
function startQuickTunnel(binary, port, { timeoutMs = 90000, log = () => {}, spawnImpl = spawn } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawnImpl(binary, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://localhost:${port}`], {
            windowsHide: true
        });
        let url = '';
        let registered = false;
        let settled = false;
        const finish = (error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            if (error) {
                try {
                    child.kill();
                } catch {
                    // Already gone.
                }
                reject(error);
            } else {
                resolve({ url, child });
            }
        };
        const onData = (chunk) => {
            const text = String(chunk);
            const found = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text);
            if (found && !url) {
                url = found[0];
            }
            if (/Registered tunnel connection/.test(text)) {
                registered = true;
            }
            for (const line of text.split(/\r?\n/)) {
                if (/\bERR\b/.test(line)) {
                    log(`[DevServer] tunnel ${port}: ${line.trim()}`);
                }
            }
            if (url && registered) {
                finish(null);
            }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.once('error', (error) => finish(error));
        child.once('exit', (code) => finish(new Error(`the tunnel for port ${port} stopped (${code})`)));
        const timer = setTimeout(() => finish(new Error(`the tunnel for port ${port} was not connected after ${timeoutMs / 1000} s`)), timeoutMs);
    });
}

module.exports = { ASSETS, CLOUDFLARED_VERSION, assetFor, ensureCloudflared, startQuickTunnel };
