#!/usr/bin/env node
'use strict';

/**
 * Makes the Windows 7 launcher loadable on Windows 7, and refuses one that is not.
 *
 * Windows loads every DLL an .exe imports before main() runs; one missing DLL or function and
 * the program does not start at all ("combase.dll was not found"). The `windows` crate under
 * Tauri imports CoTaskMemAlloc, CoTaskMemFree and CoCreateFreeThreadedMarshaler from
 * combase.dll, which Windows 8 introduced. Windows 7's ole32.dll exports the same three
 * functions (on Windows 8 and later ole32 forwards them to combase), so the import is renamed
 * to ole32.dll in place, and only when every function taken from it is one ole32 has on 7.
 *
 * Then every import is checked against the DLLs Windows 7 SP1 ships and a list of functions
 * Windows 8 and later added, so the workflow fails instead of a player's Windows 7.
 *
 * Usage: node tools/win7-imports.js <launcher.exe> [--check]   (--check: report only, no edit)
 */

const fs = require('fs');

const WIN7_DLLS = new Set([
    'advapi32.dll', 'bcrypt.dll', 'comctl32.dll', 'comdlg32.dll', 'crypt32.dll', 'dbghelp.dll',
    'dwmapi.dll', 'gdi32.dll', 'gdiplus.dll', 'imm32.dll', 'iphlpapi.dll', 'kernel32.dll',
    'msimg32.dll', 'ncrypt.dll', 'ntdll.dll', 'ole32.dll', 'oleacc.dll', 'oleaut32.dll',
    'pdh.dll', 'propsys.dll', 'psapi.dll', 'secur32.dll', 'setupapi.dll', 'shell32.dll',
    'shlwapi.dll', 'user32.dll', 'userenv.dll', 'uxtheme.dll', 'version.dll', 'winhttp.dll',
    'wininet.dll', 'winmm.dll', 'ws2_32.dll',
]);

// ole32.dll on Windows 7 exports these; anything else from combase.dll has no Windows 7 home.
const COMBASE_IN_OLE32 = new Set(['CoTaskMemAlloc', 'CoTaskMemFree', 'CoTaskMemRealloc', 'CoCreateFreeThreadedMarshaler', 'CoCreateGuid', 'CoInitializeEx', 'CoUninitialize', 'CoCreateInstance', 'CoGetApartmentType', 'CoWaitForMultipleHandles', 'PropVariantClear']);

// Functions Windows 8 or later added to DLLs that Windows 7 has.
const WIN8_FUNCTIONS = new Set([
    'AdjustWindowRectExForDpi', 'AreDpiAwarenessContextsEqual', 'CompareObjectHandles', 'CopyFile2',
    'CreateFile2', 'EnableMouseInPointer', 'EnableNonClientDpiScaling', 'GetAwarenessFromDpiAwarenessContext',
    'GetCurrentThreadStackLimits', 'GetDpiForSystem', 'GetDpiForWindow', 'GetOverlappedResultEx',
    'GetPointerType', 'GetPointerInfo', 'GetPointerTouchInfo', 'GetPointerPenInfo', 'GetSystemMetricsForDpi',
    'GetSystemTimePreciseAsFileTime', 'GetThreadDescription', 'GetWindowDpiAwarenessContext',
    'InitializeSynchronizationBarrier', 'ProcessPrng', 'SetProcessDpiAwarenessContext',
    'SetThreadDescription', 'SetThreadDpiAwarenessContext', 'WaitOnAddress', 'WakeByAddressAll',
    'WakeByAddressSingle', 'GetProcessMitigationPolicy', 'SetProcessMitigationPolicy',
]);

function parse(buf) {
    if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error('not a Windows program (no MZ header)');
    const pe = buf.readUInt32LE(0x3c);
    if (buf.readUInt32LE(pe) !== 0x00004550) throw new Error('no PE header');
    const sections = buf.readUInt16LE(pe + 6);
    const optSize = buf.readUInt16LE(pe + 20);
    const opt = pe + 24;
    const pe32plus = buf.readUInt16LE(opt) === 0x20b;
    const dirs = opt + (pe32plus ? 112 : 96);
    const table = opt + optSize;
    const secs = [];
    for (let i = 0; i < sections; i++) {
        const s = table + i * 40;
        secs.push({ va: buf.readUInt32LE(s + 12), vsize: buf.readUInt32LE(s + 8), raw: buf.readUInt32LE(s + 20), rsize: buf.readUInt32LE(s + 16) });
    }
    const off = (rva) => {
        const s = secs.find((x) => rva >= x.va && rva < x.va + Math.max(x.vsize, x.rsize));
        if (!s) throw new Error(`RVA 0x${rva.toString(16)} is in no section`);
        return rva - s.va + s.raw;
    };
    const cstr = (o) => buf.toString('latin1', o, buf.indexOf(0, o));
    const thunks = (rva) => {
        const names = [];
        if (!rva) return names;
        const size = pe32plus ? 8 : 4;
        for (let o = off(rva); ; o += size) {
            const v = pe32plus ? buf.readBigUInt64LE(o) : BigInt(buf.readUInt32LE(o));
            if (v === 0n) break;
            const ordinal = pe32plus ? v >> 63n : v >> 31n;
            names.push(ordinal ? `#${Number(v & 0xffffn)}` : cstr(off(Number(v & 0x7fffffffn)) + 2));
        }
        return names;
    };
    const imports = [];
    const importRva = buf.readUInt32LE(dirs + 8);
    if (importRva) {
        for (let d = off(importRva); buf.readUInt32LE(d + 12) !== 0; d += 20) {
            const nameOff = off(buf.readUInt32LE(d + 12));
            imports.push({ kind: 'import', nameOff, dll: cstr(nameOff), functions: thunks(buf.readUInt32LE(d) || buf.readUInt32LE(d + 16)) });
        }
    }
    const delayRva = buf.readUInt32LE(dirs + 13 * 8);
    if (delayRva) {
        for (let d = off(delayRva); buf.readUInt32LE(d + 4) !== 0; d += 32) {
            const nameOff = off(buf.readUInt32LE(d + 4));
            imports.push({ kind: 'delay', nameOff, dll: cstr(nameOff), functions: thunks(buf.readUInt32LE(d + 16)) });
        }
    }
    return imports;
}

function main() {
    const args = process.argv.slice(2);
    const file = args.find((a) => !a.startsWith('--'));
    const checkOnly = args.includes('--check');
    if (!file) {
        console.error('Usage: node tools/win7-imports.js <launcher.exe> [--check]');
        process.exit(1);
    }
    const buf = fs.readFileSync(file);
    const problems = [];
    let renamed = 0;
    for (const imp of parse(buf)) {
        const dll = imp.dll.toLowerCase();
        if (dll === 'combase.dll' && !checkOnly) {
            const missing = imp.functions.filter((f) => !COMBASE_IN_OLE32.has(f));
            if (missing.length) {
                problems.push(`combase.dll: ${missing.join(', ')} (not in Windows 7's ole32.dll)`);
                continue;
            }
            const name = Buffer.alloc(imp.dll.length, 0);
            name.write('ole32.dll', 'latin1');
            name.copy(buf, imp.nameOff);
            renamed++;
            console.log(`[win7-imports] combase.dll -> ole32.dll: ${imp.functions.join(', ')}`);
            continue;
        }
        if (imp.kind === 'import' && !WIN7_DLLS.has(dll)) {
            problems.push(`${imp.dll}: not on Windows 7 (${imp.functions.join(', ')})`);
        }
        const newer = imp.functions.filter((f) => WIN8_FUNCTIONS.has(f));
        if (imp.kind === 'import' && newer.length) problems.push(`${imp.dll}: ${newer.join(', ')} (Windows 8 or later)`);
    }
    if (problems.length) {
        console.error(`[win7-imports] ${file} would not start on Windows 7:`);
        for (const p of problems) console.error(`  - ${p}`);
        process.exit(1);
    }
    if (renamed) fs.writeFileSync(file, buf);
    // Read it back: the edited file must parse and import only Windows 7 DLLs.
    const after = parse(fs.readFileSync(file)).filter((i) => i.kind === 'import').map((i) => i.dll.toLowerCase());
    if (after.some((d) => !WIN7_DLLS.has(d))) {
        console.error(`[win7-imports] still imports: ${after.filter((d) => !WIN7_DLLS.has(d)).join(', ')}`);
        process.exit(1);
    }
    console.log(`[win7-imports] OK: ${[...new Set(after)].sort().join(', ')}`);
}

main();
