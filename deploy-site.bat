@echo off
rem Publishes the website in the "site" folder to poe2upgrade.com
rem (the Cloudflare Worker "rough-sun-a9b2", set up in wrangler.site.jsonc).
rem The first time, a browser opens so you can log in to Cloudflare.
cd /d "%~dp0"
set NODEMAJOR=
for /f "tokens=1 delims=v." %%a in ('node -v 2^>NUL') do set NODEMAJOR=%%a
if not defined NODEMAJOR goto nonode
if %NODEMAJOR% LSS 22 goto oldnode
set W=npx --yes wrangler@4
call %W% whoami 2>&1 | findstr /i /c:"not authenticated" >NUL && call %W% login
call %W% deploy --config wrangler.site.jsonc
if errorlevel 1 goto failed
echo.
echo Done. The site is live at https://poe2upgrade.com
pause
exit /b 0
:nonode
echo Node.js isn't installed. Install the LTS version from https://nodejs.org, then run this again.
pause
exit /b 1
:oldnode
echo Cloudflare's upload tool needs Node.js 22 or newer, and this PC has Node %NODEMAJOR%.
echo Install the current LTS from https://nodejs.org (or run: winget install OpenJS.NodeJS.LTS),
echo then open a new Command Prompt and run this again.
pause
exit /b 1
:failed
echo.
echo The upload didn't work - see the messages above. The live site wasn't changed.
pause
exit /b 1
