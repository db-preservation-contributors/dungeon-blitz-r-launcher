'use strict';

/**
 * `fs` without Electron's .asar handling, for reading the files the launcher ships beside its own
 * code: Flash Player and what is loaded into it.
 *
 * Electron treats any file named *.asar as an archive to look inside, and an installed launcher
 * has embedded asar integrity on (package.json build.electronFuses): it refuses -- by killing the
 * whole process -- any archive it has no integrity record for. Merely fingerprinting a vendored
 * tree that carried an .asar of its own crashed 1.2.2 at start on Windows and macOS:
 *
 *   FATAL: Failed to find file integrity info for <a vendored ...\default_app.asar>
 *
 * Reading those files as the plain files they are keeps any such tree from doing that again.
 *
 * Electron's `original-fs` is the same API with archives treated as the plain files they are.
 * Outside Electron (the test suites, the build tools) there is no such module, and plain `fs`
 * already behaves that way.
 */

let rawFs;
try {
    // eslint-disable-next-line global-require
    rawFs = require('original-fs');
} catch {
    rawFs = require('fs');
}

module.exports = rawFs;
