#!/usr/bin/env node
'use strict';

/**
 * Builds the Wine the Linux launcher plays the AIR engine in, from WineHQ's own source, into
 * vendor/wine/linux/wine, and fingerprints it into lib/wine.integrity.json.
 *
 * HARMAN's Linux AIR runtime is only for commercially licensed developers, so Linux plays the
 * Windows AIR bundle (vendor/air/win32) in Wine instead (src-tauri/src/engine/air.rs). The Wine
 * is built here rather than taken from a third party's binaries: wine.lock.json pins the source
 * tarball by SHA-256 and the configure options.
 *
 * It is a 64-bit-only Wine (--enable-archs=x86_64): the AIR bundle is 64-bit, and this needs no
 * 32-bit libraries on the player's system. What only building programs for Wine needs -- headers,
 * import libraries, winegcc and the like, man pages -- is left out, and the rest is stripped.
 *
 * A finished build is kept in build/wine/install with a stamp of what it was built from, and is
 * reused while wine.lock.json and this script are unchanged (CI caches that folder).
 *
 * Needs a C compiler, the x86_64 MinGW cross compiler, flex, bison, patchelf and Wine's -dev packages
 * (see .github/workflows/rust-launcher.yml).
 *
 * Usage:
 *   node tools/build-wine.js [--jobs N]
 *   node tools/build-wine.js --check <vendor/wine/linux/wine>   # against lib/wine.integrity.json
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LAUNCHER_ROOT = path.resolve(__dirname, '..');
const LOCK_PATH = path.join(LAUNCHER_ROOT, 'wine.lock.json');
const WORK_DIR = path.join(LAUNCHER_ROOT, 'build', 'wine');
const INSTALL_DIR = path.join(WORK_DIR, 'install');
const STAMP_PATH = path.join(WORK_DIR, 'install.stamp.json');
const TARGET = path.join(LAUNCHER_ROOT, 'vendor', 'wine', 'linux', 'wine');
const INTEGRITY_PATH = path.join(LAUNCHER_ROOT, 'lib', 'wine.integrity.json');

// Programs for building Windows programs against Wine, not for running them.
const DEVELOPER_PROGRAMS = ['function_grep.pl', 'widl', 'winebuild', 'winecpp', 'winedump', 'wineg++', 'winegcc', 'winemaker', 'wmc', 'wrc'];

function parseArgs(argv) {
    const args = { check: '', jobs: os.cpus().length };
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === '--check' && argv[index + 1]) {
            args.check = argv[++index];
        } else if (argv[index] === '--jobs' && argv[index + 1]) {
            args.jobs = Number(argv[++index]) || args.jobs;
        }
    }
    return args;
}

function run(command, args, options = {}) {
    console.log(`[build-wine] ${command} ${args.join(' ')}`);
    execFileSync(command, args, { stdio: 'inherit', ...options });
}

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** What a build is made from: the lock and this script. A cached build is reused only while both match. */
function stampOf(lock) {
    const script = fs.readFileSync(__filename);
    return { lock, script: crypto.createHash('sha256').update(script).digest('hex') };
}

function download(lock, archive) {
    if (fs.existsSync(archive) && sha256(archive) === lock.sha256) {
        return;
    }
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    for (let attempt = 1; ; attempt += 1) {
        try {
            run('curl', ['-fsSL', '--retry', '5', '-o', archive, lock.url]);
            break;
        } catch (error) {
            if (attempt >= 3) {
                throw error;
            }
        }
    }
    const actual = sha256(archive);
    if (actual !== lock.sha256) {
        fs.rmSync(archive, { force: true });
        throw new Error(`${lock.url} has SHA-256 ${actual}, not ${lock.sha256} (wine.lock.json)`);
    }
}

/** Every regular file under `directory`. */
function files(directory) {
    const found = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            found.push(...files(full));
        } else if (entry.isFile()) {
            found.push(full);
        }
    }
    return found;
}

function prune(root) {
    fs.rmSync(path.join(root, 'include'), { recursive: true, force: true });
    fs.rmSync(path.join(root, 'share', 'man'), { recursive: true, force: true });
    fs.rmSync(path.join(root, 'share', 'applications'), { recursive: true, force: true });
    for (const name of DEVELOPER_PROGRAMS) {
        fs.rmSync(path.join(root, 'bin', name), { force: true });
    }
    for (const file of files(root)) {
        if (file.endsWith('.a')) {
            fs.rmSync(file);
        }
    }
    // Wine is built with -g; the debug information is most of its size.
    const unix = files(path.join(root, 'lib', 'wine', 'x86_64-unix')).filter((f) => f.endsWith('.so'));
    const programs = ['wine', 'wine-preloader', 'wineserver'].map((n) => path.join(root, 'bin', n)).filter((f) => fs.existsSync(f));
    run('strip', ['--strip-unneeded', ...unix, ...programs]);
    // Wine's Unix libraries need ntdll.so and win32u.so, which sit beside them and which Wine
    // loads itself. linuxdeploy, packing the AppImage, resolves every library's needs and fails
    // on a name it cannot find; $ORIGIN lets it (and ldd) find them where they are.
    for (const library of unix) {
        run('patchelf', ['--set-rpath', '$ORIGIN', library]);
    }
    const windows = files(path.join(root, 'lib', 'wine', 'x86_64-windows')).filter((f) => !f.endsWith('.a'));
    run('x86_64-w64-mingw32-strip', ['--strip-debug', ...windows]);
}

function build(lock, jobs) {
    const archive = path.join(WORK_DIR, path.basename(new URL(lock.url).pathname));
    download(lock, archive);
    const source = path.join(WORK_DIR, `wine-${lock.version}`);
    const objects = path.join(WORK_DIR, 'objects');
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(objects, { recursive: true, force: true });
    fs.rmSync(INSTALL_DIR, { recursive: true, force: true });
    run('tar', ['-xf', archive, '-C', WORK_DIR]);
    fs.mkdirSync(objects, { recursive: true });
    run(path.join(source, 'configure'), lock.configure, { cwd: objects });
    run('make', [`-j${jobs}`], { cwd: objects });
    run('make', ['install', `DESTDIR=${INSTALL_DIR}`], { cwd: objects });
    prune(INSTALL_DIR);
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(objects, { recursive: true, force: true });
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const { verifyTree, writeExpected } = require('../lib/integrity');
    if (args.check) {
        const result = verifyTree(args.check, { integrityPath: INTEGRITY_PATH, platform: 'linux', label: 'Wine' });
        if (!result.ok) {
            throw new Error(`${args.check}: ${result.reason}`);
        }
        console.log(`[build-wine] ${args.check} matches its fingerprint`);
        return;
    }
    if (process.platform !== 'linux') {
        throw new Error('Wine is built for the Linux launcher only; run this on Linux');
    }
    const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    const stamp = JSON.stringify(stampOf(lock));
    const cached = fs.existsSync(path.join(INSTALL_DIR, 'bin', 'wine')) && fs.existsSync(STAMP_PATH) && fs.readFileSync(STAMP_PATH, 'utf8') === stamp;
    if (cached) {
        console.log(`[build-wine] reusing the Wine ${lock.version} built in ${path.relative(LAUNCHER_ROOT, INSTALL_DIR)}`);
    } else {
        fs.rmSync(STAMP_PATH, { force: true });
        build(lock, args.jobs);
        fs.writeFileSync(STAMP_PATH, stamp);
    }

    fs.rmSync(path.dirname(TARGET), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(TARGET), { recursive: true });
    run('cp', ['-a', INSTALL_DIR, TARGET]);
    const record = writeExpected(TARGET, { platform: 'linux', version: lock.version }, INTEGRITY_PATH);
    console.log(`[build-wine] ${path.relative(LAUNCHER_ROOT, TARGET)}: Wine ${lock.version}, fingerprint ${record.digest} -> lib/wine.integrity.json`);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`[build-wine] ERROR: ${error.message}`);
        process.exit(1);
    }
}

module.exports = { prune, stampOf };
