#!/usr/bin/env node
'use strict';
// Fetches the pinned Path of Building (PoE2) version into vendor/pob and builds its host:
// pobhost.exe on Windows; on Linux, LuaJIT and the lua-utf8 module built from pinned sources
// (needs git, gcc and make) into vendor/pob/runtime/linux.
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

// Linux: the same LuaJIT 2.1 Path of Building ships for Windows, and lua-utf8 (its one native module)
const LUAJIT_REPO = 'https://github.com/LuaJIT/LuaJIT.git';
const LUAJIT_COMMIT = '95f931cb1ee7ab14f249d61fb3734803429025f8'; // v2.1 branch, tested with PoB 0.23.1
const LUAUTF8_REPO = 'https://github.com/starwing/luautf8.git';
const LUAUTF8_TAG = '0.1.6';
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
  if (process.platform !== 'win32') return;
  const out = path.join(DEST, 'runtime', 'pobhost.exe');
  const src = path.join(ROOT, 'pob', 'pobhost.cs');
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs > fs.statSync(src).mtimeMs) { console.log('pobhost.exe is up to date.'); return; }
  const win = process.env.WINDIR || 'C:\\Windows';
  const csc = [path.join(win, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), path.join(win, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')].find((p) => fs.existsSync(p));
  if (!csc) { console.error('The C# compiler that ships with Windows (.NET Framework 4) was not found, so the Path of Building engine is left out.'); process.exit(1); }
  run(csc, ['/nologo', '/optimize+', '/platform:x64', '/target:exe', `/out:${out}`, src]);
  console.log('Built pobhost.exe.');
}

// vendor/pob/runtime/linux/luajit and lua-utf8.so
function buildLinuxRuntime() {
  if (process.platform !== 'linux') return;
  const out = path.join(DEST, 'runtime', 'linux');
  const stamp = path.join(out, '.version');
  const want = `${LUAJIT_COMMIT} ${LUAUTF8_TAG}`;
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === want && fs.existsSync(path.join(out, 'luajit'))) { console.log('LuaJIT for Linux is up to date.'); return; }
  for (const tool of ['git', 'gcc', 'make']) {
    try { execFileSync(tool, ['--version'], { stdio: 'ignore' }); } catch (_) { console.error(`${tool} is needed to build the Path of Building engine on Linux (e.g. sudo apt install build-essential git).`); process.exit(1); }
  }
  const tmp = path.join(ROOT, 'vendor', 'build');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const lj = path.join(tmp, 'LuaJIT');
  console.log('Building LuaJIT...');
  run('git', ['init', '--quiet', lj]);
  run('git', ['-C', lj, 'fetch', '--quiet', '--depth', '1', LUAJIT_REPO, LUAJIT_COMMIT]);
  run('git', ['-C', lj, 'checkout', '--quiet', 'FETCH_HEAD']);
  // static, no shared libluajit: one file that runs on any x64 Linux of the same age or newer
  run('make', ['-C', lj, '-j4', 'BUILDMODE=static'], { stdio: ['ignore', 'ignore', 'inherit'] });
  const lu = path.join(tmp, 'luautf8');
  run('git', ['clone', '--quiet', '--depth', '1', '--branch', LUAUTF8_TAG, LUAUTF8_REPO, lu]);
  fs.mkdirSync(out, { recursive: true });
  run('gcc', ['-O2', '-shared', '-fPIC', '-I', path.join(lj, 'src'), path.join(lu, 'lutf8lib.c'), '-o', path.join(out, 'lua-utf8.so')]);
  fs.copyFileSync(path.join(lj, 'src', 'luajit'), path.join(out, 'luajit'));
  fs.chmodSync(path.join(out, 'luajit'), 0o755);
  fs.writeFileSync(stamp, want + '\n');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('Built LuaJIT and lua-utf8 for Linux.');
}

fetchPob();
buildHost();
buildLinuxRuntime();
