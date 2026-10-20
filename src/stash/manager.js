'use strict';

// Stash value: wires the screen reader, prices and ledger into the app.
//  - Scan hotkey (default Ctrl+Shift+S): open a specialty tab in game, press it, done.
//  - Your listed items on the trade site (by account name), valued at market price where possible.
//  - Items you add from the popup (uniques follow poe.ninja; others use your price check).
//  - History, session profit, profit per hour, and a feed of what changed.

const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const ledger = require('./ledger');
const prices = require('./prices');
const vision = require('./vision');

const HOUR = 3600000;

function create(deps) {
  const { store, log, getJson, ipcMain, globalShortcut, desktopCapturer, screen, nativeImage, app } = deps;
  let worker = null; let seq = 0; const pending = new Map();
  let lastScan = null; // { tab, scale, origin, display, at, image }
  let priceFetch = null;
  let scanning = false;
  let hotkey = null;

  const state = () => {
    if (!store.data.stash) store.data.stash = ledger.emptyState();
    const s = store.data.stash;
    for (const [k, v] of Object.entries(ledger.emptyState())) if (s[k] === undefined) s[k] = v;
    return s;
  };
  const cfg = () => store.data.stashConfig || (store.data.stashConfig = { scales: {}, learned: {}, labels: {} });
  const index = () => store.data.stashPrices || null;
  // Apply a change that isn't income (adding/removing things, corrections), then save.
  function booked(fn) {
    const s = state(); const idx = index();
    const before = ledger.valuate(s, idx).total;
    const out = fn(s, idx);
    const after = ledger.valuate(s, idx).total;
    ledger.adjust(s, after - before);
    ledger.recordHistory(s, after);
    store.save(); deps.changed();
    return out;
  }

  // ---------- worker ----------
  function workerPath() {
    // packaged: worker files are unpacked from the asar archive (see build.asarUnpack)
    return path.join(__dirname, 'worker.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  }
  function getWorker() {
    if (worker) return worker;
    worker = new Worker(workerPath());
    worker.on('message', (m) => { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error)); });
    worker.on('error', (err) => { log('stash worker: ' + (err.stack || err)); for (const p of pending.values()) p.reject(err); pending.clear(); worker = null; });
    worker.on('exit', () => { worker = null; });
    return worker;
  }
  function runVision(img, opts, learned, layouts) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      const buffer = img.data.buffer.slice(img.data.byteOffset, img.data.byteOffset + img.data.byteLength);
      getWorker().postMessage({ id, width: img.width, height: img.height, buffer, opts, learned, layouts }, [buffer]);
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('The stash reader took too long.')); } }, 60000);
    });
  }

  // Layouts with your own slot names on top (taught by hovering a slot and pressing Ctrl+C).
  function layouts() {
    const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'assets', 'layouts.json'), 'utf8'));
    const labels = cfg().labels || {};
    return base.map((L) => (labels[L.name] ? { ...L, slots: { ...L.slots, ...labels[L.name] } } : L));
  }

  // ---------- prices ----------
  async function refreshPrices(force) {
    const cur = index();
    const league = await deps.ninjaLeague();
    if (!force && cur && cur.league === league && Date.now() - cur.fetched < HOUR) return cur;
    if (priceFetch) return priceFetch;
    priceFetch = (async () => {
      const got = await prices.fetchAll(league, getJson, log);
      if (got.count > 0) { store.data.stashPrices = got; store.save(); log(`stash prices: ${got.count} items for ${league}${got.failed.length ? `, failed: ${got.failed.join(', ')}` : ''}`); }
      return index() || got;
    })();
    try { return await priceFetch; } finally { priceFetch = null; }
  }

  // ---------- capture ----------
  async function capture() {
    const pt = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(pt);
    const sf = display.scaleFactor || 1;
    const size = { width: Math.round(display.bounds.width * sf), height: Math.round(display.bounds.height * sf) };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    if (!src) throw new Error('Could not capture the screen.');
    const image = src.thumbnail;
    const { width, height } = image.getSize();
    if (!width || !height) throw new Error('The screen capture came back empty.');
    const bgra = image.toBitmap();
    const data = new Uint8ClampedArray(bgra.length);
    for (let i = 0; i < bgra.length; i += 4) { data[i] = bgra[i + 2]; data[i + 1] = bgra[i + 1]; data[i + 2] = bgra[i]; data[i + 3] = 255; }
    return { img: { width, height, data }, image, display, sf };
  }

  // merge templates learned in this scan into the saved ones for this screen size
  function learn(sizeKey, local, samples) {
    if (!local) return;
    const c = cfg(); const L = c.learned[sizeKey] || (c.learned[sizeKey] = {});
    for (const [d, t] of Object.entries(local)) {
      const n = Math.min(20, (L[d] && L[d].n) || 0); const add = Math.max(1, Math.min(5, (samples && samples[d]) || 1));
      if (!L[d]) { L[d] = { t, n: add }; continue; }
      L[d].t = L[d].t.map((v, i) => Math.round((v * n + t[i] * add) / (n + add)));
      L[d].n = n + add;
    }
  }

  // ---------- scan ----------
  async function scan(opts = {}) {
    if (scanning) return { ok: false, reason: 'Already reading the stash…' };
    scanning = true;
    const t0 = Date.now();
    try {
      if (deps.beforeCapture) await deps.beforeCapture();
      const { img, image, display } = await capture();
      const sizeKey = `${img.width}x${img.height}`;
      const c = cfg();
      const known = !opts.recalibrate && c.scales[sizeKey];
      const learned = c.learned[sizeKey] ? Object.fromEntries(Object.entries(c.learned[sizeKey]).map(([d, v]) => [d, v.t])) : null;
      const pricing = refreshPrices(false).catch((err) => { log('stash prices: ' + err.message); return index(); });
      let r = await runVision(img, known ? { scale: known, noSearch: true } : {}, learned, layouts());
      if (!r.ok && known) r = await runVision(img, {}, learned, layouts()); // UI scale changed? search again
      if (!r.ok) { log(`stash scan: ${r.reason} (${r.cells} cells, ${r.ms} ms)`); return { ok: false, reason: r.reason }; }
      c.scales[sizeKey] = r.scale;
      learn(sizeKey, r.localTemplates, r.samples);
      const idx = await pricing;
      const s = state();
      const beforeTotal = ledger.valuate(s, idx).total;
      const changes = ledger.applyScan(s, r.tab, r.counts, r.unreadable.map((u) => u.name), idx);
      let val = ledger.valuate(s, idx);
      // a tab seen for the first time is what you already had, not profit
      if (s.tabs[r.tab].first) ledger.adjust(s, val.total - beforeTotal);
      val = ledger.valuate(s, idx);
      ledger.recordHistory(s, val.total);
      store.save();
      const tab = val.tabs.find((t) => t.id === r.tab);
      lastScan = { tab: r.tab, scale: r.scale, origin: r.origin, display, at: Date.now(), image, unreadable: r.unreadable };
      log(`stash scan: ${r.tab} (${r.cells} cells, score ${r.score}, scale ${r.scale}) ${Object.keys(r.counts).length} items, ${r.unreadable.length} unreadable, ${Date.now() - t0} ms`);
      const res = {
        ok: true, tab: r.tab, label: ledger.tabLabel(r.tab), value: tab ? tab.value : 0, total: val.total, delta: val.total - beforeTotal,
        first: s.tabs[r.tab].first, changes: changes.slice(0, 6), unreadable: r.unreadable.map((u) => u.name), unpriced: tab ? tab.unpriced.length : 0,
        top: tab ? tab.lines.slice(0, 3).map((l) => ({ name: l.name, count: l.count, value: l.value })) : [], ms: Date.now() - t0,
      };
      deps.changed();
      return res;
    } catch (err) {
      log('stash scan failed: ' + (err.stack || err));
      return { ok: false, reason: 'Stash scan failed: ' + (err.message || err) };
    } finally { scanning = false; }
  }

  async function onHotkey() {
    deps.showToast({ kind: 'stash', loading: true, reason: 'Reading stash tab…' });
    const r = await scan();
    deps.showToast({ kind: 'stash', ...r, divineRate: store.settings.divineRate || null });
  }

  function registerHotkey() {
    if (hotkey) { try { globalShortcut.unregister(hotkey); } catch (_) { /* ignore */ } hotkey = null; }
    const accel = store.settings.stashHotkey === undefined ? 'Ctrl+Shift+S' : store.settings.stashHotkey;
    if (!accel) return { ok: true, accelerator: null };
    try {
      const ok = globalShortcut.register(accel, () => { onHotkey().catch((e) => log('stash hotkey: ' + e.message)); });
      if (ok) hotkey = accel;
      log(ok ? `stash hotkey ${accel} registered` : `stash hotkey ${accel} is taken`);
      return { ok, accelerator: accel };
    } catch (err) { return { ok: false, accelerator: accel, error: err.message }; }
  }

  // ---------- Ctrl+C on a stash slot: learn its name, fix its count ----------
  // Called for every copied item (gear or not). Returns a toast payload or null.
  function onItemCopied(text) {
    if (!lastScan || Date.now() - lastScan.at > 20 * 60000) return null;
    const lines = String(text).split(/\r?\n/).map((l) => l.trim());
    const rarity = (lines.find((l) => /^Rarity:/i.test(l)) || '').split(':')[1];
    if (!rarity || !/currency/i.test(rarity)) return null;
    const ri = lines.findIndex((l) => /^Rarity:/i.test(l));
    const name = lines[ri + 1];
    const stackLine = lines.find((l) => /^Stack Size:/i.test(l));
    const stack = stackLine ? Number(stackLine.split(':')[1].split('/')[0].replace(/[^\d]/g, '')) : null;
    if (!name) return null;
    const pt = screen.getCursorScreenPoint(); const d = lastScan.display;
    const sf = d.scaleFactor || 1;
    const px = (pt.x - d.bounds.x) * sf; const py = (pt.y - d.bounds.y) * sf;
    const L = layouts().find((l) => l.name === lastScan.tab);
    if (!L) return null;
    const key = vision.slotAt(L, lastScan.scale, lastScan.origin, px, py);
    if (!key) return null;
    const c = cfg(); const s = state();
    const before = ledger.valuate(s, index()).total;
    const msgs = [];
    const current = L.slots[key];
    if (!current || prices.norm(current) !== prices.norm(name)) {
      c.labels[L.name] = { ...(c.labels[L.name] || {}), [key]: name };
      msgs.push(current ? `This slot is ${name} (was labelled ${current}).` : `Learned this slot: ${name}.`);
      // move any count recorded under the old name
      const t = s.tabs[L.name];
      if (t && current && t.counts[current] != null && t.counts[name] == null) { t.counts[name] = t.counts[current]; delete t.counts[current]; }
    }
    const t = s.tabs[L.name];
    if (t && stack != null && Number.isFinite(stack) && t.counts[name] !== stack) {
      msgs.push(`Count fixed: ${t.counts[name] == null ? '?' : t.counts[name]} → ${stack}.`);
      t.counts[name] = stack;
      t.unreadable = (t.unreadable || []).filter((n) => n !== name);
    }
    if (!msgs.length) return null;
    const val = ledger.valuate(s, index());
    ledger.adjust(s, val.total - before);
    ledger.recordHistory(s, val.total);
    store.save(); deps.changed();
    return { kind: 'stash', ok: true, note: true, label: ledger.tabLabel(L.name), reason: msgs.join(' '), total: val.total, divineRate: store.settings.divineRate || null };
  }

  // ---------- your trade listings ----------
  async function refreshListings() {
    const account = String(store.settings.stashAccount || '').trim();
    if (!account) return { ok: false, error: 'Enter your account name (e.g. Name#1234) first.' };
    const league = await deps.tradeLeague();
    const body = { query: { status: { option: 'any' }, filters: { trade_filters: { filters: { account: { input: account } } } } }, sort: { price: 'asc' } };
    const r = await deps.runSearch(league, body, 'my listings');
    if (!r.ok) return { ok: false, error: r.error || 'Search failed.' };
    if (!r.searchId) return { ok: false, error: 'The trade site search could not be read in the app.' };
    const ids = (r.ids || []).slice(0, 100);
    const raw = ids.length ? await deps.fetchListings(league, r.searchId, ids) : [];
    const rates = deps.rates();
    const div = store.settings.divineRate || null;
    const items = raw.map((x) => {
      const it = (x && x.item) || {}; const L = (x && x.listing) || {};
      const ex = deps.priceInEx(L.price, rates);
      const isStack = Number(it.stackSize) > 0 || it.frameType === 5;
      return {
        id: x.id, name: deps.clean(it.name) || deps.clean(it.typeLine || it.baseType), base: deps.clean(it.typeLine || it.baseType) || null,
        rarity: ['Normal', 'Magic', 'Rare', 'Unique'][it.frameType] || (isStack ? 'Currency' : 'Rare'),
        stackSize: Number(it.stackSize) || null, isStack, priceText: deps.formatPrice(L.price), priceDiv: ex != null && div ? ex / div : null,
        stash: (L.stash && L.stash.name) || null, icon: it.icon || null,
      };
    });
    const s = state();
    const idx = await refreshPrices(false).catch(() => index());
    const fresh = !s.listings || s.listings.account !== account;
    const before = ledger.valuate(s, idx).total;
    s.listings = { account, league, fetchedAt: Date.now(), total: r.total, items, truncated: (r.total || 0) > ids.length };
    const val = ledger.valuate(s, idx);
    if (fresh) ledger.adjust(s, val.total - before);
    ledger.recordHistory(s, val.total);
    store.save(); deps.changed();
    return { ok: true, count: items.length, total: r.total, truncated: s.listings.truncated };
  }

  // ---------- items added by hand ----------
  function addItem(entry) {
    const s = state();
    const it = { id: 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: String(entry.name || 'Item').slice(0, 120), base: entry.base || null, rarity: entry.rarity || null,
      qty: Math.max(1, Number(entry.qty) || 1), div: entry.div != null ? Number(entry.div) : null, priceFrom: entry.priceFrom || 'manual', note: entry.note || null, addedAt: Date.now() };
    booked((st) => st.items.push(it));
    return it;
  }

  // ---------- status for the settings page ----------
  function status() {
    const s = state();
    const idx = index();
    const val = ledger.valuate(s, idx);
    const day = ledger.changeSince(s, val.total, 24 * HOUR);
    return {
      ...val, session: ledger.sessionStats(s, val.total), day,
      history: s.history.slice(-2000), feed: s.feed.slice(0, 60),
      account: store.settings.stashAccount || '', hotkey: hotkey || (store.settings.stashHotkey === '' ? '' : store.settings.stashHotkey || 'Ctrl+Shift+S'),
      hotkeyOk: !!hotkey, divineRate: store.settings.divineRate || null, pricesCount: idx ? Object.keys(idx.byName).length : 0,
      lastScan: lastScan ? { tab: lastScan.tab, at: lastScan.at, scale: lastScan.scale, unreadable: lastScan.unreadable.map((u) => u.name) } : null,
      calibrated: Object.keys(cfg().scales || {}), hiddenListings: !!(s.hidden && s.hidden.__listings),
    };
  }

  // ---------- IPC ----------
  ipcMain.handle('stash:status', () => JSON.parse(JSON.stringify(status())));
  ipcMain.handle('stash:scan', async (_e, o) => { const r = await scan(o || {}); deps.showToast({ kind: 'stash', ...r, divineRate: store.settings.divineRate || null }); return r; });
  ipcMain.handle('stash:prices', async () => { try { const i = await refreshPrices(true); deps.changed(); return { ok: true, count: Object.keys(i.byName).length, failed: i.failed || [] }; } catch (err) { return { ok: false, error: err.message }; } });
  ipcMain.handle('stash:listings', async () => { try { return await refreshListings(); } catch (err) { log('listings: ' + (err.stack || err)); return { ok: false, error: err.message || String(err) }; } });
  ipcMain.handle('stash:setCount', (_e, tab, name, count) => booked((s, idx) => {
    const t = s.tabs[tab]; if (!t) return false;
    const n = Math.max(0, Math.round(Number(count) || 0));
    const before = t.counts[name] || 0;
    t.counts[name] = n; t.unreadable = (t.unreadable || []).filter((x) => x !== name);
    if (before !== n) { const p = prices.lookup(idx, name); s.feed.unshift({ t: Date.now(), tab, name, from: before, to: n, delta: n - before, div: p ? p.div * (n - before) : null, manual: true }); }
    return true;
  }));
  ipcMain.handle('stash:removeTab', (_e, tab) => booked((s) => { delete s.tabs[tab]; return true; }));
  ipcMain.handle('stash:hide', (_e, id, hidden) => booked((s) => { s.hidden = { ...(s.hidden || {}), [id]: !!hidden }; return true; }));
  ipcMain.handle('stash:addItem', (_e, entry) => addItem(entry || {}));
  ipcMain.handle('stash:updateItem', (_e, id, patch) => booked((s) => {
    const it = s.items.find((x) => x.id === id); if (!it) return false;
    for (const k of ['name', 'qty', 'div', 'note']) if (patch && patch[k] !== undefined) it[k] = k === 'qty' ? Math.max(1, Number(patch[k]) || 1) : k === 'div' ? (patch[k] === '' || patch[k] == null ? null : Number(patch[k])) : patch[k];
    if (patch && patch.div !== undefined) it.priceFrom = 'manual';
    return true;
  }));
  ipcMain.handle('stash:removeItem', (_e, id) => booked((s) => { s.items = s.items.filter((x) => x.id !== id); return true; }));
  ipcMain.handle('stash:resetSession', () => { const s = state(); const v = ledger.valuate(s, index()).total; s.session = { start: Date.now(), startTotal: v, startAdj: s.adj || 0 }; store.save(); deps.changed(); return true; });
  ipcMain.handle('stash:setHotkey', (_e, accel) => { store.setSetting('stashHotkey', accel || ''); return registerHotkey(); });
  ipcMain.handle('stash:saveDebug', async () => {
    if (!lastScan || !lastScan.image) return { ok: false, error: 'Scan a tab first.' };
    const file = path.join(app.getPath('userData'), `stash-capture-${Date.now()}.png`);
    fs.writeFileSync(file, lastScan.image.toPNG());
    return { ok: true, file };
  });
  ipcMain.handle('stash:exportCsv', () => {
    const v = status();
    const rows = [['Source', 'Item', 'Count', 'Each (div)', 'Value (div)']];
    for (const t of v.tabs) for (const l of t.lines) rows.push([t.label, l.name, l.count, l.unit == null ? '' : l.unit.toFixed(4), l.value == null ? '' : l.value.toFixed(3)]);
    for (const l of v.listings.lines) rows.push(['Listed', l.name, l.stackSize || 1, '', l.value.toFixed(3)]);
    for (const l of v.items.lines) rows.push(['Added', l.name, l.qty, l.unit.toFixed(4), l.value.toFixed(3)]);
    const csv = rows.map((r) => r.map((x) => (/[",\n]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : x)).join(',')).join('\r\n');
    const file = path.join(app.getPath('userData'), `stash-value-${new Date().toISOString().slice(0, 10)}.csv`);
    fs.writeFileSync(file, csv);
    return { ok: true, file };
  });

  // start a session from the last known total
  const s0 = state();
  const v0 = ledger.valuate(s0, index()).total;
  s0.session = { start: Date.now(), startTotal: v0, startAdj: s0.adj || 0 };

  return { scan, registerHotkey, onItemCopied, refreshPrices, status, addItem, stop: () => { if (worker) worker.terminate(); } };
}

module.exports = { create };
