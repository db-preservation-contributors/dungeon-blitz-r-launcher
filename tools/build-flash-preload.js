#!/usr/bin/env node
'use strict';

/**
 * Builds the libraries the launcher loads into the Linux Flash Player -- every
 * native_flash/<name>.c into vendor/flashpreload/linux/<name>.so -- checks them, and
 * fingerprints the folder into lib/flashpreload.integrity.json, which is packed into the app:
 * a packaged launcher refuses to start Flash Player with a preload folder that does not match
 * it (lib/projector.js, verifyFlashPreload).
 *
 * Each library is checked before it is kept:
 *   - it needs nothing newer than glibc MAX_GLIBC, so the package still plays on an older
 *     distribution than the one it was built on;
 *   - a program without GLib starts with it preloaded, even with LD_BIND_NOW: whatever
 *     Flash Player starts inherits LD_PRELOAD;
 *   - one that takes getrlimit over: a shell started with it really calls the library's
 *     getrlimit and setrlimit (ld.so's own binding log says so), and its answers are the
 *     kernel's, before and after the shell lowers its stack limit.
 *
 * Only Linux has anything to build; for another platform the folder is cleared and nothing
 * else happens. Needs a C compiler (`cc`, or $CC) and binutils' `readelf`.
 *
 * Usage:
 *   node tools/build-flash-preload.js [--platform linux]
 *   node tools/build-flash-preload.js --check <folder>   # the check a packaged launcher runs
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const LAUNCHER_ROOT = path.resolve(__dirname, '..');
const SOURCE_ROOT = path.join(LAUNCHER_ROOT, 'native_flash');
const VENDOR_ROOT = path.join(LAUNCHER_ROOT, 'vendor', 'flashpreload');

// CentOS 7's glibc; every distribution that still runs GTK 2 Flash Player has at least this.
const MAX_GLIBC = [2, 17];

const CFLAGS = ['-O2', '-shared', '-fPIC', '-Wall', '-Wextra'];

function parseArgs(argv) {
    const args = { platform: process.platform, check: '' };
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === '--platform' && argv[index + 1]) {
            args.platform = String(argv[index + 1]);
            index += 1;
        } else if (argv[index] === '--check' && argv[index + 1]) {
            args.check = String(argv[index + 1]);
            index += 1;
        }
    }
    return args;
}

/** The glibc versions a library asks for, as [major, minor] pairs. */
function glibcVersions(library) {
    const symbols = execFileSync('readelf', ['--dyn-syms', '--wide', library], { encoding: 'utf8' });
    const versions = [];
    for (const match of symbols.matchAll(/@GLIBC_(\d+)\.(\d+)/g)) {
        versions.push([Number(match[1]), Number(match[2])]);
    }
    return versions;
}

function newerThan([major, minor], [maxMajor, maxMinor]) {
    return major > maxMajor || (major === maxMajor && minor > maxMinor);
}

/** The functions a library defines, which are the ones it takes over in Flash Player. */
function definedFunctions(library) {
    const symbols = execFileSync('readelf', ['--dyn-syms', '--wide', library], { encoding: 'utf8' });
    const names = new Set();
    for (const line of symbols.split('\n')) {
        const fields = line.trim().split(/\s+/);
        // Num: Value Size Type Bind Vis Ndx Name
        if (fields.length >= 8 && fields[3] === 'FUNC' && fields[4] === 'GLOBAL' && fields[6] !== 'UND') {
            names.add(fields[7].split('@')[0]);
        }
    }
    return names;
}

/** A shell started with `library` preloaded the way lib/projector.js does it, with `env` added. */
function preloadedShell(library, script, env = {}) {
    return spawnSync('sh', ['-c', script], {
        encoding: 'utf8',
        env: {
            ...process.env,
            // The bare name, its folder in LD_LIBRARY_PATH.
            LD_LIBRARY_PATH: path.dirname(library),
            LD_PRELOAD: path.basename(library),
            ...env
        }
    });
}

/**
 * Whatever Flash Player starts inherits LD_PRELOAD, so the library has to load into any
 * program, GLib or not, even one that resolves every symbol up front.
 */
function checkLoadsAnywhere(library) {
    const name = path.basename(library);
    const result = preloadedShell(library, 'echo started', { LD_BIND_NOW: '1' });
    assert.ok(
        result.status === 0 && result.stdout.trim() === 'started' && !/ld\.so|symbol lookup error/.test(result.stderr),
        `a program started with ${name} does not run: ${result.stderr.trim()}`
    );
}

/**
 * For a library that takes getrlimit over: a shell started with it gets its getrlimit and
 * setrlimit from it, and still sees the kernel's limits, before and after it lowers one.
 * `ulimit` is the shell's own getrlimit and setrlimit.
 */
function checkRlimit(library) {
    const name = path.basename(library);
    const script = 'ulimit -s; ulimit -s 1024; ulimit -s; ulimit -n';
    const plain = spawnSync('sh', ['-c', script], { encoding: 'utf8', env: { ...process.env, LD_PRELOAD: '' } });
    const preloaded = preloadedShell(library, script, { LD_DEBUG: 'bindings' });
    for (const symbol of ['getrlimit', 'setrlimit']) {
        assert.ok(
            new RegExp(`to [^\\n]*/${name.replace(/\./g, '\\.')} \\[\\d+\\]: normal symbol \`${symbol}'`).test(preloaded.stderr),
            `the shell's ${symbol} does not come from ${name}`
        );
    }
    assert.deepStrictEqual(preloaded.stdout, plain.stdout, `with ${name}, the shell sees other limits than the kernel's`);
}

/**
 * Checks one built library: its glibc needs, that it loads anywhere, and what it takes over.
 */
function checkLibrary(library) {
    const name = path.basename(library);
    const tooNew = glibcVersions(library).filter((version) => newerThan(version, MAX_GLIBC));
    assert.deepStrictEqual(tooNew, [], `${name} needs glibc ${tooNew.map((v) => v.join('.')).join(', ')}, newer than ${MAX_GLIBC.join('.')}`);
    checkLoadsAnywhere(library);
    if (definedFunctions(library).has('getrlimit')) {
        checkRlimit(library);
    }
}

/** Compiles every native_flash/*.c into `target`, checking each library. */
function buildLibraries(target, { cc = process.env.CC || 'cc', sources = SOURCE_ROOT } = {}) {
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    const built = [];
    for (const source of fs.readdirSync(sources).filter((entry) => entry.endsWith('.c')).sort()) {
        const library = path.join(target, `${path.basename(source, '.c')}.so`);
        execFileSync(cc, [...CFLAGS, '-o', library, path.join(sources, source)], { stdio: 'inherit' });
        checkLibrary(library);
        built.push(library);
    }
    return built;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const { verifyFlashPreload, PRELOAD_INTEGRITY_PATH } = require('../lib/projector');

    if (args.check) {
        const result = verifyFlashPreload(args.check);
        if (!result.ok) {
            console.error(`[build-flash-preload] FAILED: ${args.check}: ${result.reason}`);
            process.exit(1);
        }
        console.log(`[build-flash-preload] ${args.check} matches its fingerprint`);
        return;
    }

    const target = path.join(VENDOR_ROOT, args.platform);
    if (args.platform !== 'linux') {
        fs.rmSync(target, { recursive: true, force: true });
        console.log(`[build-flash-preload] ${args.platform}: nothing to build`);
        return;
    }

    for (const library of buildLibraries(target)) {
        console.log(`[build-flash-preload] ${path.relative(LAUNCHER_ROOT, library)}: OK`);
    }
    const { writeExpected } = require('../lib/integrity');
    const { version } = require('../package.json');
    const record = writeExpected(target, { platform: 'linux', version }, PRELOAD_INTEGRITY_PATH);
    console.log(`[build-flash-preload] fingerprint ${record.digest} -> lib/flashpreload.integrity.json`);
}

module.exports = { buildLibraries, checkLibrary, definedFunctions, glibcVersions, MAX_GLIBC };

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`[build-flash-preload] ERROR: ${error.message}`);
        process.exit(1);
    }
}
