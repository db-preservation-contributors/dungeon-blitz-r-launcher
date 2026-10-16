'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

/**
 * Gives the standalone Flash Player on Windows a 1 ms system timer, so the game holds 60 fps.
 *
 * Flash Player 32 paces its frames off the Windows timer and tops out at 60 fps however high
 * the game asks (the game asks for 100). At Windows' default 15.6 ms tick a 16.7 ms frame
 * keeps landing one tick late, so about one frame in nine takes 31-32 ms: a visible hitch.
 * Measured on Windows 11 with a bare 60 fps movie in flashplayer_32_sa 32.0.0.465:
 *
 *   default timer   ~60 fps, 14-39 of every 180 frames over 20 ms, worst 32-86 ms
 *   1 ms timer      ~60 fps,  2-13 of every 180 frames over 20 ms, worst 21-34 ms
 *
 * Since Windows 10 2004 the timer resolution is per process: another program asking for 1 ms
 * no longer speeds Flash Player up, and Flash Player never asks itself. So the launcher has
 * Flash Player ask: one thread is started in it, at winmm.dll's own timeBeginPeriod with the
 * argument 1. Nothing is written into Flash Player's memory -- the thread runs an exported
 * function that is already loaded there -- and the request lasts until Flash Player exits.
 *
 * Flash Player is a 32-bit program, so this runs in the 32-bit PowerShell, where winmm.dll
 * sits at the same address as in Flash Player. That is checked, not assumed: the thread is
 * only started when Flash Player has the very same winmm module loaded at the very same base.
 *
 * DB_FLASH_TIMER=0 on the launcher leaves Flash Player's timer alone.
 */

const TIMER_PERIOD_MS = 1;

// PowerShell 2.0 (Windows 7) compiles Add-Type with C# 2, hence the plain loops and no `var`.
// It runs from a .ps1 file with -File, like lib/windowTitle.js, and never -EncodedCommand.
const WINDOWS_SCRIPT = `
param([int]$GamePid, [int]$Period)
Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class DungeonBlitzFlashTimer {
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr LoadLibrary(string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetProcAddress(IntPtr module, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateRemoteThread(IntPtr process, IntPtr attributes, uint stack, IntPtr start, IntPtr parameter, uint flags, IntPtr id);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeThread(IntPtr thread, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    // CREATE_THREAD | VM_OPERATION | VM_READ | VM_WRITE | QUERY_INFORMATION: what CreateRemoteThread asks for.
    const uint ACCESS = 0x0002 | 0x0008 | 0x0010 | 0x0020 | 0x0400;

    static ProcessModule Holding(Process process, long address) {
        foreach (ProcessModule module in process.Modules) {
            long start = module.BaseAddress.ToInt64();
            if (address >= start && address < start + module.ModuleMemorySize) { return module; }
        }
        return null;
    }

    public static string Run(int pid, int period) {
        if (IntPtr.Size != 4) { return "skipped: not a 32-bit PowerShell"; }
        IntPtr start = GetProcAddress(LoadLibrary("winmm.dll"), "timeBeginPeriod");
        if (start == IntPtr.Zero) { return "skipped: no timeBeginPeriod here"; }
        ProcessModule own = Holding(Process.GetCurrentProcess(), start.ToInt64());
        if (own == null) { return "skipped: timeBeginPeriod is in no module"; }

        // Flash Player has only just been started: wait for it to have its modules loaded.
        ProcessModule theirs = null;
        for (int attempt = 0; attempt < 40 && theirs == null; attempt++) {
            try {
                Process game = Process.GetProcessById(pid);
                if (game.HasExited) { return "skipped: Flash Player exited"; }
                foreach (ProcessModule module in game.Modules) {
                    if (string.Equals(module.FileName, own.FileName, StringComparison.OrdinalIgnoreCase)) { theirs = module; break; }
                }
            } catch (ArgumentException) {
                return "skipped: Flash Player exited";
            } catch (Exception) {
                // Not readable yet (a process this young answers with a partial copy).
            }
            if (theirs == null) { Thread.Sleep(250); }
        }
        if (theirs == null) { return "skipped: Flash Player has no " + own.ModuleName + " loaded"; }
        if (theirs.BaseAddress != own.BaseAddress) { return "skipped: " + own.ModuleName + " is at another address in Flash Player"; }

        IntPtr handle = OpenProcess(ACCESS, false, pid);
        if (handle == IntPtr.Zero) { return "failed: OpenProcess error " + Marshal.GetLastWin32Error(); }
        try {
            IntPtr thread = CreateRemoteThread(handle, IntPtr.Zero, 0, start, new IntPtr(period), 0, IntPtr.Zero);
            if (thread == IntPtr.Zero) { return "failed: CreateRemoteThread error " + Marshal.GetLastWin32Error(); }
            try {
                if (WaitForSingleObject(thread, 5000) != 0) { return "failed: timeBeginPeriod did not return"; }
                uint code;
                GetExitCodeThread(thread, out code);
                return code == 0 ? "ok: " + period + " ms" : "failed: timeBeginPeriod returned " + code;
            } finally {
                CloseHandle(thread);
            }
        } finally {
            CloseHandle(handle);
        }
    }
}
"@
[Console]::Out.WriteLine([DungeonBlitzFlashTimer]::Run($GamePid, $Period))
`;

/**
 * The 32-bit PowerShell: SysWOW64's on 64-bit Windows; on 32-bit Windows the only one there
 * is, which is 32-bit already.
 */
function powershell32(env = process.env, exists = fs.existsSync) {
    const windows = env.SystemRoot || env.windir || 'C:\\Windows';
    const wow64 = path.win32.join(windows, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return exists(wow64) ? wow64 : path.win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Asks the Flash Player process `pid` for a 1 ms timer. Runs once and finishes on its own;
 * `onResult` gets PowerShell's one-line answer ("ok: 1 ms", "skipped: ...", "failed: ...").
 *
 * @returns {{ method: string }} what was done, for the log.
 */
function boostFlashTimer(pid, { platform = process.platform, env = process.env, spawnImpl = spawn, onResult = () => {} } = {}) {
    if (platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) {
        return { method: 'none' };
    }
    if (env.DB_FLASH_TIMER === '0') {
        return { method: 'off' };
    }

    let directory;
    let child;
    try {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dungeon-blitz-timer-'));
        const script = path.join(directory, 'timer.ps1');
        fs.writeFileSync(script, WINDOWS_SCRIPT);
        child = spawnImpl(
            powershell32(env),
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, String(pid), String(TIMER_PERIOD_MS)],
            { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
        );
    } catch (error) {
        onResult(`failed: ${(error && error.message) || error}`);
        return { method: 'none' };
    }

    let output = '';
    if (child.stdout) {
        child.stdout.on('data', (chunk) => {
            output += chunk.toString();
        });
    }
    child.on('error', (error) => {
        onResult(`failed: ${(error && error.message) || error}`);
    });
    child.on('exit', () => {
        try {
            fs.rmSync(directory, { recursive: true, force: true });
        } catch {
            // Best effort: it is a temp folder.
        }
        onResult(output.trim() || 'failed: no answer from PowerShell');
    });
    return { method: 'win32-timebeginperiod' };
}

module.exports = { TIMER_PERIOD_MS, WINDOWS_SCRIPT, boostFlashTimer, powershell32 };
