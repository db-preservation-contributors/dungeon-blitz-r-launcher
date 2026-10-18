#!/usr/bin/env node
'use strict';

/**
 * Checks that a FlashBrowser folder is complete and matches the fingerprint the build recorded
 * in lib/flashbrowser.integrity.json -- the same check a packaged launcher runs before every
 * game.
 *
 * Run by the release workflow on the copy inside the finished package, so a package whose own
 * check would refuse its main play button can never be published.
 *
 * Usage: node tools/verify-flash-browser.js <vendor/flashbrowser/<target>> --target <win32-x64|darwin-x64>
 *        node tools/verify-flash-browser.js <folder> --list   # one line per file, to diff two copies
 */

const path = require('path');

const { INTEGRITY_PATH, inspectFlashBrowser, verifyFlashBrowser } = require('../lib/flashBrowser');
const { readExpected, treeLines } = require('../lib/integrity');

const args = process.argv.slice(2);
const directory = args.find((arg) => !arg.startsWith('--'));
const targetIndex = args.indexOf('--target');
const target = targetIndex >= 0 ? args[targetIndex + 1] : path.basename(String(directory || ''));

if (directory && args.includes('--list')) {
    process.stdout.write(`${treeLines(directory).join('\n')}\n`);
    process.exit(0);
}

if (!directory || !target) {
    console.error('Usage: node tools/verify-flash-browser.js <folder> --target <win32-x64|darwin-x64>');
    process.exit(1);
}

const inspected = inspectFlashBrowser(directory, target);
if (inspected.missing.length) {
    console.error(`[verify-flash-browser] FAILED: ${directory}: missing ${inspected.missing.join(', ')}`);
    process.exit(1);
}

const result = verifyFlashBrowser(directory, { target });
if (!result.ok) {
    console.error(`[verify-flash-browser] FAILED: ${directory}: ${result.reason}`);
    process.exit(1);
}
console.log(`[verify-flash-browser] ${directory} matches fingerprint ${readExpected(INTEGRITY_PATH).digest}`);
