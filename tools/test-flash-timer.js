#!/usr/bin/env node
'use strict';

/**
 * lib/flashTimer.js: the 1 ms Windows timer Flash Player is given for a steady 60 fps.
 *
 * Nothing here starts Flash Player; spawning is faked. What is checked is when the timer is
 * asked for, through which PowerShell, with what, and that the script stays PowerShell 2.0
 * (Windows 7) safe.
 */

const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');

const { TIMER_PERIOD_MS, WINDOWS_SCRIPT, boostFlashTimer, powershell32 } = require('../lib/flashTimer');

function fakeSpawn(answer) {
    const calls = [];
    const spawnImpl = (command, args, options) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        calls.push({ command, args, options, script: fs.readFileSync(args[args.indexOf('-File') + 1], 'utf8') });
        setImmediate(() => {
            if (answer !== null) {
                child.stdout.emit('data', Buffer.from(`${answer}\r\n`));
            }
            child.emit('exit', 0);
        });
        return child;
    };
    return { calls, spawnImpl };
}

function onlyOn(result) {
    return new Promise((resolve) => setImmediate(() => setImmediate(() => resolve(result))));
}

async function checkWhenItRuns() {
    const { calls, spawnImpl } = fakeSpawn('ok: 1 ms');
    for (const platform of ['darwin', 'linux']) {
        assert.strictEqual(boostFlashTimer(1234, { platform, spawnImpl }).method, 'none', `nothing to do on ${platform}`);
    }
    assert.strictEqual(boostFlashTimer(0, { platform: 'win32', spawnImpl }).method, 'none', 'no process, no request');
    assert.strictEqual(boostFlashTimer(undefined, { platform: 'win32', spawnImpl }).method, 'none');
    assert.strictEqual(
        boostFlashTimer(1234, { platform: 'win32', env: { DB_FLASH_TIMER: '0' }, spawnImpl }).method,
        'off',
        'DB_FLASH_TIMER=0 leaves the timer alone'
    );
    assert.strictEqual(calls.length, 0);
    console.log('[test-flash-timer] only Windows asks, and DB_FLASH_TIMER=0 turns it off: OK');
}

async function checkTheRequest() {
    const { calls, spawnImpl } = fakeSpawn('ok: 1 ms');
    const results = [];
    const env = { SystemRoot: 'C:\\Windows' };
    const started = boostFlashTimer(4321, { platform: 'win32', env, spawnImpl, onResult: (line) => results.push(line) });
    assert.strictEqual(started.method, 'win32-timebeginperiod');
    await onlyOn();

    assert.strictEqual(calls.length, 1, 'one PowerShell per game');
    const [call] = calls;
    assert.strictEqual(call.command, powershell32(env), 'the 32-bit PowerShell, like Flash Player');
    assert.ok(call.args.includes('-File'), 'runs from a file');
    assert.ok(!call.args.some((arg) => /encodedcommand/i.test(arg)), 'never -EncodedCommand');
    assert.deepStrictEqual(call.args.slice(-2), ['4321', String(TIMER_PERIOD_MS)], 'the game process and 1 ms');
    assert.strictEqual(TIMER_PERIOD_MS, 1);
    assert.strictEqual(call.options.windowsHide, true);
    assert.strictEqual(call.script, WINDOWS_SCRIPT);
    assert.deepStrictEqual(results, ['ok: 1 ms'], "PowerShell's answer is passed on, trimmed");
    const scriptPath = call.args[call.args.indexOf('-File') + 1];
    assert.ok(!fs.existsSync(scriptPath), 'the temp script is removed afterwards');

    const silent = fakeSpawn(null);
    const silentResults = [];
    boostFlashTimer(4321, { platform: 'win32', env, spawnImpl: silent.spawnImpl, onResult: (line) => silentResults.push(line) });
    await onlyOn();
    assert.deepStrictEqual(silentResults, ['failed: no answer from PowerShell']);
    console.log('[test-flash-timer] the 32-bit PowerShell asks for 1 ms in the game process: OK');
}

function checkPowerShellPath() {
    const env = { SystemRoot: 'D:\\Win' };
    assert.strictEqual(
        powershell32(env, () => true),
        'D:\\Win\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe',
        '64-bit Windows: the SysWOW64 one'
    );
    assert.strictEqual(
        powershell32(env, () => false),
        'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        '32-bit Windows: the only one, already 32-bit'
    );
    assert.ok(powershell32({}, () => true).startsWith('C:\\Windows\\'), 'a default Windows folder');
    console.log('[test-flash-timer] the 32-bit PowerShell is found on 64- and 32-bit Windows: OK');
}

function checkScript() {
    // A double-quoted here-string expands $names: only the two parameters may appear in it.
    const body = WINDOWS_SCRIPT.slice(WINDOWS_SCRIPT.indexOf('@"'), WINDOWS_SCRIPT.indexOf('"@'));
    assert.ok(!body.includes('$'), 'nothing in the C# is expanded by PowerShell');
    for (const banned of ['Get-CimInstance', 'ConvertTo-Json', '[pscustomobject]', ' var ', '=>']) {
        assert.ok(!WINDOWS_SCRIPT.includes(banned), `PowerShell 2.0 / C# 2 safe: no ${banned}`);
    }
    // The thread only runs an export that is already there: no memory is written into the game.
    for (const banned of ['VirtualAllocEx', 'WriteProcessMemory']) {
        assert.ok(!WINDOWS_SCRIPT.includes(banned), `no ${banned}`);
    }
    assert.ok(WINDOWS_SCRIPT.includes('"timeBeginPeriod"'));
    assert.ok(WINDOWS_SCRIPT.includes('theirs.BaseAddress != own.BaseAddress'), 'the module address is checked first');
    console.log('[test-flash-timer] the script is PowerShell 2.0 safe and writes nothing into Flash Player: OK');
}

async function main() {
    await checkWhenItRuns();
    await checkTheRequest();
    checkPowerShellPath();
    checkScript();
    console.log('[test-flash-timer] all assertions passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
