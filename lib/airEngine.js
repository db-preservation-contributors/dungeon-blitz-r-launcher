'use strict';

// Never Electron's asar-aware fs: see lib/rawFs.js.
const fs = require('./rawFs');
const path = require('path');

const { macBundleExecutable } = require('./binary');
const { verifyTree } = require('./integrity');

// The AIR engine: the game in Adobe AIR's runtime (HARMAN's AIR SDK), a captive bundle built from
// air/ by tools/build-air.js into vendor/air/<platform>/:
//
//   vendor/air/win32/DungeonBlitzR/DungeonBlitzR.exe
//   vendor/air/darwin/DungeonBlitzR.app
//   vendor/air/linux/DungeonBlitzR/DungeonBlitzR
//
// It is started like the standalone Flash Player, on the game's SWF URL, and loads the game into
// AIR's application sandbox (air/src/DungeonBlitzAir.as). It is 64-bit, has no 4 GB ceiling and is
// still maintained, which is what it is for. lib/gameHost.js does the page's work, as for Legacy.

const BUNDLE_NAME = 'DungeonBlitzR';

const VENDOR_DIRECTORIES = [];
if (process.resourcesPath) {
    VENDOR_DIRECTORIES.push(path.join(process.resourcesPath, 'vendor', 'air', process.platform));
}
VENDOR_DIRECTORIES.push(path.join(__dirname, '..', 'vendor', 'air', process.platform));

const INTEGRITY_PATH = path.join(__dirname, 'air.integrity.json');

function exists(candidate) {
    try {
        fs.statSync(candidate);
        return true;
    } catch {
        return false;
    }
}

/** The bundle (the folder, or the .app on macOS) and the program inside it, if `directory` has one. */
function airAppInDirectory(directory, platform = process.platform) {
    if (platform === 'darwin') {
        const bundle = path.join(directory, `${BUNDLE_NAME}.app`);
        const executable = exists(bundle) ? macBundleExecutable(bundle) : '';
        return executable && exists(executable) ? { path: bundle, executable } : null;
    }
    const bundle = path.join(directory, BUNDLE_NAME);
    const executable = path.join(bundle, platform === 'win32' ? `${BUNDLE_NAME}.exe` : BUNDLE_NAME);
    return exists(executable) ? { path: bundle, executable } : null;
}

/** The AIR bundle this build ships with, or null. */
function findAirApp({ directories = VENDOR_DIRECTORIES, platform = process.platform } = {}) {
    for (const directory of directories) {
        const found = airAppInDirectory(directory, platform);
        if (found) {
            return found;
        }
    }
    return null;
}

/** Whether a bundle is the one this build shipped (lib/air.integrity.json, written by tools/build-air.js). */
function verifyAirApp(bundlePath, { integrityPath = INTEGRITY_PATH, platform = process.platform } = {}) {
    return verifyTree(bundlePath, { integrityPath, platform, label: 'AIR engine' });
}

/**
 * How to start the AIR engine on the game, ready to spawn.
 *
 * @param {{ executable: string }} airApp
 * @param {string} swfUrl
 * @param {{ quality?: string }} [options] '' keeps the game's own, or LOW, MEDIUM, HIGH, BEST.
 * @returns {{ command: string, args: string[] }}
 */
function prepareAirLaunch(airApp, swfUrl, { quality = '' } = {}) {
    const args = [String(swfUrl)];
    if (quality) {
        args.push(`--quality=${quality}`);
    }
    return { command: airApp.executable, args };
}

module.exports = { BUNDLE_NAME, INTEGRITY_PATH, VENDOR_DIRECTORIES, airAppInDirectory, findAirApp, prepareAirLaunch, verifyAirApp };
