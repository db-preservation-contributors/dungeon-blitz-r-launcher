'use strict';

// The Windows 7 build: the same launcher, packaged on Electron 22 -- the last Electron that
// runs on Windows 7, 8 and 8.1 -- instead of the Electron in package.json.
//
//   npm run dist:win7          (x64)
//   npm run dist:win7:ia32     (32-bit)
//
// Everything else is package.json's `build`. What differs:
//  - electronVersion: 22. The launcher knows itself by it at runtime
//    (lib/windowsSupport.js, isLegacyWindowsBuild) and takes Windows 7 as its floor.
//  - The file names carry `win7` instead of `win`, so the two builds never share a file on the
//    releases page, and the update notice (lib/updateNotice.js) offers each its own.
//  - The installer refuses only Windows older than 7 (build/installer-win7.nsh).
//  - No embedded asar integrity: Electron only checks it on Windows from version 30, so on 22
//    it would guard nothing.
//
// Electron 22 no longer gets security fixes. That is the price of running on Windows 7, and the
// reason the main builds stay on a current Electron; see "Windows versions" in the README.

const base = require('../package.json').build;

const ELECTRON_VERSION = '22.3.27';

module.exports = {
    ...base,
    electronVersion: ELECTRON_VERSION,
    electronFuses: {
        ...base.electronFuses,
        enableEmbeddedAsarIntegrityValidation: false
    },
    nsis: {
        ...base.nsis,
        include: 'build/installer-win7.nsh',
        artifactName: 'DungeonBlitzR-Launcher-${version}-win7-${arch}-setup.${ext}'
    },
    portable: {
        ...base.portable,
        artifactName: 'DungeonBlitzR-Launcher-${version}-win7-${arch}-portable.${ext}'
    }
};
