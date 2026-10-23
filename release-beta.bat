@echo off
REM A test version for testers (e.g. 0.5.0-beta.1): published as a GitHub pre-release, so installed
REM copies of the normal version do NOT update to it. Later, release.bat publishes the finished version.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\release.ps1" -Beta %*
echo.
pause
