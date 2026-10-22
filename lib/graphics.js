'use strict';

const os = require('os');

const RENDERERS = ['auto', 'gpu', 'cpu'];
const QUALITIES = ['auto', 'high', 'medium', 'low'];
const TIERS = ['low', 'medium', 'high'];
const GB = 1024 * 1024 * 1024;

// Microsoft Basic Render Driver: Windows' software adapter when no GPU driver is installed.
const SOFTWARE_VENDOR_IDS = new Set([0x1414]);
const SOFTWARE_NAMES = /swiftshader|llvmpipe|softpipe|basic render|software rasterizer|microsoft basic/i;

function normalizeRenderer(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return RENDERERS.includes(normalized) ? normalized : 'auto';
}

function normalizeQuality(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return QUALITIES.includes(normalized) ? normalized : 'auto';
}

function isSoftwareGpu(gpuInfo) {
    const info = gpuInfo || {};
    const devices = Array.isArray(info.gpuDevice) ? info.gpuDevice : [];
    const active = devices.find((device) => device && device.active) || devices[0];
    if (active && SOFTWARE_VENDOR_IDS.has(Number(active.vendorId))) {
        return true;
    }
    const names = [
        info.auxAttributes && info.auxAttributes.glRenderer,
        active && active.driverVendor,
        active && active.description,
        active && active.deviceString
    ];
    return names.some((name) => SOFTWARE_NAMES.test(String(name || '')));
}

function machineTier({ cpus = os.cpus().length, totalmem = os.totalmem() } = {}) {
    if (cpus <= 2 || totalmem < 4 * GB) {
        return 'low';
    }
    if (cpus <= 4 || totalmem < 8 * GB) {
        return 'medium';
    }
    return 'high';
}

/**
 * What this machine can do: whether it has a GPU worth rendering on, and how strong it is.
 * `featureStatus` and `gpuInfo` are Electron's app.getGPUFeatureStatus() and
 * app.getGPUInfo('basic').
 */
function detectGraphics({ featureStatus, gpuInfo, cpus, totalmem } = {}) {
    const tier = machineTier({
        cpus: Number.isFinite(cpus) ? cpus : os.cpus().length,
        totalmem: Number.isFinite(totalmem) ? totalmem : os.totalmem()
    });
    const compositing = String((featureStatus || {}).gpu_compositing || '');
    if (!featureStatus) {
        return { gpu: true, tier, reason: 'GPU status unknown' };
    }
    if (!compositing.startsWith('enabled')) {
        return { gpu: false, tier, reason: `GPU compositing ${compositing || 'unavailable'}` };
    }
    if (isSoftwareGpu(gpuInfo)) {
        return { gpu: false, tier, reason: 'software GPU driver' };
    }
    return { gpu: true, tier, reason: 'GPU available' };
}

/** The renderer and quality the next game runs with. */
function resolveGraphics(settings, detected) {
    const renderer = normalizeRenderer(settings && settings.renderer);
    const quality = normalizeQuality(settings && settings.graphicsQuality);
    const found = detected || { gpu: true, tier: 'high' };

    const resolvedRenderer = renderer === 'auto' ? (found.gpu ? 'gpu' : 'cpu') : renderer;
    let resolvedQuality = quality;
    if (quality === 'auto') {
        resolvedQuality = TIERS.includes(found.tier) ? found.tier : 'high';
        if (!found.gpu && resolvedQuality === 'high') {
            resolvedQuality = 'medium';
        }
    }
    return {
        renderer: resolvedRenderer,
        quality: resolvedQuality,
        autoRenderer: renderer === 'auto',
        autoQuality: quality === 'auto'
    };
}

/**
 * Flash Player's render mode for a resolved setting: 'direct' (hardware) or '' (software).
 * Auto keeps software rendering off Windows, where direct rendering is untried;
 * DB_FLASH_RENDER still overrides everything.
 */
function projectorRenderMode(resolved, { platform = process.platform, env = process.env, fallback } = {}) {
    if (String((env || {}).DB_FLASH_RENDER || '').trim()) {
        return fallback;
    }
    if (resolved.renderer === 'cpu') {
        return '';
    }
    if (resolved.autoRenderer && platform !== 'win32') {
        return '';
    }
    return 'direct';
}

/** Flash's own quality name, or '' to leave the game's default (HIGH). */
function flashQuality(quality) {
    if (quality === 'low') {
        return 'LOW';
    }
    if (quality === 'medium') {
        return 'MEDIUM';
    }
    return '';
}

module.exports = {
    QUALITIES,
    RENDERERS,
    detectGraphics,
    flashQuality,
    isSoftwareGpu,
    machineTier,
    normalizeQuality,
    normalizeRenderer,
    projectorRenderMode,
    resolveGraphics
};
