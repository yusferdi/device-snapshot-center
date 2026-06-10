@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
if exist "%SCRIPT_DIR%Device Snapshot Agent Manager.vbs" (
    start "" wscript.exe //nologo "%SCRIPT_DIR%Device Snapshot Agent Manager.vbs"
) else (
    start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -STA -File "%SCRIPT_DIR%native-manager.ps1"
)
exit /b
