'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    detectGraphics,
    flashQuality,
    machineTier,
    projectorRenderMode,
    resolveGraphics
} = require('../lib/graphics');
const { buildLoaderSwf } = require('../lib/loaderSwf');
const { prepareLaunch } = require('../lib/projector');
const { prepareAirLaunch } = require('../lib/airEngine');
const { createStateStore } = require('../lib/config');

const GB = 1024 * 1024 * 1024;
const report = (line) => console.log(`[test-graphics] ${line}`);

const strong = { cpus: 8, totalmem: 16 * GB };
const gpuOk = { gpu_compositing: 'enabled' };
const realGpu = { gpuDevice: [{ active: true, vendorId: 0x10de, deviceId: 0x2484 }] };

assert.strictEqual(machineTier({ cpus: 2, totalmem: 16 * GB }), 'low');
assert.strictEqual(machineTier({ cpus: 4, totalmem: 16 * GB }), 'medium');
assert.strictEqual(machineTier({ cpus: 8, totalmem: 6 * GB }), 'medium');
assert.strictEqual(machineTier(strong), 'high');

assert.deepStrictEqual(detectGraphics({ featureStatus: gpuOk, gpuInfo: realGpu, ...strong }).gpu, true);
assert.strictEqual(detectGraphics({ featureStatus: { gpu_compositing: 'disabled_software' }, ...strong }).gpu, false);
assert.strictEqual(
    detectGraphics({ featureStatus: gpuOk, gpuInfo: { gpuDevice: [{ active: true, vendorId: 0x1414, deviceId: 0x8c }] }, ...strong }).gpu,
    false,
    'Microsoft Basic Render Driver is a CPU'
);
assert.strictEqual(
    detectGraphics({ featureStatus: gpuOk, gpuInfo: { auxAttributes: { glRenderer: 'llvmpipe (LLVM 15.0.7, 256 bits)' } }, ...strong }).gpu,
    false,
    'llvmpipe is a CPU'
);
report('GPU and machine strength are detected: OK');

const gpuHigh = { gpu: true, tier: 'high' };
const noGpu = { gpu: false, tier: 'high' };
assert.deepStrictEqual(resolveGraphics({}, gpuHigh), { renderer: 'gpu', quality: 'high', autoRenderer: true, autoQuality: true });
assert.deepStrictEqual(resolveGraphics({}, noGpu), { renderer: 'cpu', quality: 'medium', autoRenderer: true, autoQuality: true });
assert.strictEqual(resolveGraphics({}, { gpu: true, tier: 'low' }).quality, 'low');
assert.deepStrictEqual(
    resolveGraphics({ renderer: 'cpu', graphicsQuality: 'high' }, gpuHigh),
    { renderer: 'cpu', quality: 'high', autoRenderer: false, autoQuality: false },
    'a manual pick wins over detection'
);
assert.strictEqual(resolveGraphics({ renderer: 'nonsense' }, noGpu).renderer, 'cpu');
report('auto picks from detection, manual picks win: OK');

const env = {};
assert.strictEqual(projectorRenderMode(resolveGraphics({}, gpuHigh), { platform: 'win32', env }), 'direct');
assert.strictEqual(projectorRenderMode(resolveGraphics({}, gpuHigh), { platform: 'linux', env }), '');
assert.strictEqual(projectorRenderMode(resolveGraphics({ renderer: 'gpu' }, gpuHigh), { platform: 'darwin', env }), 'direct');
assert.strictEqual(projectorRenderMode(resolveGraphics({}, noGpu), { platform: 'win32', env }), '');
assert.strictEqual(
    projectorRenderMode(resolveGraphics({ renderer: 'cpu' }, gpuHigh), { platform: 'win32', env: { DB_FLASH_RENDER: 'gpu' }, fallback: 'gpu' }),
    'gpu',
    'DB_FLASH_RENDER still wins'
);
assert.strictEqual(flashQuality('low'), 'LOW');
assert.strictEqual(flashQuality('medium'), 'MEDIUM');
assert.strictEqual(flashQuality('high'), '');
report('Flash Player render mode and quality: OK');

const url = 'http://example.test/p/cbp/DungeonBlitz.swf';
const plain = buildLoaderSwf(url);
const low = buildLoaderSwf(url, { quality: 'LOW' });
const setQuality = Buffer.from([0x96, 0x0c, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x98, 0x41, 0x00, 0x4c, 0x4f, 0x57, 0x00, 0x23]);
assert.ok(!plain.includes(setQuality), 'no quality without one asked');
assert.ok(low.includes(setQuality), 'setProperty("", _quality, "LOW")');
assert.ok(low.indexOf(setQuality) < low.indexOf(Buffer.from(url)), 'quality is set before the game loads');
assert.strictEqual(low.readUInt32LE(4), low.length, 'the header length matches');
assert.throws(() => buildLoaderSwf(url, { quality: 'ULTRA' }));
report('the loader sets the stage quality before loading the game: OK');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-graphics-'));
try {
    const projector = { path: '/fp', executable: '/fp' };
    const linuxPlain = prepareLaunch(projector, url, { platform: 'linux', workDir, env: {}, render: '', quality: '' });
    assert.deepStrictEqual(linuxPlain.args, [url], 'Linux plays the URL as before');
    const linuxLow = prepareLaunch(projector, url, { platform: 'linux', workDir, env: {}, render: 'direct', quality: 'LOW' });
    assert.deepStrictEqual(linuxLow.args, [url], 'Linux never uses the loader: its player does not run the game from one');
    const macLow = prepareLaunch(projector, url, { platform: 'darwin', workDir, env: {}, render: '', quality: 'LOW' });
    assert.ok(fs.readFileSync(path.join(workDir, macLow.args[0])).includes(setQuality), 'macOS loader carries the quality');
    const winCpu = prepareLaunch(projector, url, { platform: 'win32', workDir, env: {}, render: '', quality: '' });
    assert.deepStrictEqual(winCpu.args, [url], 'Windows software rendering at full quality plays the URL');
    const winCpuLow = prepareLaunch(projector, url, { platform: 'win32', workDir, env: {}, render: '', quality: 'LOW' });
    assert.ok(winCpuLow.args[0].startsWith(workDir));
} finally {
    fs.rmSync(workDir, { recursive: true, force: true });
}
report('Flash Player is started with the chosen quality: OK');

assert.deepStrictEqual(prepareAirLaunch({ executable: 'e' }, 'http://x/g.swf', { quality: flashQuality('low') }).args, ['http://x/g.swf', `--quality=${flashQuality('low')}`]);
report('the AIR engine gets the quality: OK');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-graphics-state-'));
try {
    const store = createStateStore(stateDir);
    assert.strictEqual(store.read().renderer, 'auto');
    assert.strictEqual(store.read().graphicsQuality, 'auto');
    store.write({ renderer: 'cpu', graphicsQuality: 'low' });
    assert.strictEqual(createStateStore(stateDir).read().renderer, 'cpu');
    fs.writeFileSync(store.path, JSON.stringify({ renderer: 'gpu', graphicsQuality: 'bogus', padding: 'changed size' }));
    assert.strictEqual(store.read().renderer, 'gpu', 'a file changed on disk is read again');
    assert.strictEqual(store.read().graphicsQuality, 'auto');
} finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
}
report('the choice is saved: OK');
report('all assertions passed');
