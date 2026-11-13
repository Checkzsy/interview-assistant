# electron-builder custom NSIS script (wired in via build.nsis.include).
#
# Why: 1.2.x / 1.3.0 resolved the knowledge base against backend_root(), so
# kb.sqlite and the uploaded kb/ documents landed in
# $INSTDIR\resources\backend\_internal\data. Installing a newer version runs the
# old uninstaller first (uninstallOldVersion -> RMDir /r $INSTDIR), which deleted
# those files. The fixed backend resolves them under IA_DATA_DIR (%APPDATA%
# userData), so this hook copies the legacy directory across.
#
# It runs from .onInit, which is before uninstallOldVersion, and only when the
# userData copy does not exist yet, so a newer copy is never overwritten. On a
# fresh install the legacy path is absent and the macro does nothing.
#
# Keep this file ASCII-only: NSIS reads included files with the system ANSI code
# page, not -INPUTCHARSET, so UTF-8 comments fail to compile on non-UTF-8 hosts.

!macro customInit
  StrCpy $R8 "$APPDATA\${APP_PACKAGE_NAME}\data"
  ${IfNot} ${FileExists} `$R8\kb.sqlite`
    StrCpy $R9 ""
    ${If} ${FileExists} `$INSTDIR\resources\backend\_internal\data\kb.sqlite`
      StrCpy $R9 "$INSTDIR\resources\backend\_internal\data"
    ${ElseIf} ${FileExists} `$INSTDIR\resources\backend\data\kb.sqlite`
      StrCpy $R9 "$INSTDIR\resources\backend\data"
    ${EndIf}
    ${If} $R9 != ""
      DetailPrint "Migrating legacy knowledge base: $R9 -> $R8"
      nsExec::Exec `"$SYSDIR\robocopy.exe" "$R9" "$R8" /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP`
      Pop $R7
    ${EndIf}
  ${EndIf}
!macroend
