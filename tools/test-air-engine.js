'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { airAppInDirectory, findAirApp, prepareAirLaunch, verifyAirApp } = require('../lib/airEngine');
const { writeExpected } = require('../lib/integrity');
const { descriptor } = require('./build-air');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'air-engine-'));
try {
    const win = path.join(scratch, 'win32');
    fs.mkdirSync(path.join(win, 'DungeonBlitzR'), { recursive: true });
    fs.writeFileSync(path.join(win, 'DungeonBlitzR', 'DungeonBlitzR.exe'), 'exe');
    assert.deepStrictEqual(airAppInDirectory(win, 'win32'), {
        path: path.join(win, 'DungeonBlitzR'),
        executable: path.join(win, 'DungeonBlitzR', 'DungeonBlitzR.exe')
    });

    const linux = path.join(scratch, 'linux');
    fs.mkdirSync(path.join(linux, 'DungeonBlitzR'), { recursive: true });
    fs.writeFileSync(path.join(linux, 'DungeonBlitzR', 'DungeonBlitzR'), 'elf');
    assert.strictEqual(findAirApp({ directories: [path.join(scratch, 'none'), linux], platform: 'linux' }).executable,
        path.join(linux, 'DungeonBlitzR', 'DungeonBlitzR'));
    assert.strictEqual(findAirApp({ directories: [path.join(scratch, 'none')], platform: 'linux' }), null);

    const mac = path.join(scratch, 'darwin');
    const macOs = path.join(mac, 'DungeonBlitzR.app', 'Contents', 'MacOS');
    fs.mkdirSync(macOs, { recursive: true });
    fs.writeFileSync(path.join(macOs, 'DungeonBlitzR'), 'macho');
    assert.strictEqual(airAppInDirectory(mac, 'darwin').executable, path.join(macOs, 'DungeonBlitzR'));

    const url = 'http://example.test/p/cbp/DungeonBlitz.swf?fv=cbp&gv=cbp';
    assert.deepStrictEqual(prepareAirLaunch({ executable: 'air' }, url), { command: 'air', args: [url] });
    assert.deepStrictEqual(prepareAirLaunch({ executable: 'air' }, url, { quality: 'LOW' }).args, [url, '--quality=LOW']);

    const integrityPath = path.join(scratch, 'air.integrity.json');
    const bundle = path.join(linux, 'DungeonBlitzR');
    writeExpected(bundle, { platform: 'linux', version: '1.0.0' }, integrityPath);
    assert.ok(verifyAirApp(bundle, { integrityPath, platform: 'linux' }).ok);
    fs.writeFileSync(path.join(bundle, 'DungeonBlitzR'), 'changed');
    assert.ok(!verifyAirApp(bundle, { integrityPath, platform: 'linux' }).ok, 'a changed bundle is refused');

    assert.ok(descriptor('1.4.2-beta.1').includes('<versionNumber>1.4.2</versionNumber>'));
    assert.ok(descriptor('2.0.0').includes('<content>DungeonBlitzAir.swf</content>'));
} finally {
    fs.rmSync(scratch, { recursive: true, force: true });
}

console.log('AIR engine: OK');
