@echo off
REM Builds the app in the "dist" folder: an installer (auto-updates) and a portable .exe.
REM Normally you don't need this: new versions are built on GitHub and installed automatically.
cd /d "%~dp0"
where npm >nul 2>nul || (echo Node.js is needed once to build. Get the LTS version from https://nodejs.org && pause && exit /b 1)
call npm install --no-audit --no-fund
call node tools\get-pob.js || (echo Could not get Path of Building - see the messages above. & pause & exit /b 1)
call npx --yes electron-builder@26.18.0 --win nsis portable --publish never
echo.
echo Done. In the dist folder: run the Setup .exe to install (gets updates), or use the Portable .exe.
pause
