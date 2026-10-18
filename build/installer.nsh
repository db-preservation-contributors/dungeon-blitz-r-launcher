; Included into the NSIS installer by electron-builder (`build.nsis.include` in package.json).
; The portable target does not use it.
;
; Refuse to install on Windows older than 10, and on 7, 8 and 8.1 point to the Windows 7
; build, which build/installer-win7.nsh installs.
;
; Electron 23 and later do not run on Windows 7, 8 or 8.1, so this launcher does not start
; there. Launchers already installed on those machines (1.1.0 and earlier, Electron 11) still
; auto-update: electron-updater downloads this installer in the background and runs it,
; `--updated --force-run` when the player clicks "Restart to update" and `--updated /S` on
; quit. Without this check either run would replace a working launcher with one that cannot
; start.
;
; customInit is inserted at the end of `.onInit`, after `initMultiUser` (which only reads
; the registry) and before the install section, where `uninstallOldVersion` runs. Quitting
; here therefore leaves the existing install, its shortcuts and its uninstaller untouched.
; The uninstaller build path (BUILD_UNINSTALLER) never reaches customInit.

!include LogicLib.nsh
!include WinVer.nsh

!macro customInit
  ${IfNot} ${AtLeastWin10}
    ${If} ${AtLeastWin7}
      ; Windows 7, 8 and 8.1 have a build of their own (build/win7.config.js): point there.
      ; /SD IDNO: a silent run (/S, the install-on-quit path) opens nothing and just exits.
      MessageBox MB_YESNO|MB_ICONSTOP|MB_TOPMOST "${PRODUCT_NAME} ${VERSION} needs Windows 10 or later.$\r$\n$\r$\nNothing was installed or changed: your current launcher still works.$\r$\n$\r$\nFor Windows 7, 8 and 8.1, download DungeonBlitzR-Launcher-${VERSION}-win7-x64-setup.exe (or win7-ia32 on 32-bit Windows) from the releases page. It installs over your current launcher.$\r$\n$\r$\nOpen the releases page now?" /SD IDNO IDNO win7Done
        ExecShell "open" "https://github.com/theminesastudios/dungeon-blitz-r-launcher/releases/latest"
      win7Done:
    ${Else}
      ; /SD IDOK: shown when the player is there (a manual run, or "Restart to update"),
      ; skipped on a silent run (/S, the install-on-quit path), which just exits.
      MessageBox MB_OK|MB_ICONSTOP|MB_TOPMOST "${PRODUCT_NAME} ${VERSION} needs Windows 10 or later.$\r$\n$\r$\nNothing was installed or changed: your current launcher still works. Start it again from the Start menu or your desktop shortcut." /SD IDOK
    ${EndIf}
    SetErrorLevel 1
    Quit
  ${EndIf}
!macroend
