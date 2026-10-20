'use strict';

const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, Tray, Menu, clipboard, screen, ipcMain, globalShortcut, nativeImage, net, shell, desktopCapturer,
} = require('electron');
const stashLib = require('./stash/manager');
const stashPrices = require('./stash/prices');
const trade = require('./core/trade');
const rates = require('./core/rates');
const ignoreLib = require('./core/ignore');
const catalogLib = require('./core/catalog');
const listingLib = require('./core/listing');
const { suggestWeights } = require('./core/autoweights');
const gearLib = require('./core/gearscore');
const { parseItem } = require('./core/parser');
const { compare } = require('./core/scorer');
const { Store } = require('./core/store');
const { SLOTS, MAIN_SLOTS, SLOT_GROUPS, WEAKEST_OF, groupOf } = require('./core/slots');
const { KeySender } = require('./keysender');

if (!app.requestSingleInstanceLock()) { app.exit(0); }

let store;
let stash = null;
const lastWorth = new Map(); // item id -> typical price (ex) from "What's it worth?"
let tray;
let popup;
let settingsWin;
let lastClip = '';
let lastItem = null;
// Every copied item gets an id so buttons in the popup act on THAT item, even
// if you've copied something else (or tested an item in Settings) since.
let itemSeq = 0;
const recentItems = new Map();
function remember(item) {
  item.id = `c${Date.now().toString(36)}${(++itemSeq).toString(36)}`;
  item.copiedAt = Date.now();
  recentItems.set(item.id, item);
  while (recentItems.size > 30) recentItems.delete(recentItems.keys().next().value);
  lastItem = item;
  return item;
}
let hideTimer = null;
let popupHovered = false;

const ICON = path.join(__dirname, '..', 'assets', 'icon.png');

// ---------- log file (Tray -> Open log) ----------
let logFile = null;
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    if (!logFile) logFile = path.join(app.getPath('userData'), 'poe2-upgrade-checker.log');
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1024 * 1024) fs.writeFileSync(logFile, '');
    fs.appendFileSync(logFile, line);
  } catch (_) { /* ignore */ }
}
const preload = path.join(__dirname, 'preload.js');

function ignoreRules() { return ignoreLib.cleanRules(store.settings.ignoreStats); }
function gearOpts() {
  const rules = ignoreRules();
  return { build: store.settings.build || 'djinn-varashta', ignore: (k) => ignoreLib.isIgnored(rules, k), tweaks: store.settings.buildTweaks || {} };
}

// How much of each resistance an item in `slot` still needs to give before you
// hit the cap, from the resistances you entered (or imported from PoB):
// need = cap - (your total - what the item in that slot gives now).
const RES_EL = { Fire: 'fire', Cold: 'cold', Lightning: 'lightning', Chaos: 'chaos' };
function resNeedFor(slot) {
  const rs = store.settings.resists;
  if (!rs || !slot) return null;
  const cap = Number(rs.cap) > 0 ? Number(rs.cap) : 75;
  const cur = store.equipped[slot];
  const out = {};
  let any = false;
  for (const [El, el] of Object.entries(RES_EL)) {
    const total = Number(rs[el]);
    if (rs[el] === '' || rs[el] == null || !Number.isFinite(total)) continue;
    const fromSlot = cur && cur.stats ? (cur.stats[`#% to ${El} Resistance`] || 0) : 0;
    out[El] = Math.max(0, cap - (total - fromSlot));
    any = true;
  }
  return any ? out : null;
}

// gear score of `item` if it went in `slot` (defaults to the item's own slot)
function gearOf(item, slot) {
  if (!item || store.settings.build === 'off') return null;
  const target = slot || (item.slot && SLOT_GROUPS[item.slot] ? SLOT_GROUPS[item.slot][0] : item.slot);
  return gearLib.gearScore(item, { ...gearOpts(), resNeed: resNeedFor(target) });
}
// One verdict: when a build is chosen, UPGRADE/DOWNGRADE comes from the gear
// score (how useful the item is to your build). Your stat weights are only
// used when the build is turned off, or for "By my weights" searches.
function evaluate(item) {
  const rules = ignoreRules();
  const ignore = (k) => ignoreLib.isIgnored(rules, k);
  const r = compare(item, store.equipped, store.weights, { ignore });
  if (!r || !r.ok) return r;
  r.ignoring = ignoreLib.describe(rules);
  const gearOn = store.settings.build !== 'off';
  r.gear = gearOf(item, r.targetSlot);
  if (gearOn && r.gear && r.gear.score != null) {
    // rings / charms / jewels: compare with your weakest one by gear score
    const group = WEAKEST_OF.includes(item.slot) ? SLOT_GROUPS[item.slot] : null;
    if (group && group.every((sl) => store.equipped[sl]) && !r.isEquipped) {
      const scored = group.map((sl) => { const gg = gearOf(store.equipped[sl], sl); return [sl, gg && gg.score != null ? gg.score : 0]; });
      const weaker = scored.sort((a, b) => a[1] - b[1])[0][0];
      if (weaker !== r.targetSlot) {
        r.targetSlot = weaker;
        r.replacing = [store.equipped[weaker].name];
        r.rows = require('./core/scorer').diffStats(item.stats, store.equipped[weaker].stats, store.weights, ignore);
        r.gear = gearOf(item, weaker);
      }
    }
    const eqItem = store.equipped[r.targetSlot];
    const ge = r.isEquipped ? null : gearOf(eqItem, r.targetSlot);
    r.gearEquipped = ge;
    r.scoreMode = 'gear';
    if (!r.isEquipped && eqItem) {
      const yours = ge && ge.score != null ? ge.score : null;
      if (yours == null) { r.delta = null; r.verdict = 'same'; } else {
        r.delta = r.gear.score - yours;
        r.pct = null;
        r.verdict = r.delta >= 2 ? 'upgrade' : r.delta <= -2 ? 'downgrade' : 'same';
      }
    }
  } else {
    r.scoreMode = 'weights';
    r.gearEquipped = r.isEquipped ? null : gearOf(store.equipped[r.targetSlot], r.targetSlot);
  }
  // how much each changed stat matters to the build (for colours / top changes)
  const go = gearOpts();
  r.rows = r.rows.map((row) => ({ ...row, useful: gearOn ? gearLib.usefulness(item.slot, row.key, go) : (row.weight || 0) }))
    .sort((a, b) => Math.abs(b.diff * b.useful) - Math.abs(a.diff * a.useful) || Math.abs(b.diff) - Math.abs(a.diff));
  return r;
}

// ---------- popup ----------
//
// Bugs fixed here (popup only appeared once):
// 1. After popup.hide() Chromium throttles the hidden page, so the renderer's
//    requestAnimationFrame never fired and it never told us its height -> we
//    never showed it again. Now: backgroundThrottling off, the renderer
//    measures synchronously, and we show anyway after a short fallback delay.
// 2. Copying the SAME item twice gives identical clipboard text, which looked
//    like "no change". We now tag the clipboard after reading (adds a trailing
//    newline) so the game's next Ctrl+C is always seen as new.
// 3. The hover flag could stay stuck "on" after Esc, which disabled auto-hide.

let pendingShow = false;
let showFallback = null;

function createPopup() {
  popup = new BrowserWindow({
    width: 400, height: 300, show: false, frame: false, resizable: false,
    transparent: true, backgroundColor: '#00000000',
    alwaysOnTop: true, skipTaskbar: true, focusable: true, hasShadow: false,
    webPreferences: {
      preload, contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false,
    },
  });
  popup.setAlwaysOnTop(true, 'screen-saver');
  popup.loadFile(path.join(__dirname, 'ui', 'popup.html'));
  popup.on('blur', () => { if (!popupHovered) scheduleHide(1500); });
  popup.on('closed', () => { popup = null; });
  popup.webContents.on('render-process-gone', () => { try { popup.destroy(); } catch (_) {} popup = null; });
}

function uiScale() { const v = Number(store && store.settings.uiScale); return v >= 0.8 && v <= 1.6 ? v : 1; }
function popupWidth() { return Math.round(400 * uiScale()); }

// Where the popup goes (Options → Popup position): next to the mouse, or
// pinned to a side / the top of the screen so it never covers the game's tooltip.
function placePopupNearCursor(height) {
  const cursor = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(cursor).workArea;
  const w = popupWidth();
  const h = Math.max(120, Math.min(height || 300, area.height - 20));
  const pos = store.settings.popupPosition || 'cursor';
  let x; let y;
  if (pos === 'left') { x = area.x + 16; y = area.y + Math.round(area.height * 0.12); }
  else if (pos === 'right') { x = area.x + area.width - w - 16; y = area.y + Math.round(area.height * 0.12); }
  else if (pos === 'top') { x = area.x + Math.round((area.width - w) / 2); y = area.y + 16; }
  else {
    // Prefer the right of the cursor; flip left if it would go off screen.
    x = cursor.x + 24;
    if (x + w > area.x + area.width) x = cursor.x - w - 24;
    y = cursor.y - Math.round(h / 3);
  }
  x = Math.max(area.x + 4, Math.min(x, area.x + area.width - w - 4));
  y = Math.max(area.y + 4, Math.min(y, area.y + area.height - h - 4));
  popup.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: Math.round(h) });
  try { popup.webContents.setZoomFactor(uiScale()); } catch (_) { /* ignore */ }
}

function scheduleHide(ms) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hidePopup, ms);
}

function hidePopup() {
  clearTimeout(hideTimer);
  clearTimeout(showFallback);
  pendingShow = false;
  popupHovered = false;
  awaySince = 0;
  if (popup && popup.isVisible()) popup.hide();
}

// Close the popup once the mouse has moved well away from it for a moment
// (like other overlays do). No global Esc key: that stopped Esc working in game.
let awaySince = 0;
function watchCursor() {
  if (!popup || !popup.isVisible() || popupHovered || hotkeyBusy) { awaySince = 0; return; }
  // a pinned popup (left/right/top) isn't near the mouse by design: closes on timer, ×, or next item
  if ((store.settings.popupPosition || 'cursor') !== 'cursor') { awaySince = 0; return; }
  const c = screen.getCursorScreenPoint();
  const b = popup.getBounds();
  const pad = 260;
  const far = c.x < b.x - pad || c.x > b.x + b.width + pad || c.y < b.y - pad || c.y > b.y + b.height + pad;
  if (!far) { awaySince = 0; return; }
  if (!awaySince) awaySince = Date.now();
  if (Date.now() - awaySince > 1200) hidePopup();
}

function revealPopup(height) {
  clearTimeout(showFallback);
  if (!popup) return;
  if (pendingShow || !popup.isVisible()) {
    pendingShow = false;
    placePopupNearCursor(height);
    popup.showInactive(); // don't steal focus from the game
    popup.setAlwaysOnTop(true, 'screen-saver');
    awaySince = 0;
  } else if (height) {
    const b = popup.getBounds();
    popup.setBounds({ ...b, height: Math.round(Math.min(Math.max(height, 120), 900)) });
  }
  if (!popupHovered) scheduleHide((store.settings.autoHideSeconds || 12) * 1000);
}

let popupItem = null;
function showResult(result) {
  popupItem = result && result.item ? recentItems.get(result.item.id) || result.item : null;
  if (!popup) createPopup();
  pendingShow = true; // every new copy re-positions the popup at the cursor
  const send = () => popup && popup.webContents.send('popup:result', serialise(result));
  if (popup.webContents.isLoading()) popup.webContents.once('did-finish-load', send);
  else send();
  // Renderer replies with its height via popup:resize; show anyway if it doesn't.
  clearTimeout(showFallback);
  showFallback = setTimeout(() => { if (pendingShow) revealPopup(null); }, 400);
}

function serialise(result) {
  return JSON.parse(JSON.stringify({
    ...result, slots: SLOTS, slotGroups: SLOT_GROUPS, budgetLabel: trade.budgetLabel(budgetNow()),
    ui: { detail: store.settings.popupDetail || 'compact', colorblind: !!store.settings.colorblind, divineRate: store.settings.divineRate || null },
  }));
}

ipcMain.on('popup:resize', (_e, height) => revealPopup(Number(height) || null));

ipcMain.on('popup:hover', (_e, hovered) => {
  popupHovered = !!hovered;
  if (popupHovered) clearTimeout(hideTimer);
  else if (popup && popup.isVisible()) scheduleHide(2500);
});

ipcMain.on('popup:close', hidePopup);

// ---------- reading items ----------

const TAG = '\r\n';
let hotkeyBusy = false;
let keys = null;
let hotkeyStatus = { ok: false, accelerator: null, error: null };

// Shared by the hotkey and the clipboard watcher.
function handleItemText(text, source) {
  const item = parseItem(text);
  if (!item) {
    log(`${source}: clipboard is not item text: ${JSON.stringify(String(text).slice(0, 80))}`);
    return false;
  }
  // Tag the clipboard so copying the same item again still counts as a change.
  // (Just a trailing line break; pasting into the trade site / PoB is unaffected.)
  try { const tagged = text.endsWith(TAG) ? text : text + TAG; clipboard.writeText(tagged); lastClip = tagged; } catch (_) { lastClip = text; }
  // hovering a stash slot + Ctrl+C after a stash scan teaches/fixes that slot
  if (stash && !item.slot) {
    try { const t = stash.onItemCopied(text); if (t) { showResult(t); lastClip = text; return true; } } catch (err) { log('stash label: ' + err.message); }
  }
  if (!item.slot && source === 'clipboard') {
    // you copied currency, a gem, a map... with plain Ctrl+C: no popup
    log(`clipboard: ${item.itemClass} "${item.name}" – not gear, no popup`);
    lastClip = text;
    return true;
  }
  remember(item);
  store.noteStats(item);
  log(`${source}: ${item.itemClass} "${item.name}" (${item.rarity}) -> slot ${item.slot}, ${Object.keys(item.stats).length} stats`);
  notifySettings('item:copied', { id: item.id, name: item.name });
  try { showResult(evaluate(item)); } catch (err) { log('popup failed: ' + err.stack); }
  return true;
}

// Passive mode: notice when you press Ctrl+C in game yourself.
function pollClipboard() {
  if (!store || hotkeyBusy || store.settings.paused || store.settings.watchClipboard === false) return;
  let text;
  try { text = clipboard.readText(); } catch (_) { return; }
  if (!text || text === lastClip) return;
  lastClip = text;
  if (/^Item Class:/i.test(text.trim())) handleItemText(text, 'clipboard');
}

// Hotkey mode: press the hotkey over an item; we send Ctrl+C to the game for
// you (one keystroke per press) and always show the popup, even for the same item.
async function onHotkey() {
  if (hotkeyBusy || store.settings.paused) return;
  hotkeyBusy = true;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let before = '';
  try { before = clipboard.readText(); } catch (_) { /* ignore */ }
  try {
    clipboard.writeText('');
    const waitForText = async (ms) => {
      for (let t = 0; t < ms; t += 25) {
        await sleep(25);
        let v = '';
        try { v = clipboard.readText(); } catch (_) { v = ''; }
        if (v) return v;
      }
      return '';
    };
    // instant feedback while the game copies the item (~0.1–1s)
    showResult({ ok: false, loading: true, reason: 'Reading item…' });
    let sent = await keys.copy(!!store.settings.advancedCopy);
    if (!sent) log('hotkey: could not send Ctrl+C to the game');
    let text = await waitForText(450);
    if (!text && sent) {
      // The game sometimes misses the first copy (e.g. the tooltip wasn't up
      // yet). Copying is client-side only, so trying once more is harmless.
      log('hotkey: nothing copied, retrying once');
      sent = await keys.copy(!!store.settings.advancedCopy);
      text = await waitForText(900);
    }
    if (text && handleItemText(text, 'hotkey')) return;
    // Nothing copied: put the old clipboard back and say why.
    try { clipboard.writeText(before || ''); } catch (_) { /* ignore */ }
    lastClip = before || '';
    log(`hotkey: no item text (sent=${sent}, got ${text ? 'non-item text' : 'nothing'})`);
    showResult({
      ok: false,
      reason: sent
        ? 'No item found. Hover your mouse over an item in game, then press the hotkey.'
        : 'Couldn\'t send Ctrl+C to the game. Press Ctrl+C on the item yourself, or see Tray → Open log.',
    });
  } finally {
    hotkeyBusy = false;
  }
}

function registerHotkey(accel) {
  const want = accel || store.settings.hotkey || 'Ctrl+D';
  if (hotkeyStatus.accelerator) {
    try { globalShortcut.unregister(hotkeyStatus.accelerator); } catch (_) { /* ignore */ }
  }
  let ok = false; let error = null;
  try { ok = globalShortcut.register(want, () => { onHotkey().catch((e) => log('hotkey error: ' + e.stack)); }); } catch (err) { error = err.message; }
  if (!ok && !error) error = `${want} is already used by another program. Pick a different hotkey.`;
  hotkeyStatus = { ok, accelerator: ok ? want : null, error };
  log(`hotkey ${want}: ${ok ? 'registered' : 'FAILED ' + error}`);
  return hotkeyStatus;
}

ipcMain.handle('hotkey:set', (_e, accel) => {
  const prev = store.settings.hotkey || 'Ctrl+D';
  const st = registerHotkey(accel);
  if (st.ok) store.setSetting('hotkey', accel);
  else registerHotkey(prev); // put the old one back
  buildTrayMenu();
  return { ...st, accelerator: accel };
});

ipcMain.on('open:log', () => { if (logFile) shell.openPath(logFile); });

const SAMPLE_ITEM = 'Item Class: Helmets\nRarity: Rare\nTest Visage\nExpert Visored Helm\n--------\nArmour: 312\n--------\nItem Level: 79\n--------\n+89 to maximum Life\n+32% to Fire Resistance';
ipcMain.on('popup:test', () => {
  log('test popup requested');
  showResult(evaluate(parseItem(SAMPLE_ITEM)));
});

// ---------- shared IPC ----------

function notifySettings(channel, payload) {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send(channel, payload);
}

function resolveItem(target) {
  if (target && typeof target === 'object' && target.itemId) return recentItems.get(target.itemId) || null;
  if (target === '__last') return lastItem;
  if (WEAKEST_OF.includes(target)) {
    // your weakest ring / charm / jewel (by gear score, or weights if the build is off)
    const items = SLOT_GROUPS[target].map((sl) => store.equipped[sl]).filter(Boolean);
    if (!items.length) return null;
    const val = (it) => { const g = gearOf(it); if (g && g.score != null) return g.score; return require('./core/scorer').score(it, store.weights); };
    return items.slice().sort((a, b) => val(a) - val(b))[0];
  }
  return store.equipped[target] || null;
}

function refreshAll() {
  if (popupItem && popup && popup.isVisible()) {
    popup.webContents.send('popup:result', serialise(evaluate(popupItem)));
  }
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings:changed');
  if (resultsWin && !resultsWin.isDestroyed()) resultsWin.webContents.send('settings:changed');
}

ipcMain.handle('equip', (_e, slot, ref) => {
  let item = null;
  if (ref && typeof ref === 'object' && ref.itemId) item = recentItems.get(ref.itemId);
  else if (typeof ref === 'string' && ref) item = parseItem(ref);
  else item = lastItem;
  if (!item || !SLOTS.includes(slot)) return false;
  log(`equip ${slot}: "${item.name}"`);
  store.setEquipped(slot, item);
  store.noteStats(item);
  refreshAll();
  return true;
});

ipcMain.handle('weights:set', (_e, key, value) => { store.setWeight(key, value); refreshAll(); return true; });
ipcMain.handle('weights:replace', (_e, obj) => { store.replaceWeights(obj); refreshAll(); return true; });
ipcMain.handle('weights:suggest', () => {
  const rules = ignoreRules();
  return suggestWeights(store.equipped, (k) => ignoreLib.isIgnored(rules, k));
});
ipcMain.handle('weights:reset', () => { store.resetWeights(); refreshAll(); return true; });
ipcMain.handle('slot:clear', (_e, slot) => { store.setEquipped(slot, null); refreshAll(); return true; });
ipcMain.handle('setting:set', (_e, key, value) => {
  store.setSetting(key, value);
  if (key === 'startWithWindows') applyLoginItem();
  if (key === 'build' || key === 'colorblind' || key === 'popupDetail' || key === 'buildTweaks') refreshAll();
  if (key === 'resultsHotkey') registerResultsHotkey();
  if (key === 'autoUpdate' && autoUpdater) autoUpdater.autoDownload = value !== false;
  if (key === 'uiScale') { [settingsWin, resultsWin].forEach((w) => { try { if (w && !w.isDestroyed()) w.webContents.setZoomFactor(uiScale()); } catch (_) { /* ignore */ } }); }
  buildTrayMenu();
  return true;
});

// Stat database for the picker (trade site stat list + what you've seen per class).
ipcMain.handle('stats:catalog', async () => {
  try {
    const d = await loadTradeData(false);
    return { ok: true, ...catalogLib.buildCatalog(d.index, store.data.seenByClass) };
  } catch (err) {
    return { ok: false, error: 'Could not load the trade site stat list: ' + (err.message || err) };
  }
});

// ---------- characters ----------
ipcMain.handle('profiles:list', () => store.listProfiles());
ipcMain.handle('profiles:switch', (_e, id) => { const ok = store.switchProfile(id); log(`switched to character ${id}`); refreshAll(); buildTrayMenu(); return ok; });
ipcMain.handle('profiles:create', (_e, name, copy) => { const id = store.createProfile(name, copy); refreshAll(); return id; });
ipcMain.handle('profiles:rename', (_e, id, name) => { store.renameProfile(id, name); buildTrayMenu(); return true; });
ipcMain.handle('profiles:delete', (_e, id) => { const ok = store.deleteProfile(id); refreshAll(); return ok; });

// ---------- resistances ----------
ipcMain.handle('resists:set', (_e, r) => {
  const clean = {};
  for (const k of ['fire', 'cold', 'lightning', 'chaos', 'cap']) {
    const v = r && r[k] !== '' && r[k] != null ? Number(r[k]) : null;
    if (Number.isFinite(v)) clean[k] = v;
  }
  store.setSetting('resists', Object.keys(clean).some((k) => k !== 'cap') ? clean : null);
  refreshAll();
  return store.settings.resists;
});

// ---------- Path of Building import ----------
const pobLib = require('./core/pob');
ipcMain.handle('pob:import', async (_e, input) => {
  try {
    let code = String(input || '').trim();
    if (!code) return { ok: false, error: 'Paste a PoB code or a pobb.in link first.' };
    const raw = pobLib.pobbinRawUrl(code);
    if (raw) {
      const res = await net.fetch(raw, { headers: { 'User-Agent': UA } });
      if (!res.ok) return { ok: false, error: `pobb.in said ${res.status} – check the link.` };
      code = (await res.text()).trim();
    } else if (/^https?:/i.test(code)) {
      return { ok: false, error: 'Only pobb.in links can be read directly – for other sites, copy the export code instead.' };
    }
    const r = pobLib.parsePob(pobLib.decodeCode(code));
    const slots = Object.keys(r.items);
    if (!slots.length) return { ok: false, error: 'No equipped items found in that build.' };
    let kept = 0;
    for (const [slot, text] of Object.entries(r.items)) {
      const item = parseItem(text);
      if (!item) continue;
      item.fromPob = true;
      const cur = store.equipped[slot];
      // a copy from the game has base Armour/ES values PoB doesn't store: keep it if it's the same item
      if (cur && cur.name === item.name && !cur.fromPob) { kept++; continue; }
      store.setEquipped(slot, item);
      store.noteStats(item);
    }
    if (r.resists) store.setSetting('resists', { ...(store.settings.resists || {}), ...r.resists, cap: (store.settings.resists && store.settings.resists.cap) || 75 });
    refreshAll();
    const who = [r.character.ascendancy || r.character.className, r.character.level ? `level ${r.character.level}` : ''].filter(Boolean).join(', ');
    let message = `Imported ${slots.length} item${slots.length === 1 ? '' : 's'}${who ? ` (${who})` : ''}${r.resists ? ' and your resistances' : ''}.`;
    if (kept) message += ` Kept ${kept} you'd already copied from the game (same item, more detail).`;
    if (r.missingBase) message += ` PoB doesn't store base Armour/Energy Shield, so ${r.missingBase} armour piece${r.missingBase === 1 ? '' : 's'} score a bit low until you copy them in game once.`;
    log('pob import: ' + message);
    return { ok: true, message, slots };
  } catch (err) {
    log('pob import failed: ' + (err.stack || err));
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('ignore:set', (_e, rules) => {
  store.setSetting('ignoreStats', ignoreLib.cleanRules(rules));
  log('ignored stats: ' + JSON.stringify(store.settings.ignoreStats));
  refreshAll();
  return store.settings.ignoreStats;
});

ipcMain.handle('state:get', () => JSON.parse(JSON.stringify({
  profiles: store.listProfiles(),
  buildStats: gearLib.buildStats(store.settings.build),
  builds: gearLib.buildList(),
  gearScores: Object.fromEntries(Object.entries(store.equipped).map(([slot, it]) => [slot, gearOf(it, slot)])),
  mainSlots: MAIN_SLOTS,
  ignorePresets: Object.entries(ignoreLib.PRESETS).map(([id, p]) => ({ id, label: p.label })),
  budgetLabel: trade.budgetLabel(budgetNow()),
  weights: store.weights,
  equipped: store.equipped,
  seenStats: Object.keys(store.data.seenStats),
  settings: store.settings,
  slots: SLOTS,
  lastItem,
  hotkeyStatus,
})));

ipcMain.handle('evaluate:text', (_e, text) => {
  const item = parseItem(text);
  if (!item) return { ok: false, reason: 'That doesn\'t look like PoE2 item text. In game, hover an item and press Ctrl+C.' };
  store.noteStats(item);
  remember(item);
  notifySettings('item:copied', { id: item.id, name: item.name });
  return serialise(evaluate(item));
});

ipcMain.on('open:settings', () => openSettings());
ipcMain.on('open:tab', (_e, tab) => openTab(tab));
ipcMain.on('open:file', (_e, f) => { const dir = app.getPath('userData'); if (typeof f === 'string' && path.resolve(f).startsWith(dir)) shell.showItemInFolder(f); });
function openTab(tab) {
  const fresh = !(settingsWin && !settingsWin.isDestroyed());
  openSettings();
  const send = () => settingsWin.webContents.send('settings:tab', tab);
  if (fresh) settingsWin.webContents.once('did-finish-load', send); else send();
}

ipcMain.on('find:open', (_e, slot) => {
  const fresh = !(settingsWin && !settingsWin.isDestroyed());
  openSettings();
  const send = () => settingsWin.webContents.send('find:slot', slot);
  if (fresh) settingsWin.webContents.once('did-finish-load', send); else send();
});

// ---------- trade search ----------

const UA = 'poe2-upgrade-checker/0.1 (personal desktop tool)';
// pathofexile.com pages the app opens (search fallback, sign-in) share this
// cookie store, so if you sign in, searches and "Travel to hideout" use it.
const POE_PARTITION = 'persist:poe';
let tradeData = null; // { stats, filters, leagues, fetchedAt }

async function getJson(url) {
  const res = await net.fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);
  return res.json();
}

async function loadTradeData(force) {
  const cacheFile = path.join(app.getPath('userData'), 'trade-cache.json');
  const DAY = 24 * 3600 * 1000;
  if (!force && !tradeData) {
    try { tradeData = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (_) { tradeData = null; }
  }
  if (force || !tradeData || Date.now() - tradeData.fetchedAt > DAY) {
    try {
      const [stats, filters, leagues] = await Promise.all([
        getJson(`${trade.BASE}/api/trade2/data/stats`),
        getJson(`${trade.BASE}/api/trade2/data/filters`).catch(() => null),
        getJson(`${trade.BASE}/api/trade2/data/leagues`).catch(() => null),
      ]);
      tradeData = { stats, filters, leagues, fetchedAt: Date.now() };
      try { fs.writeFileSync(cacheFile, JSON.stringify(tradeData)); } catch (_) { /* ignore */ }
    } catch (err) {
      // Offline or the site is down: keep using an older cache if we have one.
      if (!tradeData || !tradeData.stats) throw err;
    }
  }
  tradeData.index = trade.buildStatIndex(tradeData.stats);
  return tradeData;
}

ipcMain.handle('trade:data', async (_e, force) => {
  try {
    const d = await loadTradeData(force);
    const leagues = ((d.leagues && d.leagues.result) || [])
      .filter((l) => !l.realm || l.realm === 'poe2')
      .map((l) => l.id);
    const statTexts = Array.from(new Set(d.index.all.map((e) => e.text)));
    return { ok: true, leagues, statTexts, lastItem };
  } catch (err) {
    return { ok: false, error: String(err.message || err), lastItem };
  }
});

ipcMain.handle('find:rows', (_e, target) => {
  const item = resolveItem(target);
  return item ? { item: JSON.parse(JSON.stringify(item)), rows: trade.statSources(item) } : { item: null, rows: [] };
});

ipcMain.handle('items:recent', () => Array.from(recentItems.values()).reverse().slice(0, 8)
  .map((i) => ({ id: i.id, name: i.name, itemClass: i.itemClass, copiedAt: i.copiedAt })));

ipcMain.on('open:url', (_e, url) => {
  if (typeof url === 'string' && url.startsWith(trade.BASE + '/trade2/')) shell.openExternal(url);
});

ipcMain.handle('trade:search', async (_e, req) => {
  const item = resolveItem(req.target || req.slot);
  if (!item) return { ok: false, error: 'No item for that slot.' };
  let d;
  try { d = await loadTradeData(false); } catch (err) {
    return { ok: false, error: 'Could not load trade site data: ' + (err.message || err) };
  }
  const armourOrWeapon = ['Weapon', 'Offhand', 'Helmet', 'Body Armour', 'Gloves', 'Boots'].includes(item.slot);
  const { body, unmatched, excluded } = trade.buildQuery(req.picks || [], {
    itemClass: item.itemClass, baseType: item.baseType, matchBase: !!req.matchBase,
    status: req.status || store.settings.status, statIndex: d.index, filtersData: d.filters,
    ignoreRules: ignoreRules(),
    preferLocal: armourOrWeapon,
  });
  if (req.league) store.setSetting('league', req.league);
  if (req.status) store.setSetting('status', req.status);
  if (req.budget !== undefined) store.setSetting('budget', req.budget);
  await refreshDivineRate(false);
  const budget = budgetNow(req.budget !== undefined ? req.budget : store.settings.budget);
  trade.applyBudget(body, budget);
  const r = await runSearch(pickLeague(d, req.league), body, 'custom');
  if (r.ok) await openIfAny(r, { item, mode: 'custom', title: `Custom search: ${item.name}`, body, searchKey: searchKey(body) });
  return { ...r, unmatched, excluded, budget: trade.budgetLabel(budget), item: item.name };
});

function pickLeague(d, wanted) {
  const ids = ((d && d.leagues && d.leagues.result) || []).filter((l) => !l.realm || l.realm === 'poe2').map((l) => l.id);
  if (wanted) return wanted;
  if (store.settings.league && (!ids.length || ids.includes(store.settings.league))) return store.settings.league;
  // Usually the current challenge league comes first; skip hardcore/standard if possible.
  return ids.find((id) => !/hardcore|standard|ssf|solo/i.test(id)) || ids[0] || 'Standard';
}

// Rate limits the trade site reports, e.g. "5:10:60,15:60:300" (hits:seconds:ban)
// with the current state "1:10:0,1:60:0". Returns true if we're close to a limit.
function nearRateLimit(headers) {
  try {
    const rules = String(headers.get('x-rate-limit-ip') || '').split(',').filter(Boolean);
    const state = String(headers.get('x-rate-limit-ip-state') || '').split(',').filter(Boolean);
    return rules.some((r, i) => {
      const max = Number(r.split(':')[0]); const used = Number((state[i] || '0').split(':')[0]);
      return max && used >= max - 1;
    });
  } catch (_) { return false; }
}

async function postSearch(league, body) {
  const res = await net.fetch(trade.searchUrl(league), {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status === 429) {
    const wait = res.headers.get('retry-after');
    const err = new Error(`The trade site says too many searches – wait ${wait || 'a minute'} seconds and try again.`);
    err.rateLimited = true; throw err;
  }
  if (!res.ok || !json.id) throw new Error((json.error && json.error.message) || `HTTP ${res.status}`);
  json._near = nearRateLimit(res.headers);
  return json;
}

// Same search, but sent from inside a (hidden) page on pathofexile.com, like the
// trade site itself does. Gets past checks that block plain app requests.
let tradeWin = null;
async function postSearchViaPage(league, body) {
  if (!tradeWin || tradeWin.isDestroyed()) {
    tradeWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, partition: POE_PARTITION } });
  }
  const page = `${trade.BASE}/trade2/search/poe2/${encodeURIComponent(league)}`;
  if (!tradeWin.webContents.getURL().startsWith(trade.BASE)) {
    await Promise.race([tradeWin.loadURL(page), new Promise((_, rej) => setTimeout(() => rej(new Error('page load timed out')), 15000))]);
  }
  const js = `fetch(${JSON.stringify(trade.searchUrl(league))}, { method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }))`;
  const r = await Promise.race([
    tradeWin.webContents.executeJavaScript(js, true),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 15000)),
  ]);
  if (!r || r.status !== 200 || !r.json || !r.json.id) {
    throw new Error((r && r.json && r.json.error && r.json.error.message) || `HTTP ${r && r.status}`);
  }
  return r.json;
}

// Runs a search and returns { ok, total, url }. Doesn't open the browser:
// callers decide (so a search with 0 results can be loosened first).
let statusBroken = false; // set if the trade site rejects 'available'
async function runSearch(league, body, label) {
  if (statusBroken && body.query.status && body.query.status.option === 'available') body.query.status.option = 'online';
  log(`search ${label || ''} league=${league} body=${JSON.stringify(body)}`);
  const errors = [];
  for (const [name, fn] of [['app', postSearch], ['page', postSearchViaPage]]) {
    try {
      const json = await fn(league, body);
      log(`search via ${name}: id=${json.id} total=${json.total}`);
      return {
        ok: true, league, total: json.total, url: trade.resultsUrl(league, json.id), near: !!json._near,
        searchId: json.id, ids: Array.isArray(json.result) ? json.result.slice(0, 100) : [], body,
      };
    } catch (err) {
      const msg = err.message || String(err);
      log(`search via ${name} failed: ${msg}`);
      if (err.rateLimited) return { ok: false, league, error: msg, rateLimited: true };
      if (/status/i.test(msg) && body.query.status && body.query.status.option !== 'online') {
        statusBroken = true;
        log('trade site rejected the listing status; retrying with "online"');
        return runSearch(league, { ...body, query: { ...body.query, status: { option: 'online' } } }, label);
      }
      errors.push(`${name}: ${msg}`);
    }
  }
  // Last resort: a pre-filled search link (we can't know how many results).
  return { ok: true, league, total: null, url: trade.prefilledUrl(league, body), fallback: errors.join('; ') };
}

// Show the results: in the app's results window (default) or the browser.
// ctx: { item, mode, title } - the item searched for (its class is needed to
// read the listings, and listings are scored against your equipped gear).
async function deliver(r, ctx) {
  if (!r.url || (r.total != null && r.total <= 0)) return r;
  const inApp = store.settings.resultsInApp !== false && r.searchId && r.ids && r.ids.length;
  if (inApp) {
    const shown = await showResults(r, ctx || {});
    if (shown) { r.inApp = true; r.opened = true; return r; }
  }
  await shell.openExternal(r.url); r.opened = true;
  return r;
}
async function openIfAny(r, ctx) { return deliver(r, ctx); }
function searchKey(body) {
  return require('crypto').createHash('sha1').update(JSON.stringify(body.query)).digest('hex').slice(0, 16);
}

// ---------- listings (in-app results) ----------

async function fetchViaApp(league, searchId, ids) {
  const url = `${trade.BASE}/api/trade2/fetch/${ids.map(encodeURIComponent).join(',')}?query=${encodeURIComponent(searchId)}&realm=poe2`;
  const res = await net.fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (res.status === 429) throw new Error('The trade site says too many requests – wait a moment.');
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !Array.isArray(json.result)) throw new Error((json.error && json.error.message) || `HTTP ${res.status}`);
  return json.result;
}
async function fetchViaPage(league, searchId, ids) {
  if (!tradeWin || tradeWin.isDestroyed()) {
    tradeWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, partition: POE_PARTITION } });
  }
  if (!tradeWin.webContents.getURL().startsWith(trade.BASE)) {
    await Promise.race([tradeWin.loadURL(`${trade.BASE}/trade2/search/poe2/${encodeURIComponent(league)}`),
      new Promise((_, rej) => setTimeout(() => rej(new Error('page load timed out')), 15000))]);
  }
  const url = `${trade.BASE}/api/trade2/fetch/${ids.map(encodeURIComponent).join(',')}?query=${encodeURIComponent(searchId)}&realm=poe2`;
  const r = await tradeWin.webContents.executeJavaScript(`fetch(${JSON.stringify(url)}, { credentials: 'include', headers: { Accept: 'application/json' } }).then(async (x) => ({ status: x.status, json: await x.json().catch(() => ({})) }))`, true);
  if (!r || r.status !== 200 || !Array.isArray(r.json.result)) throw new Error(`HTTP ${r && r.status}`);
  return r.json.result;
}
let loggedSample = false;
async function fetchListings(league, searchId, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    let got = null; let lastErr = null;
    for (const fn of [fetchViaApp, fetchViaPage]) {
      try { got = await fn(league, searchId, chunk); break; } catch (err) { lastErr = err; log(`fetch via ${fn.name} failed: ${err.message || err}`); }
    }
    if (!got) throw lastErr || new Error('fetch failed');
    if (!loggedSample && got[0]) { loggedSample = true; log('fetch sample: ' + JSON.stringify(got[0]).slice(0, 1500)); }
    out.push(...got.filter(Boolean));
  }
  return out;
}

let resultsWin = null;
let resultsState = null; // { r, ctx, listings: [...], next }

function createResultsWindow() {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const w = 600; const h = Math.min(860, area.height - 40);
  const saved = store.settings.resultsBounds;
  const onScreen = saved && screen.getAllDisplays().some((d) => {
    const a = d.workArea; return saved.x >= a.x - 50 && saved.y >= a.y - 50 && saved.x < a.x + a.width - 100 && saved.y < a.y + a.height - 100;
  });
  const b = onScreen ? saved : { width: w, height: h, x: area.x + area.width - w - 20, y: area.y + 20 };
  resultsWin = new BrowserWindow({
    width: b.width, height: b.height, x: b.x, y: b.y,
    title: 'Trade results', icon: ICON, autoHideMenuBar: true, backgroundColor: '#14110f', alwaysOnTop: true,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  resultsWin.setAlwaysOnTop(true, 'floating');
  resultsWin.loadFile(path.join(__dirname, 'ui', 'results.html'));
  resultsWin.on('closed', () => { resultsWin = null; });
  let t = null;
  const remember = () => { clearTimeout(t); t = setTimeout(() => { if (resultsWin && !resultsWin.isDestroyed()) store.setSetting('resultsBounds', resultsWin.getBounds()); }, 500); };
  resultsWin.on('move', remember); resultsWin.on('resize', remember);
  try { resultsWin.webContents.setZoomFactor(uiScale()); } catch (_) { /* ignore */ }
}

function scoreListing(s) {
  if (!s.item) return { ...s, compare: null };
  const r = evaluate(s.item);
  const c = r && r.ok ? {
    verdict: r.verdict, delta: r.delta, pct: r.pct, targetSlot: r.targetSlot, replacing: r.replacing, scoreMode: r.scoreMode,
    rows: r.rows.slice(0, 8).map((x) => ({ key: x.key, diff: x.diff, weight: x.weight, impact: x.impact, useful: x.useful })),
  } : null;
  const value = c && s.priceEx ? (c.delta / Math.max(s.priceEx, 1)) * (store.settings.divineRate || 1) : null; // score per divine
  const g = gearOf(s.item, c && c.targetSlot);
  const ge = c && store.equipped[c.targetSlot] ? gearOf(store.equipped[c.targetSlot], c.targetSlot) : null;
  return { ...s, compare: c, valuePerDiv: value, gear: g ? { score: g.score, grade: g.grade, missing: g.missing, unique: g.unique } : null, gearEquipped: ge ? ge.score : null };
}

function resultsPayload() {
  const { r, ctx, listings } = resultsState;
  return JSON.parse(JSON.stringify({
    title: ctx.title || 'Trade results', mode: ctx.mode, league: r.league, total: r.total, url: r.url,
    itemName: ctx.item && ctx.item.name, itemClass: ctx.item && ctx.item.itemClass,
    note: ctx.note || null, priceSummary: ctx.priceSummary || null,
    shown: listings.length, more: resultsState.next < r.ids.length,
    divineRate: store.settings.divineRate || null,
    listings: listings.map((x) => ({ ...x, item: x.item ? { name: x.item.name, baseType: x.item.baseType, rarity: x.item.rarity, itemLevel: x.item.itemLevel, lines: x.item.lines, id: x.item.id } : null })),
    saved: !!(store.data.savedSearches || []).find((x) => x.searchKey === ctx.searchKey),
    signedIn: !!resultsState.signedIn,
  }));
}

async function loadMoreListings(count) {
  const st = resultsState;
  const ids = st.r.ids.slice(st.next, st.next + count);
  if (!ids.length) return;
  const raw = await fetchListings(st.r.league, st.r.searchId, ids);
  st.next += ids.length;
  const rates = { ...(store.settings.currencyRates || {}), ...(store.settings.divineRate ? { divine: store.settings.divineRate } : {}) };
  for (const res of raw) {
    const s = listingLib.summarise(res, st.ctx.item && st.ctx.item.itemClass, rates);
    s.pos = st.r.ids.indexOf(res.id) + 1; // where it sits on the trade site page
    if (s.item) remember(s.item);
    st.listings.push(scoreListing(s));
  }
}

async function showResults(r, ctx) {
  resultsState = { r, ctx, listings: [], next: 0, signedIn: await signedIn() };
  try {
    await loadMoreListings(20);
  } catch (err) {
    log('could not load listings, opening the browser instead: ' + (err.message || err));
    return false;
  }
  if (!resultsWin || resultsWin.isDestroyed()) createResultsWindow();
  const send = () => resultsWin.webContents.send('results:data', resultsPayload());
  if (resultsWin.webContents.isLoading()) resultsWin.webContents.once('did-finish-load', send); else send();
  resultsWin.showInactive();
  buildTrayMenu();
  return true;
}

ipcMain.handle('results:more', async () => {
  if (!resultsState) return null;
  try { await loadMoreListings(10); } catch (err) { return { error: err.message || String(err) }; }
  return resultsPayload();
});
ipcMain.handle('results:rescore', () => {
  if (!resultsState) return null;
  resultsState.listings = resultsState.listings.map((x) => scoreListing(x));
  return resultsPayload();
});
ipcMain.on('results:hide', () => { if (resultsWin && !resultsWin.isDestroyed()) resultsWin.hide(); });
function toggleResults() {
  if (resultsWin && !resultsWin.isDestroyed()) {
    if (resultsWin.isVisible()) resultsWin.hide(); else resultsWin.showInactive();
  } else if (resultsState) {
    createResultsWindow();
    resultsWin.webContents.once('did-finish-load', () => resultsWin.webContents.send('results:data', resultsPayload()));
    resultsWin.showInactive();
  }
}
let resultsHotkey = null;
function registerResultsHotkey() {
  const want = store.settings.resultsHotkey || 'Ctrl+Shift+D';
  if (resultsHotkey) { try { globalShortcut.unregister(resultsHotkey); } catch (_) { /* ignore */ } resultsHotkey = null; }
  try { if (globalShortcut.register(want, toggleResults)) resultsHotkey = want; } catch (_) { /* ignore */ }
  log(`results hotkey ${want}: ${resultsHotkey ? 'registered' : 'FAILED'}`);
}
ipcMain.on('clipboard:write', (_e, text) => {
  if (typeof text !== 'string' || !text) return;
  try { clipboard.writeText(text); lastClip = text; } catch (_) { /* ignore */ }
});
ipcMain.on('results:open', (_e, url) => {
  if (typeof url === 'string' && url.startsWith(trade.BASE + '/trade2/')) shell.openExternal(url);
});

// ---------- divine -> exalted rate (poe.ninja) ----------

const HOUR = 3600 * 1000;
let rateFetch = null;

// Budget with the auto rate filled in (uses the last fetched rate).
function budgetNow(b) {
  const budget = b === undefined ? store.settings.budget : b;
  if (!budget) return budget;
  if (budget.currency === 'divine' && store.settings.autoRate !== false && store.settings.divineRate > 0) {
    return { ...budget, divineRate: store.settings.divineRate };
  }
  return budget;
}

async function ninjaLeague() {
  if (store.settings.league) return store.settings.league;
  try { const d = await loadTradeData(false); return pickLeague(d); } catch (_) { /* fall through */ }
  try {
    const l = await getJson('https://poe.ninja/poe2/api/economy/leagues');
    const first = Array.isArray(l) ? l[0] : (l && (l.economyLeagues || l.leagues || [])[0]);
    if (first) return first.name || first.id;
  } catch (_) { /* ignore */ }
  return 'Standard';
}

async function refreshDivineRate(force) {
  if (store.settings.autoRate === false) return { ok: true, auto: false, rate: store.settings.divineRate || null };
  const fresh = store.settings.divineRateAt && Date.now() - store.settings.divineRateAt < HOUR;
  if (!force && fresh && store.settings.divineRate) {
    return { ok: true, auto: true, rate: store.settings.divineRate, at: store.settings.divineRateAt, league: store.settings.divineRateLeague };
  }
  if (rateFetch) return rateFetch;
  rateFetch = (async () => {
    const league = await ninjaLeague();
    let lastErr = 'no data';
    for (const url of rates.ninjaUrls(league)) {
      try {
        const data = await getJson(url);
        const rate = rates.divineInExalts(data);
        const all = rates.currencyRatesInExalts(data);
        if (all) store.setSetting('currencyRates', { ...all, divine: rate || all.divine });
        if (rate) {
          store.setSetting('divineRate', rate);
          store.setSetting('divineRateAt', Date.now());
          store.setSetting('divineRateLeague', league);
          log(`divine rate ${rate} ex (${league}) from ${url}`);
          return { ok: true, auto: true, rate, at: Date.now(), league };
        }
        lastErr = 'Divine/Exalted price not found in poe.ninja data';
      } catch (err) { lastErr = err.message || String(err); }
    }
    log('divine rate fetch failed: ' + lastErr);
    return { ok: false, auto: true, rate: store.settings.divineRate || null, at: store.settings.divineRateAt, league, error: lastErr };
  })();
  try { return await rateFetch; } finally { rateFetch = null; }
}

ipcMain.handle('rate:get', (_e, force) => refreshDivineRate(!!force));

// One click searches. target: a slot, 'Ring' (your weaker ring), '__last' or
// { itemId } (a copied item). mode 'similar' (default) = same stats or better,
// loosened step by step until something is listed; 'weights' = beats your
// item by your stat weights.
ipcMain.handle('trade:quick', async (_e, target, mode, extra) => {
  const item = resolveItem(target);
  if (!item) return { ok: false, error: `Nothing saved for ${typeof target === 'string' ? target : 'that item'} yet.` };
  let d;
  try { d = await loadTradeData(false); } catch (err) {
    return { ok: false, error: 'Could not load trade site data: ' + (err.message || err) };
  }
  if (extra && extra.league) store.setSetting('league', extra.league);
  if (extra && extra.status) store.setSetting('status', extra.status);
  const league = pickLeague(d, extra && extra.league);
  const armourOrWeapon = ['Weapon', 'Offhand', 'Helmet', 'Body Armour', 'Gloves', 'Boots'].includes(item.slot);
  const opts = {
    statIndex: d.index, filtersData: d.filters, preferLocal: armourOrWeapon,
    minGainPct: store.settings.minGainPct || 0, status: store.settings.status,
    ignoreRules: ignoreRules(),
  };
  await refreshDivineRate(false);
  const budget = budgetNow();
  const base = { item: item.name, itemClass: item.itemClass, budget: trade.budgetLabel(budget) };

  if (mode === 'craft') {
    const go = gearOpts();
    const top = gearLib.topStats(item.slot, 2, go);
    if (!top.length) return { ok: false, error: 'Pick a build (Build & weights) so the app knows which stats matter on this slot.' };
    const q = trade.buildCraftQuery(item, { ...opts, top });
    trade.applyBudget(q.body, budget);
    const r = await openIfAny(await runSearch(league, q.body, 'craft'), {
      item, mode: 'craft', body: q.body, searchKey: searchKey(q.body),
      title: `Craftable ${item.itemClass || 'bases'}: ${q.keyStats.join(' + ')} + an open affix`,
      note: `Rare, not corrupted, at least one open prefix or suffix, with ${q.keyStats.join(' and ')} already on it. Cheapest first.`,
    });
    return { ...base, ...r, mode: 'craft', keyStats: q.keyStats, unmatched: q.unmatched };
  }

  if (mode === 'weights') {
    const q = trade.buildUpgradeQuery(item, store.weights, opts);
    if (!q.body.query.stats.length && !q.body.query.filters.equipment_filters) {
      return { ok: false, error: 'None of your weighted stats could be matched on the trade site. Set weights for your build\'s stats first.' };
    }
    trade.applyBudget(q.body, budget);
    const r = await openIfAny(await runSearch(league, q.body, 'weights'),
      { item, mode: 'weights', title: `Beats your ${item.name} by your weights`, body: q.body, searchKey: searchKey(q.body) });
    return { ...base, ...r, mode: 'weights', unmatched: q.unmatched, beat: q.groupMin, excluded: q.excluded };
  }

  let r = null; let q = null;
  for (let level = 0; level < trade.RELAX.length; level++) {
    q = trade.buildSimilarQuery(item, { ...opts, level });
    if (!q.body.query.stats.length && !q.body.query.filters.equipment_filters && !q.body.query.name) {
      return { ok: false, error: 'None of this item\'s stats could be matched on the trade site.' };
    }
    trade.applyBudget(q.body, budget);
    r = await runSearch(league, q.body, `similar L${level}`);
    if (!r.ok || r.total == null || r.total > 0) break;
    if (r.near) { log('close to the trade site rate limit, not loosening further'); break; }
    await new Promise((res) => setTimeout(res, 700)); // go easy on the trade site
  }
  if (r && r.ok) {
    await openIfAny(r, {
      item, mode: 'similar', body: q.body, searchKey: searchKey(q.body),
      title: `Same stats or better than ${item.name}`,
      note: q.level > 0 ? `Nothing matched your exact values, so this shows ${q.levelLabel} (${q.need} of ${q.total} stats).` : null,
    });
  }
  return {
    ...base, ...r, mode: 'similar', need: q.need, of: q.total, level: q.level, levels: q.levels,
    levelLabel: q.levelLabel, unique: q.unique, unmatched: q.unmatched, skipped: q.skipped,
    ignored: q.ignored, excluded: q.excluded,
  };
});

// ---------- price check ("What's it worth?") ----------

// Both units, so prices are easy to compare: "2 div (1,393 ex)" / "180 ex (0.26 div)"
function fmtEx(ex) {
  if (ex == null) return '?';
  const div = store.settings.divineRate;
  if (!div) return `${Math.round(ex).toLocaleString('en')} ex`;
  if (ex >= div * 0.95) return `${Math.round((ex / div) * 10) / 10} div (${Math.round(ex).toLocaleString('en')} ex)`;
  return `${Math.round(ex).toLocaleString('en')} ex (${Math.round((ex / div) * 100) / 100} div)`;
}

function priceSummary(listings) {
  const prices = listings.map((x) => x.priceEx).filter((v) => v != null).sort((a, b) => a - b);
  if (!prices.length) return null;
  const firstTen = prices.slice(0, 10);
  const median = firstTen[Math.floor((firstTen.length - 1) / 2)];
  return { cheapest: fmtEx(prices[0]), typical: fmtEx(median), count: prices.length, cheapestEx: prices[0], typicalEx: median };
}

ipcMain.handle('trade:price', async (_e, target) => {
  const item = resolveItem(target);
  if (!item) return { ok: false, error: 'No item to price.' };
  let d;
  try { d = await loadTradeData(false); } catch (err) { return { ok: false, error: 'Could not load trade site data: ' + (err.message || err) }; }
  await refreshDivineRate(false);
  const league = pickLeague(d);
  const armourOrWeapon = ['Weapon', 'Offhand', 'Helmet', 'Body Armour', 'Gloves', 'Boots'].includes(item.slot);
  // Price check looks for close matches to THIS item, without your price range
  // or ignored stats (those are about what you want, not what it's worth).
  const opts = { statIndex: d.index, filtersData: d.filters, preferLocal: armourOrWeapon, status: store.settings.status };
  let r = null; let q = null;
  for (let level = 0; level < 3; level++) {
    q = trade.buildSimilarQuery(item, { ...opts, level });
    q.body.sort = { price: 'asc' };
    r = await runSearch(league, q.body, `price L${level}`);
    if (!r.ok || r.total == null || r.total >= 3) break;
    if (r.near) break;
    await new Promise((res) => setTimeout(res, 700));
  }
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'Search failed.' };
  if (!r.total) return { ok: true, mode: 'price', total: 0, league, item: item.name, url: r.url, levelLabel: q.levelLabel };
  const ctx = { item, mode: 'price', title: `Price check: ${item.name}`, body: q.body, searchKey: searchKey(q.body),
    note: `Listings like this one (${q.levelLabel}, ${q.need} of ${q.total} stats), cheapest first.` };
  const shown = store.settings.resultsInApp !== false && r.ids && r.ids.length ? await showResults(r, ctx) : false;
  let summary = null;
  if (shown) {
    summary = priceSummary(resultsState.listings);
    resultsState.ctx.priceSummary = summary;
    if (summary && item.id) lastWorth.set(item.id, summary.typicalEx);
    if (resultsWin && !resultsWin.isDestroyed()) resultsWin.webContents.send('results:data', resultsPayload());
  } else {
    await shell.openExternal(r.url);
  }
  return { ok: true, mode: 'price', total: r.total, league, item: item.name, url: r.url, inApp: shown, opened: true,
    summary, levelLabel: q.levelLabel, level: q.level, need: q.need, of: q.total };
});

// "Add to stash value" from the popup: uniques follow poe.ninja, others use your price check.
ipcMain.handle('stash:addFromPopup', async (_e, target, qty) => {
  const item = resolveItem(target);
  if (!item || !stash) return { ok: false, error: 'No item.' };
  const unique = /unique/i.test(item.rarity || '');
  let idx = null;
  try { idx = await stash.refreshPrices(false); } catch (_) { /* offline */ }
  const p = unique ? stashPrices.lookup(idx, item.name) : null;
  const div = store.settings.divineRate || null;
  const worthEx = lastWorth.get(item.id);
  const entry = { name: item.name, base: item.baseType || null, rarity: item.rarity, qty: qty || 1 };
  if (p) Object.assign(entry, { priceFrom: 'ninja', div: p.div });
  else if (worthEx != null && div) Object.assign(entry, { priceFrom: 'trade', div: worthEx / div, note: 'typical price of similar listings' });
  else Object.assign(entry, { priceFrom: 'manual', div: null });
  const it = stash.addItem(entry);
  return { ok: true, item: it, priced: it.div != null, basis: entry.priceFrom };
});

// ---------- saved searches ----------

function savedList() { return store.data.savedSearches || (store.data.savedSearches = []); }

ipcMain.handle('saved:add', (_e, name) => {
  if (!resultsState) return { ok: false };
  const { ctx, r } = resultsState;
  const list = savedList();
  if (list.find((x) => x.searchKey === ctx.searchKey)) return { ok: true, already: true };
  list.unshift({
    id: 's' + Date.now().toString(36), name: name || ctx.title, league: r.league, body: ctx.body, searchKey: ctx.searchKey,
    mode: ctx.mode, itemClass: ctx.item && ctx.item.itemClass, itemName: ctx.item && ctx.item.name,
    lastTotal: r.total, lastRun: Date.now(), created: Date.now(), lastIds: (r.ids || []).slice(0, 100), alert: false,
  });
  store.save();
  notifySettings('saved:changed');
  return { ok: true };
});
ipcMain.handle('saved:list', () => JSON.parse(JSON.stringify(savedList().map(({ body, lastIds, ...x }) => x))));
ipcMain.handle('saved:delete', (_e, id) => {
  store.data.savedSearches = savedList().filter((x) => x.id !== id);
  store.save();
  return true;
});
ipcMain.handle('saved:run', async (_e, id) => {
  const s = savedList().find((x) => x.id === id);
  if (!s) return { ok: false, error: 'Saved search not found.' };
  await refreshDivineRate(false);
  const body = JSON.parse(JSON.stringify(s.body));
  const r = await runSearch(s.league, body, `saved ${s.name}`);
  if (!r.ok) return r;
  const prev = s.lastTotal;
  s.lastTotal = r.total; s.lastRun = Date.now(); s.lastIds = (r.ids || []).slice(0, 100); store.save();
  const item = { itemClass: s.itemClass, name: s.itemName, slot: require('./core/slots').slotForClass(s.itemClass) };
  await openIfAny(r, { item, mode: s.mode, title: s.name, body, searchKey: s.searchKey,
    note: prev != null && r.total != null ? `${r.total} listings now (${r.total - prev >= 0 ? '+' : ''}${r.total - prev} since last time).` : null });
  return { ...r, prev, ids: undefined, body: undefined };
});

// ---------- saved-search alerts ----------
const { Notification, session } = require('electron');
let alertsRunning = false;
let lastAlertRun = 0;
ipcMain.handle('saved:alert', (_e, id, on) => {
  const s = savedList().find((x) => x.id === id);
  if (s) { s.alert = !!on; store.save(); }
  return !!(s && s.alert);
});
ipcMain.handle('alerts:status', () => ({ every: store.settings.alertEvery || 0, lastRun: lastAlertRun, running: alertsRunning }));

async function runAlerts(force) {
  const every = Number(store.settings.alertEvery) || 0;
  if (alertsRunning || (!force && (!every || Date.now() - lastAlertRun < every * 60000))) return;
  const list = savedList().filter((x) => x.alert);
  if (!list.length) return;
  alertsRunning = true; lastAlertRun = Date.now();
  try {
    await refreshDivineRate(false);
    for (const s of list) {
      const r = await runSearch(s.league, JSON.parse(JSON.stringify(s.body)), `alert ${s.name}`);
      if (!r.ok) { log(`alert ${s.name}: ${r.error}`); if (r.rateLimited) break; continue; }
      const prev = Array.isArray(s.lastIds) ? s.lastIds : null;
      const fresh = prev ? r.ids.filter((x) => !prev.includes(x)) : [];
      s.lastIds = r.ids.slice(0, 100); s.lastTotal = r.total; s.lastRun = Date.now();
      store.save();
      if (fresh.length) {
        let detail = '';
        try {
          const raw = await fetchListings(s.league, r.searchId, fresh.slice(0, 3));
          const rates = { ...(store.settings.currencyRates || {}), ...(store.settings.divineRate ? { divine: store.settings.divineRate } : {}) };
          const best = raw.map((x) => listingLib.summarise(x, s.itemClass, rates)).sort((a, b) => (a.priceEx || 1e15) - (b.priceEx || 1e15))[0];
          if (best) {
            const g = best.item ? gearOf(best.item) : null;
            detail = `Cheapest new: ${best.priceText}${g && g.score != null ? ` · gear score ${g.score} ${g.grade}` : ''}`;
          }
        } catch (err) { log('alert fetch: ' + err.message); }
        log(`alert ${s.name}: ${fresh.length} new`);
        if (Notification.isSupported()) {
          const n = new Notification({ title: `${fresh.length} new listing${fresh.length === 1 ? '' : 's'}: ${s.name}`, body: detail || 'Click to see them.', icon: ICON });
          n.on('click', async () => {
            const rr = await runSearch(s.league, JSON.parse(JSON.stringify(s.body)), `alert open ${s.name}`);
            if (rr.ok) await openIfAny(rr, { item: { itemClass: s.itemClass, name: s.itemName, slot: require('./core/slots').slotForClass(s.itemClass) }, mode: s.mode, title: s.name, body: s.body, searchKey: s.searchKey, note: `${fresh.length} new since the last check.` });
          });
          n.show();
        }
        notifySettings('saved:changed');
      }
      if (r.near) { log('alerts: near the trade site rate limit, stopping this round'); break; }
      await new Promise((res) => setTimeout(res, 3000)); // go easy on the trade site
    }
  } finally { alertsRunning = false; }
}
ipcMain.handle('alerts:run', async () => { await runAlerts(true); return { lastRun: lastAlertRun }; });

// ---------- pathofexile.com account (optional) ----------
async function signedIn() {
  try {
    const c = await session.fromPartition(POE_PARTITION).cookies.get({ url: trade.BASE, name: 'POESESSID' });
    return c.length > 0;
  } catch (_) { return false; }
}
ipcMain.handle('account:status', async () => ({ signedIn: await signedIn() }));
ipcMain.handle('account:signin', async () => {
  const w = new BrowserWindow({ width: 980, height: 820, title: 'Sign in to pathofexile.com', icon: ICON, autoHideMenuBar: true, webPreferences: { partition: POE_PARTITION, sandbox: true, contextIsolation: true } });
  w.loadURL(`${trade.BASE}/login`);
  return new Promise((resolve) => {
    const t = setInterval(async () => {
      if (await signedIn()) { clearInterval(t); log('signed in to pathofexile.com'); if (!w.isDestroyed()) w.close(); notifySettings('settings:changed'); resolve({ signedIn: true }); }
    }, 1500);
    w.on('closed', async () => { clearInterval(t); resolve({ signedIn: await signedIn() }); });
  });
});
ipcMain.handle('account:signout', async () => {
  await session.fromPartition(POE_PARTITION).clearStorageData();
  log('signed out of pathofexile.com');
  return { signedIn: false };
});
// Instant Buyout: ask the trade site to take you to the seller's hideout (needs sign-in).
ipcMain.handle('trade:hideout', async (_e, listingId) => {
  const l = resultsState && resultsState.listings.find((x) => x.id === listingId);
  if (!l || !l.hideoutToken) return { ok: false, error: 'This listing has no hideout token – use Buy on trade site.' };
  if (!(await signedIn())) return { ok: false, error: 'Sign in first (Options → Trade site account).' };
  try {
    if (!tradeWin || tradeWin.isDestroyed()) tradeWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, partition: POE_PARTITION } });
    if (!tradeWin.webContents.getURL().startsWith(trade.BASE)) await tradeWin.loadURL(`${trade.BASE}/trade2/search/poe2/${encodeURIComponent(resultsState.r.league)}`);
    const js = `fetch('/api/trade2/whisper', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: ${JSON.stringify(JSON.stringify({ token: l.hideoutToken }))} }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }))`;
    const r = await tradeWin.webContents.executeJavaScript(js, true);
    log(`hideout travel: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    if (r.status === 200 && !(r.json && r.json.error)) return { ok: true };
    return { ok: false, error: (r.json && r.json.error && r.json.error.message) || `The trade site said ${r.status}.` };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

// ---------- start with Windows ----------

function applyLoginItem() {
  try {
    const openAtLogin = !!store.settings.startWithWindows;
    const args = app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'];
    app.setLoginItemSettings({ openAtLogin, path: process.execPath, args });
  } catch (err) { log('login item: ' + err.message); }
}

// ---------- settings window & tray ----------

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 900, height: 720, title: 'PoE2 Upgrade Checker', icon: ICON, autoHideMenuBar: true,
    backgroundColor: '#14110f',
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  settingsWin.loadFile(path.join(__dirname, 'ui', 'settings.html'));
}

// ---------- auto-update (installed app only; releases on GitHub) ----------
const upd = { state: 'idle', version: null, error: null, progress: null, checked: null };
let autoUpdater = null;
function updaterAvailable() { return app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR; }
function setupUpdater() {
  if (!updaterAvailable()) { upd.state = app.isPackaged ? 'portable' : 'dev'; return; }
  try { ({ autoUpdater } = require('electron-updater')); } catch (err) { upd.state = 'unavailable'; log('updater: ' + err.message); return; }
  autoUpdater.autoDownload = store.settings.autoUpdate !== false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: (m) => log('updater: ' + m), warn: (m) => log('updater warn: ' + m), error: (m) => log('updater error: ' + m), debug: () => {} };
  const changed = () => { notifySettings('update:changed'); buildTrayMenu(); };
  autoUpdater.on('checking-for-update', () => { upd.state = 'checking'; upd.error = null; changed(); });
  autoUpdater.on('update-not-available', () => { upd.state = 'latest'; upd.checked = Date.now(); changed(); });
  autoUpdater.on('update-available', (i) => { upd.state = autoUpdater.autoDownload ? 'downloading' : 'available'; upd.version = i.version; upd.checked = Date.now(); changed(); });
  autoUpdater.on('download-progress', (p) => { upd.progress = Math.round(p.percent); notifySettings('update:changed'); });
  autoUpdater.on('error', (err) => { upd.state = 'error'; upd.error = String(err && err.message || err).split('\n')[0]; changed(); });
  autoUpdater.on('update-downloaded', (i) => {
    upd.state = 'ready'; upd.version = i.version; changed();
    log(`update ${i.version} downloaded; installs on restart`);
    try {
      const n = new Notification({ title: `PoE2 Upgrade Checker ${i.version} is ready`, body: 'Click to restart and update now, or it installs next time you quit.', icon: ICON });
      n.on('click', () => autoUpdater.quitAndInstall(true, true));
      n.show();
    } catch (_) { /* ignore */ }
  });
  const check = () => autoUpdater.checkForUpdates().catch((err) => log('update check: ' + err.message));
  setTimeout(check, 15000);
  setInterval(check, 6 * HOUR);
}
ipcMain.handle('update:status', () => ({ ...upd, current: app.getVersion() }));
ipcMain.handle('update:check', async () => {
  if (!autoUpdater) return { ...upd, current: app.getVersion() };
  try { await autoUpdater.checkForUpdates(); } catch (err) { upd.state = 'error'; upd.error = err.message; }
  return { ...upd, current: app.getVersion() };
});
ipcMain.handle('update:download', async () => { if (autoUpdater) { upd.state = 'downloading'; autoUpdater.downloadUpdate().catch((e) => log('update download: ' + e.message)); } return upd; });
ipcMain.on('update:install', () => { if (autoUpdater && upd.state === 'ready') autoUpdater.quitAndInstall(true, true); });

function buildTrayMenu() {
  const paused = !!store.settings.paused;
  tray.setToolTip(paused ? 'PoE2 Upgrade Checker (paused)' : 'PoE2 Upgrade Checker');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: hotkeyStatus.ok ? `Hotkey: ${hotkeyStatus.accelerator}` : 'Hotkey not set (see Options)', enabled: false },
    { label: `Character: ${(store.listProfiles().find((p) => p.active) || {}).name || '—'}`, enabled: false },
    { label: `Show / hide results${resultsHotkey ? ` (${resultsHotkey})` : ''}`, click: toggleResults, enabled: !!resultsState },
    ...(upd.state === 'ready' ? [{ label: `Restart to update to ${upd.version}`, click: () => autoUpdater && autoUpdater.quitAndInstall(true, true) }] : []),
    { label: `Scan stash tab${store.settings.stashHotkey === '' ? '' : ` (${store.settings.stashHotkey || 'Ctrl+Shift+S'})`}`, click: () => { if (stash) stash.scan().then((r) => showResult({ kind: 'stash', ...r, divineRate: store.settings.divineRate || null })); } },
    { label: 'Stash value…', click: () => openTab('stash') },
    { label: 'Settings && gear…', click: openSettings },
    { label: 'Open log', click: () => { log('log opened'); shell.openPath(logFile); } },
    { label: paused ? 'Resume watching' : 'Pause watching', click: () => { store.setSetting('paused', !paused); buildTrayMenu(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

app.on('second-instance', openSettings);

app.whenReady().then(() => {
  store = new Store(app.getPath('userData'));
  // Don't pop up for whatever happened to be on the clipboard at launch.
  try { lastClip = clipboard.readText(); } catch (_) { lastClip = ''; }

  tray = new Tray(nativeImage.createFromPath(ICON));
  tray.on('click', openSettings);
  buildTrayMenu();
  createPopup();
  log(`started v${app.getVersion()} on ${process.platform}`);
  keys = new KeySender(log, app.getPath('userData'));
  keys.start();
  registerHotkey();
  registerResultsHotkey();
  stash = stashLib.create({
    store, log, getJson, ipcMain, globalShortcut, desktopCapturer, screen, nativeImage, app,
    ninjaLeague,
    tradeLeague: async () => pickLeague(await loadTradeData(false)),
    runSearch, fetchListings,
    rates: () => ({ ...(store.settings.currencyRates || {}), ...(store.settings.divineRate ? { divine: store.settings.divineRate } : {}) }),
    priceInEx: listingLib.priceInEx, formatPrice: listingLib.formatPrice, clean: listingLib.clean,
    beforeCapture: async () => { if (popup && popup.isVisible()) { hidePopup(); await new Promise((r) => setTimeout(r, 120)); } },
    showToast: (payload) => showResult(payload),
    changed: () => { notifySettings('stash:changed'); },
  });
  stash.registerHotkey();
  buildTrayMenu();
  setInterval(pollClipboard, 250);
  setInterval(watchCursor, 200);
  setInterval(() => runAlerts(false).catch((e) => log('alerts: ' + e.message)), 60000);
  try { app.setAppUserModelId('local.poe2.upgradechecker'); } catch (_) { /* ignore */ }
  refreshDivineRate(false).catch(() => {});
  setInterval(() => refreshDivineRate(false).catch(() => {}), HOUR);
  applyLoginItem();
  setupUpdater();
  const hidden = process.argv.includes('--hidden') || store.settings.openSettingsOnStart === false;
  if (!hidden) openSettings();
});

app.on('window-all-closed', (e) => { /* keep running in the tray */ });
app.on('will-quit', () => { globalShortcut.unregisterAll(); if (keys) keys.stop(); if (stash) stash.stop(); });
