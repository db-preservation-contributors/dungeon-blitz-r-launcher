
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
