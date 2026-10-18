; Included into the Windows 7 build's NSIS installer instead of installer.nsh
; (`nsis.include` in build/win7.config.js). The portable target does not use it.
;
; Refuse to install on Windows older than 7.
;
; The Windows 7 build is the launcher on Electron 22, the last Electron that runs on Windows
; 7, 8 and 8.1, so unlike installer.nsh this one lets those through. It has the same appId,
; so it installs over a 1.1.0 launcher (or any later one) in place, keeping its shortcuts.
; Vista and XP have no Electron at all.
;
; customInit runs at the end of `.onInit`, before the install section, so quitting here
; leaves the existing install untouched (see installer.nsh).

!include LogicLib.nsh
!include WinVer.nsh

!macro customInit
  ${IfNot} ${AtLeastWin7}
    MessageBox MB_OK|MB_ICONSTOP|MB_TOPMOST "${PRODUCT_NAME} ${VERSION} needs Windows 7 or later.$\r$\nNothing was installed or changed." /SD IDOK
    SetErrorLevel 1
    Quit
  ${EndIf}
!macroend
