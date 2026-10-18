#!/usr/bin/env node
'use strict';

/**
 * Checks that `build.files` in package.json still covers every file the launcher reads at
 * runtime.
 *
 * This is the failure that leaves no trace: a root config file that is not matched is not
 * packed, so the packaged app starts without it and the feature it configures simply does
 * nothing — rich presence with no application id, for instance. It works in a checkout and
 * not in the installed build, which is the hardest kind of report to act on.
 *
 * Usage: node tools/test-package-files.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { REQUIRED_ROOT_FILES, findUnpackagedFiles, isCovered, matchesPattern } = require('../lib/packageFiles');

function main() {
    // Glob behaviour, so the check itself can be trusted.
    assert.strictEqual(matchesPattern('presence.config.json', '*.config.json'), true);
    assert.strictEqual(matchesPattern('lib/presence.js', 'lib/**/*'), true);
    assert.strictEqual(matchesPattern('lib/nested/deep.js', 'lib/**/*'), true);
    assert.strictEqual(matchesPattern('renderer/assets/logo.svg', 'renderer/**/*'), true);
    assert.strictEqual(matchesPattern('servers.json', 'lib/**/*'), false);
    assert.strictEqual(matchesPattern('README.md', 'servers.json'), false);
    assert.strictEqual(isCovered('preload.js', ['main.js', 'preload.js']), true);

    // The shipping configuration: every runtime file must be matched by it.
    const buildConfig = require(path.join(__dirname, '..', 'package.json')).build || {};
    const { missingFiles, missingDirectories } = findUnpackagedFiles(buildConfig.files);
    assert.deepStrictEqual(
        { missingFiles, missingDirectories },
        { missingFiles: [], missingDirectories: [] },
        `package.json build.files must ship ${REQUIRED_ROOT_FILES.join(', ')} and lib/ + renderer/`
    );

    // Each Windows target names exactly one architecture, and the 32-bit installers come
    // from a separate electron-builder run rather than from this config.
    //
    // electron-builder emits a universal installer whenever a single run packages more
    // than one architecture -- `NsisTarget.finishBuild()` always adds the combined build,
    // and per-architecture ones only on top of it. Splitting the target entries does not
    // stop that; it is the number of architectures in one *invocation* that matters.
    //
    // So build.win configures x64 only, and the workflow runs `--win --ia32` separately.
    // Both arches in this file would put them back in one run, which is what 1.0.12 did:
    // a ~135 MB universal installer that latest.yml pointed at, so every x64 player
    // updating from 1.0.11 downloaded roughly twice what they needed.
    const winTargets = buildConfig.win.target;

    for (const entry of winTargets) {
        assert.strictEqual(
            Array.isArray(entry.arch) && entry.arch.length,
            1,
            `every build.win target must name exactly one architecture, got ${JSON.stringify(entry.arch)}`
        );
        assert.strictEqual(
            entry.arch[0],
            'x64',
            `build.win must configure x64 only; ia32 is a separate run. Found ${entry.arch[0]}`
        );
    }

    // Both installer types still have to be produced for x64.
    assert.deepStrictEqual(
        winTargets.map((entry) => entry.target).sort(),
        ['nsis', 'portable'],
        'build.win must produce an nsis and a portable installer'
    );

    // The setup installer must refuse Windows 7/8/8.1 before it touches the old install.
    // 1.1.0 launchers there still auto-update, and electron-updater runs this installer on
    // quit with /S: without the guard they replace a working launcher with one Electron
    // cannot start. Nothing else notices if the guard goes: an installer without it builds
    // and installs fine on every machine CI or a developer has.
    const nsisInclude = buildConfig.nsis && buildConfig.nsis.include;
    assert.ok(nsisInclude, 'package.json build.nsis.include must name the installer script (build/installer.nsh)');
    const nsisIncludePath = path.join(__dirname, '..', nsisInclude);
    assert.ok(fs.existsSync(nsisIncludePath), `build.nsis.include points at ${nsisInclude}, which does not exist`);

    // Only the customInit macro runs early enough: it is inserted into .onInit, before the
    // install section that calls uninstallOldVersion.
    const nsisScript = fs.readFileSync(nsisIncludePath, 'utf8').replace(/^\s*;.*$/gm, '');
    const customInit = nsisScript.match(/!macro\s+customInit\b([\s\S]*?)!macroend/);
    assert.ok(customInit, `${nsisInclude} must define the customInit macro`);
    assert.match(customInit[1], /\$\{IfNot\}\s+\$\{AtLeastWin10\}/, 'customInit must check ${AtLeastWin10}');
    assert.match(customInit[1], /\bQuit\b/, 'customInit must Quit on Windows older than 10');
    // /SD keeps a silent run (/S, the install-on-quit path) from blocking on a dialog
    // nobody sees.
    assert.match(customInit[1], /MessageBox[^\n]*\/SD\s+IDOK/, 'the MessageBox must carry /SD IDOK for silent runs');

    // And the ia32 run has to exist in the workflow, or 32-bit silently stops shipping.
    const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');

    // Every Windows run must pin its architecture with the per-target `name:arch` suffix.
    // A bare `--win --ia32` does NOT override `build.win`: the flag says which arches are
    // *requested*, the config still says x64, and the run packages both -- which is what
    // 1.0.14 shipped, universal installer included.
    const allWindowsRuns = [...workflow.matchAll(/builder_args:\s*--win\s+([^\n]*)/g)].map((match) => match[1].trim());
    assert.strictEqual(
        allWindowsRuns.length,
        4,
        'release.yml must have exactly four Windows runs: x64 and ia32, for the main build and the Windows 7 build'
    );
    // The Windows 7 build (Electron 22, build/win7.config.js) is the same pair of runs again.
    const WIN7_CONFIG = '--config build/win7.config.js';
    const win7Runs = allWindowsRuns.filter((args) => args.includes(WIN7_CONFIG));
    const windowsRuns = allWindowsRuns.filter((args) => !args.includes(WIN7_CONFIG));
    assert.strictEqual(win7Runs.length, 2, 'release.yml must build the Windows 7 build for x64 and ia32');
    assert.deepStrictEqual(
        win7Runs.map((args) => args.match(/nsis:(\w+)/)[1]).sort(),
        ['ia32', 'x64'],
        'the two Windows 7 runs must cover both architectures, one each'
    );
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'build', 'win7.config.js')), 'build/win7.config.js is missing');
    for (const args of win7Runs) {
        const named = [...args.replace(WIN7_CONFIG, '').matchAll(/\b(?:nsis|portable):(\w+)/g)].map((match) => match[1]);
        assert.strictEqual(named.length, 2, `a Windows 7 run must name both targets explicitly, got "${args}"`);
        assert.strictEqual(new Set(named).size, 1, `one run must build exactly one architecture, got "${args}"`);
    }

    for (const args of windowsRuns) {
        // Exactly one architecture, applied to both targets: mixing them would rebuild the
        // universal installer, and naming neither falls back to build.win.
        const named = [...args.matchAll(/\b(?:nsis|portable):(\w+)/g)].map((match) => match[1]);
        assert.strictEqual(named.length, 2, `a Windows run must name both targets explicitly, got "${args}"`);
        assert.strictEqual(
            new Set(named).size,
            1,
            `one run must build exactly one architecture, got "${args}"`
        );
        assert.ok(
            ['x64', 'ia32'].includes(named[0]),
            `unknown architecture in "${args}"`
        );
        assert.ok(
            !/--ia32\b|--x64\b/.test(args),
            `use the nsis:<arch> suffix, not --ia32/--x64: the flag does not override build.win. Got "${args}"`
        );
    }

    // And the two runs must be the two different architectures.
    assert.deepStrictEqual(
        windowsRuns.map((args) => args.match(/nsis:(\w+)/)[1]).sort(),
        ['ia32', 'x64'],
        'the two Windows runs must cover both architectures, one each'
    );

    // Both Windows jobs upload artifacts, and actions/upload-artifact rejects a duplicate
    // name within one workflow run -- so the two Windows entries must not share one.
    const artifactNames = [...workflow.matchAll(/name:\s*launcher-\$\{\{\s*matrix\.platform\s*\}\}([^\n]*)/g)]
        .map((match) => (match[1] || '').trim());
    for (const name of artifactNames) {
        assert.ok(
            name.includes('matrix.arch') && name.includes('matrix.flavor'),
            `the Windows artifact name must include matrix.arch and matrix.flavor, or the Windows jobs collide: "${name}"`
        );
    }

    console.log('[test-package-files] every runtime file is covered by build.files');
    console.log('[test-package-files] Windows arches are built one per run, so no universal installer is built');
    console.log('[test-package-files] the Windows 7 build is built for x64 and ia32 as well');
    console.log('[test-package-files] the setup installer refuses Windows older than 10 before uninstalling anything');
    console.log('[test-package-files] all assertions passed');
}

main();
