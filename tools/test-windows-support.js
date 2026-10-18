#!/usr/bin/env node
'use strict';

/**
 * Checks which Windows the launcher supports.
 *
 * Every Windows version is described from its `os.release()` string, so the whole matrix
 * runs on any machine: no Windows, no Electron runtime, no network. That matters more than
 * usual here, because the versions being pinned down (7, 8, Vista) are exactly the ones a
 * CI runner cannot be. The architecture is passed in too, so the result does not depend on
 * the machine the suite runs on.
 *
 * Usage: node tools/test-windows-support.js
 */

const assert = require('assert');

const {
    LEGACY_ELECTRON_MAJOR,
    MINIMUM_WINDOWS,
    MINIMUM_WINDOWS_LEGACY,
    SUPPORTED_ARCHITECTURES,
    describeWindows,
    isLegacyWindowsBuild,
    unsupportedArchitectureMessage,
    unsupportedWindowsMessage
} = require('../lib/windowsSupport');

const WIN32 = 'win32';

// The main builds' Electron and the Windows 7 build's, passed in so the result does not
// depend on what (if any) Electron runs the suite.
const CURRENT_ELECTRON = '41.10.7';
const LEGACY_ELECTRON = '22.3.27';

function describe(release, arch = 'x64', electron = CURRENT_ELECTRON) {
    return describeWindows({ platform: WIN32, release, arch, electron });
}

function testLegacyBuild() {
    // The Windows 7 build knows itself by its Electron, and only on Windows.
    assert.strictEqual(LEGACY_ELECTRON_MAJOR, 22);
    assert.strictEqual(isLegacyWindowsBuild({ platform: WIN32, electron: LEGACY_ELECTRON }), true);
    assert.strictEqual(isLegacyWindowsBuild({ platform: WIN32, electron: '11.5.0' }), true);
    assert.strictEqual(isLegacyWindowsBuild({ platform: WIN32, electron: '23.0.0' }), false);
    assert.strictEqual(isLegacyWindowsBuild({ platform: WIN32, electron: CURRENT_ELECTRON }), false);
    assert.strictEqual(isLegacyWindowsBuild({ platform: 'linux', electron: LEGACY_ELECTRON }), false);
    assert.strictEqual(isLegacyWindowsBuild({ platform: WIN32, electron: '' }), false, 'plain Node is not it');

    // It must be the Electron build/win7.config.js packages.
    const win7Config = require('../build/win7.config.js');
    assert.strictEqual(Number.parseInt(win7Config.electronVersion, 10), LEGACY_ELECTRON_MAJOR);
    assert.strictEqual(win7Config.electronVersion, LEGACY_ELECTRON);
    // Its files must never share a name with the main build's, or the update notice and the
    // refusal dialogs would point players at the wrong one.
    assert.ok(win7Config.nsis.artifactName.includes('-win7-${arch}-setup.'), win7Config.nsis.artifactName);
    assert.ok(win7Config.portable.artifactName.includes('-win7-${arch}-portable.'), win7Config.portable.artifactName);
    // Everything else is package.json's build.
    const base = require('../package.json').build;
    assert.strictEqual(win7Config.appId, base.appId, 'the same appId, so it installs over the main build');
    assert.deepStrictEqual(win7Config.files, base.files);
    assert.deepStrictEqual(win7Config.extraResources, base.extraResources);

    // On it, Windows 7, 8 and 8.1 play, on either architecture; Windows 10 and 11 still do.
    for (const [release, product] of [
        ['10.0.22631', 'Windows 10 or later'],
        ['6.3.9600', 'Windows 8.1'],
        ['6.2.9200', 'Windows 8'],
        ['6.1.7601', 'Windows 7'],
        ['6.1.7600', 'Windows 7']
    ]) {
        for (const arch of ['x64', 'ia32']) {
            const status = describe(release, arch, LEGACY_ELECTRON);
            assert.strictEqual(status.supported, true, `${product} (${release}, ${arch}) plays on the Windows 7 build`);
            assert.strictEqual(status.legacy, true);
            assert.strictEqual(status.minimum, MINIMUM_WINDOWS_LEGACY);
            assert.strictEqual(status.product, product);
            assert.strictEqual(status.reason, '');
        }
    }

    // Vista and XP have no Electron at all.
    for (const release of ['6.0.6002', '5.1.2600']) {
        const status = describe(release, 'x64', LEGACY_ELECTRON);
        assert.strictEqual(status.supported, false, `${release} is refused by the Windows 7 build too`);
        assert.strictEqual(status.olderBuild, false, 'there is no build to send it to');
        assert.ok(status.reason.includes(MINIMUM_WINDOWS_LEGACY), status.reason);
        const message = unsupportedWindowsMessage(status, { version: '1.9.0' });
        assert.ok(message.includes(`needs ${MINIMUM_WINDOWS_LEGACY} or later`), message);
        assert.ok(!message.includes('win7'), message);
    }

    // The main build on Windows 7, 8 and 8.1 sends the player to the Windows 7 build, by its
    // exact file name; on 32-bit Windows, the ia32 one.
    for (const [arch, file] of [
        ['x64', 'DungeonBlitzR-Launcher-1.9.0-win7-x64-setup.exe'],
        ['ia32', 'DungeonBlitzR-Launcher-1.9.0-win7-ia32-setup.exe']
    ]) {
        const status = describe('6.1.7601', arch);
        assert.strictEqual(status.supported, false);
        assert.strictEqual(status.olderBuild, true);
        assert.ok(status.requirements.includes('win7'), status.requirements);
        const message = unsupportedWindowsMessage(status, { version: '1.9.0' });
        assert.ok(message.includes(file), message);
        assert.ok(message.includes(`needs ${MINIMUM_WINDOWS} or later`), message);
        const expected = win7Config.nsis.artifactName.replace('${version}', '1.9.0').replace('${arch}', arch).replace('${ext}', 'exe');
        assert.strictEqual(expected, file, 'the dialog quotes the win7 nsis.artifactName');
    }
    const devMessage = unsupportedWindowsMessage(describe('6.3.9600'));
    assert.ok(devMessage.includes('DungeonBlitzR-Launcher-<version>-win7-x64-setup.exe'), devMessage);

    // An arm64 machine on the Windows 7 build is sent to the win7 x64 file.
    const arm64 = describe('10.0.22631', 'arm64', LEGACY_ELECTRON);
    assert.strictEqual(arm64.supported, false);
    assert.ok(
        unsupportedArchitectureMessage(arm64, { version: '1.9.0' }).includes('DungeonBlitzR-Launcher-1.9.0-win7-x64-setup.exe')
    );

    // Its installer lets Windows 7 through and refuses only older ones.
    const fs = require('fs');
    const path = require('path');
    const script = fs.readFileSync(path.join(__dirname, '..', win7Config.nsis.include), 'utf8').replace(/^\s*;.*$/gm, '');
    const customInit = script.match(/!macro\s+customInit\b([\s\S]*?)!macroend/);
    assert.ok(customInit, `${win7Config.nsis.include} must define customInit`);
    assert.match(customInit[1], /\$\{IfNot\}\s+\$\{AtLeastWin7\}/);
    assert.doesNotMatch(customInit[1], /AtLeastWin10/);
    assert.match(customInit[1], /\bQuit\b/);
    assert.match(customInit[1], /MessageBox[^\n]*\/SD\s+IDOK/);
}

function main() {
    // Anything that is not Windows is left alone: there is nothing to classify, and a build
    // for macOS must not start reading Windows versions.
    for (const platform of ['darwin', 'linux']) {
        const status = describeWindows({ platform, release: '10.0.22631', arch: 'arm64' });
        assert.strictEqual(status.supported, true);
        assert.strictEqual(status.product, '');
        assert.strictEqual(status.reason, '');
    }

    // Windows 10 and 11 both report a 10.0 kernel; that is the floor Electron sets.
    for (const release of ['10.0.19045', '10.0.22631']) {
        const windows10 = describe(release);
        assert.strictEqual(windows10.supported, true);
        assert.strictEqual(windows10.product, 'Windows 10 or later');
        assert.strictEqual(windows10.reason, '', 'a supported Windows has nothing to complain about');
        assert.strictEqual(windows10.requirements, '');
    }

    // A kernel newer than 10.0 is newer than Windows 10, not older.
    const future = describe('11.0.30000');
    assert.strictEqual(future.supported, true);
    assert.strictEqual(future.reason, '');

    // Windows 7, 8 and 8.1 are refused by name: Electron dropped them in version 23.
    for (const [release, product] of [
        ['6.3.9600', 'Windows 8.1'],
        ['6.2.9200', 'Windows 8'],
        ['6.1.7601', 'Windows 7'],
        ['6.1.7600', 'Windows 7'],
        ['6.0.6002', 'Windows Vista']
    ]) {
        const status = describe(release);
        assert.strictEqual(status.supported, false, `${product} (${release}) must be refused`);
        assert.strictEqual(status.product, product);
        assert.ok(status.reason.includes(MINIMUM_WINDOWS), status.reason);
        assert.ok(status.requirements.includes(MINIMUM_WINDOWS), status.requirements);
    }

    // Older than the table is refused as well, named by its kernel.
    const xp = describe('5.1.2600');
    assert.strictEqual(xp.supported, false);
    assert.strictEqual(xp.product, 'Windows 5.1');
    assert.ok(xp.reason.includes(MINIMUM_WINDOWS), xp.reason);

    // A version that cannot be read is refused rather than assumed modern: guessing here
    // is how a player ends up on a launcher that cannot start with no way to tell why.
    for (const release of ['', 'not-a-version', '10']) {
        const unknown = describe(release);
        assert.strictEqual(unknown.supported, false, `"${release}" must not read as supported`);
        assert.ok(unknown.reason.includes('could not be read'), unknown.reason);
    }

    // The refusal text names the floor and the machine it refused.
    const windows7 = describe('6.1.7601');
    const message = unsupportedWindowsMessage(windows7);
    assert.ok(message.includes(MINIMUM_WINDOWS), message);
    assert.ok(message.includes('Windows 7'), message);
    assert.ok(message.includes('6.1.7601'), message);
    // 32-bit is no requirement anyone has to be told about: Flash Player is a 32-bit
    // program in its own process and runs on both.
    assert.ok(!message.includes('64-bit'), message);
    assert.ok(!MINIMUM_WINDOWS.includes('64-bit'), MINIMUM_WINDOWS);

    // The same text works for a version that could not be read at all.
    const unknownMessage = unsupportedWindowsMessage(describe(''));
    assert.ok(unknownMessage.includes(MINIMUM_WINDOWS), unknownMessage);

    // The 32-bit Windows build plays: the game runs in flashplayer_32_sa.exe, a 32-bit
    // program in its own process, so nothing has to match the launcher's architecture.
    assert.deepStrictEqual(SUPPORTED_ARCHITECTURES, ['x64', 'ia32']);
    for (const release of ['10.0.19045', '10.0.22631']) {
        for (const arch of ['x64', 'ia32']) {
            const status = describe(release, arch);
            assert.strictEqual(status.supported, true, `${arch} on ${release} plays`);
            assert.strictEqual(status.architectureSupported, true);
        }
    }

    // A Windows too old for the launcher is still refused on either architecture.
    const ia32Windows7 = describe('6.1.7601', 'ia32');
    assert.strictEqual(ia32Windows7.supported, false);
    assert.strictEqual(ia32Windows7.architectureSupported, true);
    assert.ok(ia32Windows7.reason.includes(MINIMUM_WINDOWS), ia32Windows7.reason);

    // arm64 has no build, and is refused by architecture rather than reaching a version
    // check it has no business passing.
    const arm64 = describe('10.0.22631', 'arm64');
    assert.strictEqual(arm64.supported, false);
    assert.strictEqual(arm64.architectureSupported, false);
    assert.ok(arm64.reason.includes('arm64'), arm64.reason);
    assert.ok(arm64.requirements.includes('win-x64'), arm64.requirements);
    assert.ok(!arm64.requirements.includes(MINIMUM_WINDOWS), 'an architecture refusal is not a Windows version refusal');

    // The refusal names the exact file to download, spelled the way the release page does.
    const archMessage = unsupportedArchitectureMessage(arm64, { version: '1.0.17' });
    assert.ok(/an arm64 process/.test(archMessage), archMessage);
    assert.ok(archMessage.includes('DungeonBlitzR-Launcher-1.0.17-win-x64-setup.exe'), archMessage);
    assert.ok(!archMessage.includes(MINIMUM_WINDOWS), archMessage);

    // That name is built from build.nsis.artifactName, so a change there silently breaks
    // the instruction. Derive it from package.json rather than restating it.
    const artifactName = require('../package.json').build.nsis.artifactName;
    assert.strictEqual(
        artifactName.replace('${version}', '1.0.17').replace('${arch}', 'x64').replace('${ext}', 'exe'),
        'DungeonBlitzR-Launcher-1.0.17-win-x64-setup.exe',
        'the dialog quotes build.nsis.artifactName; if that changes, update unsupportedArchitectureMessage()'
    );

    // Without a version (a development run) it must not invent a filename.
    const devMessage = unsupportedArchitectureMessage(arm64);
    assert.ok(devMessage.includes('DungeonBlitzR-Launcher-<version>-win-x64-setup.exe'), devMessage);
    assert.ok(!/DungeonBlitzR-Launcher-\d/.test(devMessage), 'no made-up version in the dev message');

    testLegacyBuild();

    console.log('[test-windows-support] Windows 10 and later are supported');
    console.log('[test-windows-support] Windows 8.1, 8, 7, Vista, XP and unreadable versions are refused by name');
    console.log('[test-windows-support] 32-bit and 64-bit builds both play; arm64 is refused by name');
    console.log('[test-windows-support] the Windows 7 build (Electron 22) plays on Windows 7, 8 and 8.1; the main build names its file');
    console.log('[test-windows-support] all assertions passed');
}

main();