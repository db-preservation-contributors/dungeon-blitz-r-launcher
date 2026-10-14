#!/usr/bin/env node
'use strict';

/**
 * The libraries loaded into the Linux Flash Player (native_flash/): how the launcher finds
 * them, how it puts them in Flash Player's environment, the tamper check on them, and -- on
 * a Linux machine with a C compiler, and GLib's development files for the short tick -- that
 * they build and do what they say.
 *
 * Usage: node tools/test-flash-preload.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const projector = require('../lib/projector');
const integrity = require('../lib/integrity');

function testEnvironment() {
    const preload = { directory: '/opt/Dungeon Blitz R/resources/vendor/flashpreload/linux', libraries: ['flash_rlimit_cache.so'] };

    const env = projector.linuxFlashEnv({ HOME: '/home/p' }, preload);
    assert.strictEqual(env.LD_PRELOAD, 'flash_rlimit_cache.so', 'by bare name: LD_PRELOAD splits on the spaces in the .deb path');
    assert.strictEqual(env.LD_LIBRARY_PATH, preload.directory, 'its folder is where ld.so finds the bare name');
    assert.strictEqual(env.VDPAU_DRIVER, projector.NO_VDPAU_DRIVER, 'VDPAU stays off');
    assert.strictEqual(env.HOME, '/home/p', 'the rest of the environment is kept');

    const stacked = projector.linuxFlashEnv({ LD_PRELOAD: 'libMangoHud.so', LD_LIBRARY_PATH: '/tmp/.mount_x/usr/lib' }, preload);
    assert.strictEqual(stacked.LD_PRELOAD, 'libMangoHud.so flash_rlimit_cache.so', 'what the player preloads stays, first');
    assert.strictEqual(stacked.LD_LIBRARY_PATH, `${preload.directory}:/tmp/.mount_x/usr/lib`, 'ahead of the AppImage\'s own path');

    const vdpau = projector.linuxFlashEnv({ DUNGEON_BLITZ_FLASH_VDPAU: '1' }, preload);
    assert.strictEqual(vdpau.LD_PRELOAD, 'flash_rlimit_cache.so', 'keeping VDPAU does not drop the preload');

    const off = projector.linuxFlashEnv({ DUNGEON_BLITZ_FLASH_PRELOAD: '0', LD_PRELOAD: 'libMangoHud.so' }, preload);
    assert.strictEqual(off.LD_PRELOAD, 'libMangoHud.so', 'DUNGEON_BLITZ_FLASH_PRELOAD=0 leaves it out');
    assert.strictEqual(off.LD_LIBRARY_PATH, undefined);

    const colon = projector.linuxFlashEnv({}, { directory: '/home/a:b/vendor/flashpreload/linux', libraries: ['flash_rlimit_cache.so'] });
    assert.strictEqual(colon.LD_PRELOAD, undefined, 'a folder LD_LIBRARY_PATH cannot name is left out');

    const both = projector.linuxFlashEnv({}, { directory: preload.directory, libraries: ['flash_rlimit_cache.so', 'flash_short_tick.so'] });
    assert.strictEqual(both.LD_PRELOAD, 'flash_rlimit_cache.so flash_short_tick.so', 'every library in the folder');

    assert.strictEqual(projector.linuxFlashEnv({}, null).LD_PRELOAD, undefined, 'a build without one changes nothing');

    const launch = projector.prepareLaunch({ path: '/x/flashplayer' }, 'http://a.example/g.swf', { platform: 'linux', env: {}, preload });
    assert.strictEqual(launch.env.LD_PRELOAD, 'flash_rlimit_cache.so', 'prepareLaunch passes it on');
    const windows = projector.prepareLaunch({ path: '/x/flashplayer' }, 'http://a.example/g.swf', { platform: 'win32', env: {}, preload });
    assert.strictEqual(windows.env, undefined, 'only Linux gets it');
    console.log('[test-flash-preload] Flash Player is started with the preload, by name, after the player\'s own: OK');
}

function testFindAndVerify() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'db-flashpreload-'));
    try {
        const empty = path.join(root, 'empty', 'linux');
        const full = path.join(root, 'full', 'linux');
        fs.mkdirSync(empty, { recursive: true });
        fs.mkdirSync(full, { recursive: true });
        fs.writeFileSync(path.join(full, 'b.so'), 'b');
        fs.writeFileSync(path.join(full, 'a.so'), 'a');
        fs.writeFileSync(path.join(full, 'notes.txt'), 'not a library');

        assert.strictEqual(projector.findFlashPreload([path.join(root, 'missing'), empty]), null, 'no libraries, no preload');
        assert.deepStrictEqual(projector.findFlashPreload([empty, full]), { directory: full, libraries: ['a.so', 'b.so'] });

        const record = path.join(root, 'flashpreload.integrity.json');
        integrity.writeExpected(full, { platform: 'linux', version: '0.0.0' }, record);
        assert.deepStrictEqual(projector.verifyFlashPreload(full, { integrityPath: record }), { ok: true, reason: '' });

        fs.writeFileSync(path.join(full, 'a.so'), 'patched');
        assert.strictEqual(projector.verifyFlashPreload(full, { integrityPath: record }).ok, false, 'a changed library is refused');
        fs.writeFileSync(path.join(full, 'a.so'), 'a');
        fs.writeFileSync(path.join(full, 'c.so'), 'c');
        assert.strictEqual(projector.verifyFlashPreload(full, { integrityPath: record }).ok, false, 'an added library is refused');
        fs.rmSync(path.join(full, 'c.so'));
        assert.strictEqual(projector.verifyFlashPreload(full, { integrityPath: record }).ok, true, 'and passes again once removed');
        assert.strictEqual(
            projector.verifyFlashPreload(full, { integrityPath: path.join(root, 'none.json') }).ok,
            false,
            'a build that recorded nothing is refused too'
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
    console.log('[test-flash-preload] the preload folder is found, and a changed or added library is refused: OK');
}

function haveTool(command) {
    return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
}

function haveToolchain() {
    return process.platform === 'linux' && haveTool(process.env.CC || 'cc') && haveTool('readelf');
}

/** Builds the libraries in a sources folder holding just `files`, as the build tool would. */
function buildFrom(root, name, files) {
    const { buildLibraries } = require('./build-flash-preload');
    const sources = path.join(root, `${name}-sources`);
    fs.mkdirSync(sources);
    for (const [file, text] of Object.entries(files)) {
        fs.writeFileSync(path.join(sources, file), text);
    }
    return buildLibraries(path.join(root, name), { sources });
}

function testBuild() {
    if (!haveToolchain()) {
        console.log('[test-flash-preload] no Linux C toolchain here; the libraries were not built');
        return;
    }
    const { buildLibraries } = require('./build-flash-preload');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'db flash preload '));
    try {
        // A folder with spaces, like the .deb's.
        const built = buildLibraries(path.join(root, 'linux')).map((library) => path.basename(library));
        assert.deepStrictEqual(built, ['flash_rlimit_cache.so', 'flash_short_tick.so']);

        // A getrlimit that does not answer as the kernel does is refused.
        const liar = 'struct limit { unsigned long soft, hard; };\n' +
            'int getrlimit(int resource, struct limit *limit) { (void)resource; limit->soft = limit->hard = 1234; return 0; }\n';
        assert.throws(() => buildFrom(root, 'liar', { 'liar.c': liar }), /liar\.so/);

        // So is a library a program without it cannot start with.
        const needy = 'extern int db_missing(void);\nint db_needs_missing(void) { return db_missing(); }\n';
        assert.throws(() => buildFrom(root, 'needy', { 'needy.c': needy }), /does not run/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
    console.log('[test-flash-preload] the libraries build, need only an old glibc, and load into any program: OK');
}

/** How often a 10 ms and a 50 ms GLib timer fire in 300 ms, with `env`. */
const TICKS_PROGRAM = `#include <glib.h>
#include <stdio.h>
static int ten, fifty;
static GMainLoop *loop;
static gboolean on_ten(gpointer data) { (void)data; ten++; return TRUE; }
static gboolean on_fifty(gpointer data) { (void)data; fifty++; return TRUE; }
static gboolean on_stop(gpointer data) { (void)data; g_main_loop_quit(loop); return FALSE; }
int main(void) {
    loop = g_main_loop_new(NULL, FALSE);
    g_timeout_add(10, on_ten, NULL);
    g_timeout_add(50, on_fifty, NULL);
    g_timeout_add(300, on_stop, NULL);
    g_main_loop_run(loop);
    printf("%d %d\\n", ten, fifty);
    return 0;
}
`;

function testShortTick() {
    const glib = spawnSync('pkg-config', ['--cflags', '--libs', 'glib-2.0'], { encoding: 'utf8' });
    if (!haveToolchain() || glib.status !== 0) {
        console.log('[test-flash-preload] no GLib development files here; the short tick was not run');
        return;
    }
    const { buildLibraries } = require('./build-flash-preload');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'db-short-tick-'));
    try {
        const linux = path.join(root, 'linux');
        buildLibraries(linux);
        const program = path.join(root, 'ticks');
        fs.writeFileSync(`${program}.c`, TICKS_PROGRAM);
        const compiled = spawnSync(process.env.CC || 'cc', ['-o', program, `${program}.c`, ...glib.stdout.trim().split(/\s+/)], {
            encoding: 'utf8'
        });
        assert.strictEqual(compiled.status, 0, compiled.stderr);

        const count = (env) => {
            const result = spawnSync(program, { encoding: 'utf8', env: { ...process.env, ...env } });
            assert.strictEqual(result.status, 0, result.stderr);
            const [ten, fifty] = result.stdout.trim().split(' ').map(Number);
            return { ten, fifty };
        };
        const plain = count({ LD_PRELOAD: '' });
        const short = count({ LD_LIBRARY_PATH: linux, LD_PRELOAD: 'flash_short_tick.so' });
        // 10 ms ticks become 2 ms ones: about 150 in 300 ms instead of 30. Loose bounds, for a
        // busy CI machine.
        assert.ok(short.ten >= 2 * plain.ten, `the 10 ms timer ticks faster: ${plain.ten} -> ${short.ten}`);
        assert.ok(Math.abs(short.fifty - plain.fifty) <= 1, `a 50 ms timer is left alone: ${plain.fifty} -> ${short.fifty}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
    console.log('[test-flash-preload] 10 ms GLib timers tick every 2 ms, other timers as they were: OK');
}

testEnvironment();
testFindAndVerify();
testBuild();
testShortTick();
console.log('[test-flash-preload] all assertions passed');
