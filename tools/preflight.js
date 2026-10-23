#!/usr/bin/env node
'use strict';

/**
 * Checks that a build's target platform has the standalone Flash Player
 * (flashplayer_32_sa) in vendor/projector/ before electron-builder runs.
 *
 * The projector is the game engine. A package without it runs, but can only play if the
 * player happens to have a Flash Player of their own, and almost nobody does: the packaged
 * launcher refuses to start instead. 1.0.3's macOS build shipped Flash-less exactly this
 * way, so a missing projector fails the build; a deliberate Flash-less package has to say
 * so with DUNGEON_BLITZ_PREFLIGHT_ALLOW_NO_FLASH=1.
 *
 * Usage: node tools/preflight.js [--platform win32|darwin|linux] [--arch x64|ia32]
 */

const fs = require('fs');
const path = require('path');

const { macBundleExecutable, parseBinaryArchitectures } = require('../lib/binary');
const { canExecute, projectorInDirectory } = require('../lib/projector');
const { verifyProjector } = require('../lib/integrity');
const { findUnpackagedFiles } = require('../lib/packageFiles');

const LAUNCHER_ROOT = path.resolve(__dirname, '..');
const PROJECTOR_ROOT = path.join(LAUNCHER_ROOT, 'vendor', 'projector');

const EXPECTED_PROJECTOR = {
    win32: 'flashplayer_32_sa.exe',
    darwin: 'Flash Player.app',
    linux: 'flashplayer'
};

function parsePlatform(argv) {
    const index = argv.indexOf('--platform');
    if (index >= 0 && argv[index + 1]) {
        return String(argv[index + 1]);
    }
    return process.platform;
}

/**
 * The architecture this invocation is building, if the caller named one.
 *
 * The two Windows architectures are built by two separate electron-builder runs, because
 * one run packaging both also emits a universal installer that doubles the download for
 * every updating player (see README "Releases"). The config therefore only lists x64, so
 * the arch has to come from the command line for this to check the ia32 run honestly.
 *
 * @param {string[]} argv
 * @returns {string} '' when no `--arch` was passed.
 */
function parseArch(argv) {
    const index = argv.indexOf('--arch');
    if (index >= 0 && argv[index + 1]) {
        return String(argv[index + 1]);
    }
    return '';
}

/**
 * The architectures package.json builds for a platform, flattened across its targets.
 *
 * @param {string} platform
 * @returns {string[]} e.g. ['x64'] for win32. Only what the config itself names: the ia32
 *   Windows packages come from a second electron-builder run, not from this list.
 */
function configuredArchitectures(platform) {
    const buildConfig = require(path.join(LAUNCHER_ROOT, 'package.json')).build || {};
    const config = buildConfig[platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux'];
    if (!config) {
        return [];
    }

    const targets = Array.isArray(config.target) ? config.target : [config.target];
    const architectures = new Set();

    for (const target of targets) {
        // A target is either a string ("nsis") or an object with its own arch list.
        const list = target && typeof target === 'object' ? target.arch : undefined;
        for (const arch of list || []) {
            architectures.add(arch);
        }
    }

    return Array.from(architectures);
}

/**
 * A file the launcher reads at runtime that `build.files` does not match is absent from
 * the packaged app, and the feature it configures fails in a way that looks like a bug in
 * that feature rather than a packaging mistake. That is a broken release, so this stops
 * the build instead of warning about it.
 */
function checkPackagedFiles() {
    const buildConfig = require(path.join(LAUNCHER_ROOT, 'package.json')).build || {};
    const { missingFiles, missingDirectories } = findUnpackagedFiles(buildConfig.files);
    const missing = [...missingFiles, ...missingDirectories.map((directory) => `${directory}/`)];

    if (missing.length === 0) {
        console.log('[preflight] build.files covers every runtime file');
        return true;
    }

    console.error('');
    console.error(`[preflight] ERROR: build.files does not package: ${missing.join(', ')}`);
    console.error('[preflight] Without them the package runs but its features fail silently. Fix the list in');
    console.error('[preflight] package.json -> build.files.');
    console.error('');
    return false;
}

function checkProjector(platform, arch) {
    const directory = path.join(PROJECTOR_ROOT, platform);
    const found = projectorInDirectory(directory, platform);

    if (found) {
        const executable = platform === 'darwin' ? macBundleExecutable(found) : found;
        const architectures = executable ? parseBinaryArchitectures(executable) : [];
        const targets = arch ? [arch] : configuredArchitectures(platform);
        const unable = targets.filter((target) => !canExecute(architectures, { platform, arch: target }));
        if (unable.length) {
            console.error('');
            console.error(
                `[preflight] ERROR: ${path.basename(found)} is ${architectures.join('/')} and cannot run on ${unable.join('/')}.`
            );
            console.error('');
            return false;
        }
        // The fingerprint an installed launcher checks before every game. A package whose
        // fingerprint does not match its own Flash Player would refuse every player.
        const fingerprint = verifyProjector(found, { platform });
        if (!fingerprint.ok) {
            console.error('');
            console.error(`[preflight] ERROR: Flash Player fingerprint: ${fingerprint.reason}.`);
            console.error(`[preflight] Run \`node tools/fetch-projector.js --platform ${platform}\` again, then rebuild.`);
            console.error('');
            return false;
        }
        console.log(
            `[preflight] ${platform}: Flash Player ready -> ${path.basename(found)}` +
                (architectures.length ? ` (${architectures.join('/')})` : '')
        );
        return true;
    }

    if (process.env.DUNGEON_BLITZ_PREFLIGHT_ALLOW_NO_FLASH === '1') {
        console.warn(`[preflight] ${platform}: no Flash Player in vendor/ -- building anyway, DUNGEON_BLITZ_PREFLIGHT_ALLOW_NO_FLASH=1.`);
        return true;
    }

    console.error('');
    console.error(`[preflight] ERROR: no standalone Flash Player for ${platform} in vendor/.`);
    console.error(`[preflight] Expected: ${directory}${path.sep}${EXPECTED_PROJECTOR[platform]}`);
    console.error('[preflight] A package without it cannot play: the packaged launcher refuses to start.');
    console.error(`[preflight] Run \`node tools/fetch-projector.js --platform ${platform}\`, then rebuild.`);
    console.error('[preflight] A deliberate Flash-less package needs DUNGEON_BLITZ_PREFLIGHT_ALLOW_NO_FLASH=1.');
    console.error('');
    return false;
}

function main() {
    const argv = process.argv.slice(2);
    const platform = parsePlatform(argv);
    const arch = parseArch(argv);
    if (!EXPECTED_PROJECTOR[platform]) {
        console.error(`[preflight] Unknown platform: ${platform}`);
        console.error('[preflight] Expected one of: win32, darwin, linux');
        process.exit(1);
    }

    // Both run either way, so fixing one failure does not hide the other.
    const filesOk = checkPackagedFiles();
    const flashOk = checkProjector(platform, arch);
    if (!filesOk || !flashOk) {
        process.exit(1);
    }
}

main();
