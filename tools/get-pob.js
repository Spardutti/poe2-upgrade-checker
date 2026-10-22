#!/usr/bin/env node
'use strict';
// Fetches the pinned Path of Building (PoE2) version into vendor/pob and builds pobhost.exe.
// Only the parts the calculations need are downloaded (Lua + data, no images): about 50 MB.
// Run by test-build.bat, build-exe.bat and the release build. Safe to run again: it skips
// the download when the right version is already there.
//
//   node tools/get-pob.js            fetch if needed, build the host
//   node tools/get-pob.js --force    fetch again

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const POB_REPO = 'https://github.com/PathOfBuildingCommunity/PathOfBuilding-PoE2.git';
const POB_TAG = 'v0.23.1'; // update together with a test run against a real build
const ROOT = path.join(__dirname, '..');
const DEST = path.join(ROOT, 'vendor', 'pob');
const STAMP = path.join(DEST, '.pob-version');

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

function fetchPob() {
  if (!process.argv.includes('--force') && fs.existsSync(STAMP) && fs.readFileSync(STAMP, 'utf8').trim() === POB_TAG) {
    console.log(`Path of Building ${POB_TAG} is already in vendor/pob.`);
    return;
  }
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch (_) {
    console.error('Git is needed to download Path of Building: https://git-scm.com/download/win');
    process.exit(1);
  }
  fs.rmSync(DEST, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(DEST), { recursive: true });
  console.log(`Downloading Path of Building ${POB_TAG} (Lua and data only)...`);
  run('git', ['clone', '--quiet', '--depth', '1', '--branch', POB_TAG, '--filter=blob:none', '--no-checkout', POB_REPO, DEST]);
  run('git', ['-C', DEST, 'sparse-checkout', 'set', '--no-cone',
    '/src/**/*.lua', '/src/**/*.json', '!/src/Export/',
    '/runtime/lua/', '/runtime/lua51.dll', '/runtime/lua-utf8.dll', '/runtime/vcruntime140.dll',
    '/LICENSE.md', '/manifest.xml']);
  run('git', ['-C', DEST, 'checkout', '--quiet']);
  fs.rmSync(path.join(DEST, '.git'), { recursive: true, force: true });
  fs.writeFileSync(STAMP, POB_TAG + '\n');
}

// pobhost.exe: compiled with the C# compiler that comes with Windows (.NET Framework 4)
function buildHost() {
  if (process.platform !== 'win32') { console.log('Not on Windows: skipping pobhost.exe (use LuaJIT directly for testing).'); return; }
  const out = path.join(DEST, 'runtime', 'pobhost.exe');
  const src = path.join(ROOT, 'pob', 'pobhost.cs');
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs > fs.statSync(src).mtimeMs) { console.log('pobhost.exe is up to date.'); return; }
  const win = process.env.WINDIR || 'C:\\Windows';
  const csc = [path.join(win, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), path.join(win, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')].find((p) => fs.existsSync(p));
  if (!csc) { console.error('The C# compiler that ships with Windows (.NET Framework 4) was not found, so the Path of Building engine is left out.'); process.exit(1); }
  run(csc, ['/nologo', '/optimize+', '/platform:x64', '/target:exe', `/out:${out}`, src]);
  console.log('Built pobhost.exe.');
}

fetchPob();
buildHost();
