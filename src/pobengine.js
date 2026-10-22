'use strict';

// Runs Path of Building's calculations in a child process (pob/server.lua inside PoB's own
// LuaJIT, hosted by pobhost.exe on Windows) and asks it what an item would change on your build.
//
//   const eng = createEngine({ log, appPath, resourcesPath, packaged })
//   await eng.loadBuild(xml)            -> { className, ascendancy, level, mainSkill, stats }
//   await eng.evalItems([{ slot, text }]) -> [{ ok, slot, before, after } | { ok:false, error }]
//
// The process starts on first use, is restarted if it dies, and is stopped after a while
// without requests to give the memory back.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

function createEngine({ log = () => {}, appPath, resourcesPath, packaged }) {
  const base = packaged ? path.join(resourcesPath, 'pob') : path.join(appPath, 'vendor', 'pob');
  const serverLua = packaged ? path.join(resourcesPath, 'pob', 'server.lua') : path.join(appPath, 'pob', 'server.lua');
  const srcDir = path.join(base, 'src');
  const runtimeDir = path.join(base, 'runtime');

  let proc = null; let ready = null; let buf = ''; let nextId = 1;
  const waiting = new Map();
  let buildXml = null; let buildInfo = null; let loading = null;
  let idleTimer = null;
  let lastError = null;

  function hostCommand() {
    // paths relative to PoB's src folder (the working directory): Lua opens files with ANSI paths,
    // which breaks on Windows user names outside the system code page
    const script = path.relative(srcDir, serverLua);
    if (process.env.POB_LUAJIT) return { cmd: process.env.POB_LUAJIT, args: [script] }; // dev/test on Linux
    if (process.platform === 'win32') return { cmd: path.join(runtimeDir, 'pobhost.exe'), args: [script] };
    return null;
  }

  function available() {
    const h = hostCommand();
    return !!(h && fs.existsSync(h.cmd) && fs.existsSync(path.join(srcDir, 'HeadlessWrapper.lua')) && fs.existsSync(serverLua));
  }

  function failAll(err) {
    for (const [, w] of waiting) { clearTimeout(w.timer); w.reject(err); }
    waiting.clear();
  }

  let failedAt = 0;
  function start() {
    if (ready) return ready;
    // don't keep trying (and waiting) when it just failed to start
    if (failedAt && Date.now() - failedAt < 10 * 60000) return Promise.reject(new Error('Path of Building failed to start: ' + (lastError || 'unknown error')));
    const h = hostCommand();
    if (!available()) return Promise.reject(new Error('The Path of Building engine is not installed with this copy of the app.'));
    ready = new Promise((resolve, reject) => {
      const t0 = Date.now();
      log('pob: starting the Path of Building engine');
      proc = spawn(h.cmd, h.args, {
        cwd: srcDir, windowsHide: true,
        env: (() => { const rt = path.relative(srcDir, runtimeDir); return { ...process.env, POBHOST_DIR: process.env.POBHOST_DIR || rt, POB_LUA_PATH: [path.join(rt, 'lua', '?.lua'), path.join(rt, 'lua', '?', 'init.lua')].join(';') }; })(),
      });
      proc.stdin.on('error', (err) => log('pob: ' + err.message));
      let started = false;
      const startTimer = setTimeout(() => { if (!started) { lastError = 'Path of Building took too long to start' + (errTail ? ': ' + errTail.trim().split('\n').slice(-4).join(' | ') : ''); log('pob: ' + lastError); reject(new Error(lastError)); stop(); } }, 90000);
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
          if (!line.startsWith('@@')) continue;
          let msg; try { msg = JSON.parse(line.slice(2)); } catch (_) { continue; }
          if (msg.ready === false) { lastError = String(msg.error || 'unknown error').split('\n').filter(Boolean).slice(0, 4).join(' | '); log('pob: Path of Building could not start: ' + lastError); clearTimeout(startTimer); reject(new Error('Path of Building could not start: ' + lastError)); continue; }
          if (msg.ready) { started = true; clearTimeout(startTimer); log(`pob: engine ready (PoB ${msg.version || '?'}, ${Date.now() - t0} ms)`); resolve(msg); continue; }
          const w = waiting.get(msg.id);
          if (w) { waiting.delete(msg.id); clearTimeout(w.timer); w.resolve(msg); }
        }
      });
      let errTail = '';
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (d) => { errTail = (errTail + d).slice(-2000); });
      proc.on('error', (err) => { lastError = err.message; log('pob: could not start: ' + err.message); if (!started) reject(err); });
      proc.on('exit', (code) => {
        log(`pob: engine stopped (${code})${code || !started ? ': ' + errTail.trim().split('\n').slice(-6).join(' | ') : ''}`);
        if (code && !started) { lastError = errTail.trim().split('\n').slice(-1)[0] || `exit ${code}`; reject(new Error('Path of Building failed to start: ' + lastError)); }
        failAll(new Error('The Path of Building engine stopped.'));
        proc = null; ready = null; buf = ''; buildInfo = null;
      });
    });
    ready.catch(() => { ready = null; failedAt = Date.now(); });
    return ready;
  }

  function stop() {
    if (proc) { try { proc.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n'); } catch (_) {} const p = proc; setTimeout(() => { try { p.kill(); } catch (_) {} }, 1500); }
  }

  function touch() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { log('pob: idle, stopping the engine'); stop(); }, 20 * 60000);
    if (idleTimer.unref) idleTimer.unref();
  }

  async function request(obj, timeoutMs = 60000) {
    await start();
    touch();
    // after a restart or a gear/build change: (re)load first, until the loaded build is the current one
    if (obj.cmd !== 'load' && obj.cmd !== 'equip') {
      for (let i = 0; i < 3 && buildXml && (!buildInfo || infoGen !== gen); i++) await (loading || loadBuild(buildXml));
    }
    if (!proc) throw new Error('The Path of Building engine stopped.');
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error('Path of Building did not answer in time.')); }, timeoutMs);
      waiting.set(id, { resolve, reject, timer });
      proc.stdin.write(JSON.stringify({ ...obj, id }) + '\n');
    });
  }

  // overrides: [{ slot, text }] items you copied in game, put into PoB's build after loading it
  let overrides = [];
  let gen = 0; let infoGen = -1; // which build/gear version is loaded
  function loadBuild(xml, over) {
    if (xml !== buildXml || over) gen++;
    buildXml = xml;
    if (over) overrides = over;
    buildInfo = null;
    const myGen = gen;
    const p = request({ cmd: 'load', xml }, 120000).then(async (r) => {
      if (!r.ok) throw new Error(r.error || 'Path of Building could not load the build.');
      r.pobGear = r.gear;
      if (overrides.length) {
        const e = await request({ cmd: 'equip', items: overrides }, 60000);
        if (e.ok) { e.pobGear = r.gear; e.pobStats = r.stats; r = e; }
      }
      if (myGen === gen) { buildInfo = r; infoGen = myGen; } // a newer build came in meanwhile: that one wins
      return r;
    }).finally(() => { if (loading === p) loading = null; });
    loading = p;
    return p;
  }
  // remember a build without starting the engine yet (it loads on first use)
  function setBuild(xml, over) { buildXml = xml; overrides = over || []; buildInfo = null; gen++; }
  function kill() { if (proc) { try { proc.kill(); } catch (_) {} } }

  async function evalItems(items) {
    if (!buildXml) throw new Error('No Path of Building build loaded.');
    const r = await request({ cmd: 'eval', items }, 30000 + items.length * 3000);
    if (!r.ok) throw new Error(r.error || 'Path of Building could not compare the items.');
    return r.results;
  }

  // PoB's own weighted trade search for a slot
  async function makeQuery(opts) {
    if (!buildXml) throw new Error('No Path of Building build loaded.');
    const r = await request({ cmd: 'query', ...opts }, 180000);
    if (!r.ok) throw new Error(r.error || 'Path of Building could not build a search.');
    return r;
  }

  return {
    available, start, stop, loadBuild, setBuild, evalItems, makeQuery,
    kill, sheet: async () => { if (!buildXml) return null; const r = await request({ cmd: "sheet" }, 60000); if (!r.ok) throw new Error(r.error || "Path of Building could not read the character."); return r; },
    ensureLoaded: async () => {
      if (!buildXml) return null;
      for (let i = 0; i < 3 && (!buildInfo || infoGen !== gen); i++) await (loading || loadBuild(buildXml));
      return buildInfo;
    },
    hasBuild: () => !!buildXml,
    info: () => buildInfo,
    lastError: () => lastError,
    paths: { base, srcDir, runtimeDir, serverLua },
  };
}

module.exports = { createEngine };
