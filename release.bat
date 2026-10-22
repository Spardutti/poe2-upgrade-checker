@echo off
REM One click: picks the next version, writes the changelog, uploads to GitHub,
REM waits for GitHub to build the installer + portable .exe, then opens the release.
REM Details: tools\release.ps1. Options: release.bat -Version 0.5.0 / -Yes / -NoWait
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\release.ps1" %*
echo.
pause
