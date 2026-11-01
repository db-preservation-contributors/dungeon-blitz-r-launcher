#!/usr/bin/env node
'use strict';

/**
 * Starts a packaged launcher and checks it is still running a little later.
 *
 * Every other check before 1.2.2 looked at the package's files or drove the launcher's modules
 * from Node; none of them started the finished launcher. 1.2.2 then died within a second of
 * starting on every Windows and macOS machine -- the installed launcher's Electron fuses kill the
 * process for something no development run ever does -- and was published that way. The release
 * workflow runs this on the unpacked package before anything is attached to a release.
 *
 * It fails when the launcher exits early or logs a FATAL line, and prints what it logged either
 * way.
 *
 * Usage: node tools/smoke-launch.js <launcher executable> [--seconds 20] [-- <launcher arguments>]
 *
 * Arguments after `--` go to the launcher itself. The Windows 7 build is started with
 * `--disable-gpu --disable-gpu-compositing`: GitHub's Windows runners have no GPU, and Electron
 * 22's GPU process crashes there until Chromium gives up ("GPU process isn't usable. Goodbye.").
 * That took the win7 installers off every release from 1.10.0 to 1.11.1, while the installer
 * kept sending Windows 7 players to them. Those switches only change how the launcher's own
 * window is drawn; what this checks -- that the package starts and stays up -- is the same.
 */

const { spawn, execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const separator = argv.indexOf('--');
const args = separator >= 0 ? argv.slice(0, separator) : argv;
const launcherArgs = separator >= 0 ? argv.slice(separator + 1) : [];
const executable = args.find((arg) => !arg.startsWith('--'));
const secondsIndex = args.indexOf('--seconds');
const seconds = secondsIndex >= 0 ? Number(args[secondsIndex + 1]) || 20 : 20;

if (!executable) {
    console.error('Usage: node tools/smoke-launch.js <launcher executable> [--seconds 20] [-- <launcher arguments>]');
    process.exit(1);
}

let output = '';
let exited = null;
const child = spawn(executable, launcherArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group off Windows, so the launcher and anything it starts can be stopped.
    detached: process.platform !== 'win32',
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
});
child.stdout.on('data', (chunk) => {
    output += chunk;
});
child.stderr.on('data', (chunk) => {
    output += chunk;
});
child.on('error', (error) => {
    exited = `could not start: ${error.message}`;
});
child.on('exit', (code, signal) => {
    exited = exited || `exited (${signal || `code ${code}`})`;
});

function stop() {
    try {
        if (process.platform === 'win32') {
            execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
            process.kill(-child.pid, 'SIGKILL');
        }
    } catch {
        // Already gone.
    }
}

setTimeout(() => {
    const fatal = output.split(/\r?\n/).filter((line) => /FATAL/.test(line));
    stop();
    console.log(`[smoke-launch] ${[executable, ...launcherArgs].join(' ')}`);
    console.log('[smoke-launch] --- what it logged ---');
    console.log(output.trim() || '(nothing)');
    console.log('[smoke-launch] ---');
    if (exited) {
        console.error(`[smoke-launch] FAILED: the launcher ${exited} within ${seconds}s of starting.`);
        process.exit(1);
    }
    if (fatal.length) {
        console.error(`[smoke-launch] FAILED: the launcher logged ${fatal.length} FATAL line(s).`);
        process.exit(1);
    }
    console.log(`[smoke-launch] still running after ${seconds}s with no FATAL line: OK`);
    process.exit(0);
}, seconds * 1000);
