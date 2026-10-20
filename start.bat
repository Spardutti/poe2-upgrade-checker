@echo off
cd /d "%~dp0"
where npm >nul 2>nul || (echo Node.js is not installed. Get the LTS version from https://nodejs.org && pause && exit /b 1)
if not exist node_modules\electron (
  echo Installing Electron, first run only...
  call npm install --no-audit --no-fund
)
start "" npx electron .
