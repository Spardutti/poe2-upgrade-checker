@echo off
REM Uploads this folder to GitHub and publishes the version in package.json as a release.
REM GitHub then builds the installer, and installed copies update themselves.
cd /d "%~dp0"
where git >nul 2>nul || (echo Git isn't installed. Get it from https://git-scm.com/download/win ^(default options are fine^), then run this again. & pause & exit /b 1)
for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "(Get-Content package.json -Raw | ConvertFrom-Json).version"`) do set VER=%%v
echo Releasing version %VER%...
if not exist .git git init -b main
if not exist .github\workflows mkdir .github\workflows
copy /y ci\release.yml .github\workflows\release.yml >nul
git remote get-url origin >nul 2>nul || git remote add origin https://github.com/ets-public/poe2-upgrade-checker.git
git add -A
git -c user.name="ets-public" -c user.email="ets-public@users.noreply.github.com" commit -q -m "Version %VER%" 2>nul
git branch -M main
echo (If a GitHub sign-in window opens, sign in as ets-public.)
git push -u origin main || (echo Push failed - see the message above. & pause & exit /b 1)
git rev-parse -q --verify "refs/tags/v%VER%" >nul && (echo Version %VER% was already released. Bump "version" in package.json for a new one. & pause & exit /b 0)
git tag v%VER%
git push origin v%VER% || (echo Tag push failed. & pause & exit /b 1)
echo.
echo Done. GitHub is building version %VER% now ^(about 5-10 minutes^):
echo https://github.com/ets-public/poe2-upgrade-checker/actions
start "" https://github.com/ets-public/poe2-upgrade-checker/actions
pause
