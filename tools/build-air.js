#!/usr/bin/env node
'use strict';

/**
 * Builds the AIR engine (air/) into vendor/air/<platform>/ as a captive-runtime bundle, the
 * AIR runtime inside, and fingerprints it into lib/air.integrity.json (lib/airEngine.js).
 *
 * Needs HARMAN's AIR SDK (https://airsdk.harman.com/download), 50.0 or newer, in AIR_SDK_HOME or
 * --sdk. ADT builds a bundle only for the system it runs on, so each platform is built on its own.
 *
 * ADT signs every bundle. Without DB_AIR_CERT (a .p12) and DB_AIR_CERT_PASS, a self-signed
 * certificate is made once in build/air/ and reused; the captive bundle does not show it to players.
 *
 * Usage:
 *   AIR_SDK_HOME=/path/to/AIRSDK node tools/build-air.js [--sdk <dir>] [--check <bundle>]
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LAUNCHER_ROOT = path.resolve(__dirname, '..');
const AIR_ROOT = path.join(LAUNCHER_ROOT, 'air');
const WORK_DIR = path.join(LAUNCHER_ROOT, 'build', 'air');
const VENDOR_ROOT = path.join(LAUNCHER_ROOT, 'vendor', 'air');

function parseArgs(argv) {
    const args = { sdk: process.env.AIR_SDK_HOME || '', check: '' };
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] === '--sdk' && argv[index + 1]) {
            args.sdk = argv[++index];
        } else if (argv[index] === '--check' && argv[index + 1]) {
            args.check = argv[++index];
        }
    }
    return args;
}

function tool(sdk, name) {
    const candidates = process.platform === 'win32' ? [`${name}.bat`, `${name}.exe`, name] : [name];
    for (const candidate of candidates) {
        const full = path.join(sdk, 'bin', candidate);
        if (fs.existsSync(full)) {
            return full;
        }
    }
    throw new Error(`${name} not found in ${path.join(sdk, 'bin')}; is AIR_SDK_HOME an AIR SDK?`);
}

function run(command, args) {
    console.log(`[build-air] ${path.basename(command)} ${args.join(' ')}`);
    const shell = process.platform === 'win32' && command.endsWith('.bat');
    // A .bat runs through cmd.exe, which splits unquoted arguments on spaces.
    const passed = shell ? args.map((arg) => (/[\s&|<>^()]/.test(arg) ? `"${arg}"` : arg)) : args;
    execFileSync(command, passed, { stdio: 'inherit', shell });
}

/** The newest app descriptor namespace the SDK knows: amxmlc writes that SWF version, and ADT refuses an older namespace. */
function sdkNamespace(sdk) {
    try {
        const xml = fs.readFileSync(path.join(sdk, 'airsdk.xml'), 'utf8');
        const versions = [...xml.matchAll(/http:\/\/ns\.adobe\.com\/air\/application\/([0-9.]+)/g)].map((match) => match[1]);
        versions.sort((a, b) => {
            const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)];
            return x[0] - y[0] || (x[1] || 0) - (y[1] || 0);
        });
        return versions.length ? `http://ns.adobe.com/air/application/${versions[versions.length - 1]}` : '';
    } catch {
        return '';
    }
}

function descriptor(version, namespace = '') {
    let source = fs.readFileSync(path.join(AIR_ROOT, 'DungeonBlitzAir-app.xml'), 'utf8');
    if (namespace) {
        source = source.replace(/xmlns="http:\/\/ns\.adobe\.com\/air\/application\/[0-9.]+"/, `xmlns="${namespace}"`);
    }
    const numeric = String(version).replace(/[^0-9.].*$/, '') || '0.0.0';
    return source.replace(/<versionNumber>[^<]*<\/versionNumber>/, `<versionNumber>${numeric}</versionNumber>`);
}

function certificate(adt) {
    if (process.env.DB_AIR_CERT) {
        return { file: process.env.DB_AIR_CERT, pass: process.env.DB_AIR_CERT_PASS || '' };
    }
    const file = path.join(WORK_DIR, 'self-signed.p12');
    const pass = 'dungeonblitzr';
    if (!fs.existsSync(file)) {
        run(adt, ['-certificate', '-cn', 'Dungeon Blitz R', '2048-RSA', file, pass]);
    }
    return { file, pass };
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const { verifyAirApp, BUNDLE_NAME } = require('../lib/airEngine');
    if (args.check) {
        const result = verifyAirApp(args.check);
        if (!result.ok) {
            throw new Error(`${args.check}: ${result.reason}`);
        }
        console.log(`[build-air] ${args.check} matches its fingerprint`);
        return;
    }
    if (process.platform === 'linux') {
        throw new Error('HARMAN\'s Linux AIR runtime is limited to commercially licensed developers; build on Windows or macOS');
    }
    if (!args.sdk) {
        throw new Error('set AIR_SDK_HOME (or pass --sdk) to HARMAN\'s AIR SDK');
    }

    const { version } = require('../package.json');
    const amxmlc = tool(args.sdk, 'amxmlc');
    const adt = tool(args.sdk, 'adt');
    const stage = path.join(WORK_DIR, 'stage');
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(path.join(stage, 'icons'), { recursive: true });

    run(amxmlc, [
        '-source-path', path.join(AIR_ROOT, 'src'),
        '-output', path.join(stage, 'DungeonBlitzAir.swf'),
        '-optimize=true',
        '-debug=false',
        path.join(AIR_ROOT, 'src', 'DungeonBlitzAir.as')
    ]);
    for (const icon of fs.readdirSync(path.join(AIR_ROOT, 'icons'))) {
        fs.copyFileSync(path.join(AIR_ROOT, 'icons', icon), path.join(stage, 'icons', icon));
    }
    const descriptorPath = path.join(WORK_DIR, 'DungeonBlitzAir-app.xml');
    fs.writeFileSync(descriptorPath, descriptor(version, sdkNamespace(args.sdk)));

    const target = path.join(VENDOR_ROOT, process.platform);
    const bundle = path.join(target, process.platform === 'darwin' ? `${BUNDLE_NAME}.app` : BUNDLE_NAME);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    const cert = certificate(adt);
    run(adt, [
        '-package',
        '-storetype', 'pkcs12', '-keystore', cert.file, '-storepass', cert.pass,
        '-target', 'bundle', bundle,
        descriptorPath,
        '-C', stage, 'DungeonBlitzAir.swf', 'icons'
    ]);

    const { writeExpected } = require('../lib/integrity');
    const { INTEGRITY_PATH } = require('../lib/airEngine');
    const record = writeExpected(bundle, { platform: process.platform, version }, INTEGRITY_PATH);
    console.log(`[build-air] ${path.relative(LAUNCHER_ROOT, bundle)}: fingerprint ${record.digest} -> lib/air.integrity.json`);
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`[build-air] ERROR: ${error.message}`);
        process.exit(1);
    }
}

module.exports = { descriptor };
