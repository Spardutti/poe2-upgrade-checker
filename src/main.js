'use strict';

const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, Tray, Menu, clipboard, screen, ipcMain, globalShortcut, nativeImage, net, shell, desktopCapturer,
} = require('electron');
const trade = require('./core/trade');
const rates = require('./core/rates');
const ignoreLib = require('./core/ignore');
const catalogLib = require('./core/catalog');
const listingLib = require('./core/listing');
const gamesLib = require('./core/games');
const priceLib = require('./core/price');
const { suggestWeights } = require('./core/autoweights');
const gearLib = require('./core/gearscore');
const characterLib = require('./core/character');
const { parseItem } = require('./core/parser');
const { compare } = require('./core/scorer');
const { Store } = require('./core/store');
const { SLOTS, MAIN_SLOTS, SLOT_GROUPS, WEAKEST_OF, groupOf } = require('./core/slots');
const { KeySender } = require('./keysender');

// Linux: run through X11 (XWayland on Wayland desktops). Global hotkeys, putting the popup at the
// mouse and sending Ctrl+C to the game (an X11 window under Proton) all need it.
if (process.platform === 'linux') app.commandLine.appendSwitch('ozone-platform', 'x11');

// The app was called "PoE2 Upgrade Checker" before PoE1 support. Its settings, builds and log stay in that
// folder (%APPDATA%\PoE2 Upgrade Checker, ~/.config/PoE2 Upgrade Checker), so nothing is lost by the rename.
const DATA_DIR_NAME = 'PoE2 Upgrade Checker';
if (app.isPackaged && path.basename(app.getPath('userData')) === app.getName() && app.getName() !== DATA_DIR_NAME) {
  app.setPath('userData', path.join(app.getPath('appData'), DATA_DIR_NAME));
}

if (!app.requestSingleInstanceLock()) { app.exit(0); }

let store;
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
  if (!item.game && store) item.game = store.activeGame();
  item.copiedAt = Date.now();
  recentItems.set(item.id, item);
  while (recentItems.size > 30) recentItems.delete(recentItems.keys().next().value);
  lastItem = item;
  return item;
}
// trade listings get their own list, so they don't push out what you copied (or become "last item")
const listingItems = new Map();
function rememberListing(item) {
  item.id = `l${Date.now().toString(36)}${(++itemSeq).toString(36)}`;
  listingItems.set(item.id, item);
  while (listingItems.size > 200) listingItems.delete(listingItems.keys().next().value);
  return item;
}
const itemById = (id) => recentItems.get(id) || listingItems.get(id) || null;
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
  const tweaks = { ...(store.settings.buildTweaks || {}) };
  // "cap resistances first" also counts for the gear score (unless you've tuned resistances yourself)
  // – only for resistances you're actually short of
  const pr = pobPriorities();
  if (pobCI() && tweaks['Chaos res'] == null) tweaks['Chaos res'] = 0; // Chaos Inoculation
  const rs = pr.resFirst ? liveResists() : null;
  if (rs) {
    for (const [El, el] of Object.entries(RES_EL)) {
      if (el === 'chaos' && (!pr.chaos || pobCI())) continue;
      const cap = (rs.caps && rs.caps[el]) || rs.cap || 75;
      if (rs[el] != null && rs[el] < cap && tweaks[`${El} res`] == null) tweaks[`${El} res`] = 2;
    }
  }
  return { build: store.settings.build || gearLib.DEFAULT_BUILD, ignore: (k) => ignoreLib.isIgnored(rules, k), tweaks };
}

// How much of each resistance an item in `slot` still needs to give before you
// hit the cap, from the resistances you entered (or imported from PoB):
// need = cap - (your total - what the item in that slot gives now).
const RES_EL = { Fire: 'fire', Cold: 'cold', Lightning: 'lightning', Chaos: 'chaos' };
const resLib = require('./core/resists');

// ---------- Path of Building engine ----------
// Your PoB export is the reference build; every item is judged by what it really changes on it
// (minion DPS, effective HP, resistances against the cap, Spirit, attributes). Items you've
// copied in game replace PoB's, so it calculates with what you're actually wearing.
const { createEngine } = require('./pobengine');
const pobVerdict = require('./core/pobverdict');
// the game you're playing (your active character's): decides the trade site, prices and Path of Building
// The game a piece of work is for. A trade search or price check keeps the game it started in
// (AsyncLocalStorage follows it through every await), so pressing F2 in the other game halfway
// through can't mix the two games' leagues, stat ids, budgets and characters.
const { AsyncLocalStorage } = require('async_hooks');
const gameCtx = new AsyncLocalStorage();
const tg = () => { const c = gameCtx.getStore(); return (c && c.game) || store.activeGame(); };
const inGame = (fn) => (...args) => gameCtx.run({ game: store.activeGame() }, () => fn(...args));
// still on the game this work started in?
const sameGame = () => tg() === store.activeGame();
const SWITCHED = () => ({ ok: false, switched: true, error: `You changed game while this was running, so it was stopped. Try again in ${G(store.activeGame()).short}.` });
// game settings (league, budget, search sizes, rates) are only written for the game you're on
const setGameSetting = (k, v) => { if (sameGame()) store.setSetting(k, v); };
const G = (g) => gamesLib.gameOf(g || tg());
// one Path of Building per game, started when needed; only the game you're playing keeps one
// running (each holds ~250 MB once a build is loaded).
const pobEngs = {};
let pobEng = null; // PoE2's
function pobEngine() {
  return pobEngineFor(tg());
}
function pobEngineFor(game) {
  if (!pobEngs[game]) pobEngs[game] = createEngine({ log, appPath: path.join(__dirname, '..'), resourcesPath: process.resourcesPath, packaged: app.isPackaged, game });
  if (game === 'poe2') pobEng = pobEngs[game];
  return pobEngs[game];
}
// you changed game: give the other game's engine's memory back now, not after its idle time
function stopOtherEngines(game) {
  for (const [g, e] of Object.entries(pobEngs)) if (g !== game) { try { e.stop(); } catch (_) { /* ignore */ } }
}
function pobFile(id) { return path.join(app.getPath('userData'), 'pob', `${id || store.data.activeProfile || 'main'}.xml`); }
function pobXml() { try { return fs.readFileSync(pobFile(), 'utf8'); } catch (_) { return null; } }
function pobOverrides() {
  const out = [];
  for (const [slot, pobSlot] of Object.entries(pobVerdict.SLOT_TO_POB)) {
    const it = store.equipped[slot];
    if (it && it.raw && !it.fromPob) out.push({ slot: pobSlot, text: it.raw });
  }
  return out;
}
function pobOn() { return store.settings.usePob !== false && pobEngine().available() && !!pobXml(); }
let pobSheetGen = 0; // bumped whenever build or gear changes, so the Character page recalculates
function pobSync() { pobQueries.clear(); pobSheetGen++; if (pobOn()) pobEngine().setBuild(pobXml(), pobOverrides()); }
// each game has its own priorities (store GAME_KEYS); in PoE1 chaos resistance counts by default
const pobPriorities = () => ({ ...pobVerdict.DEFAULT_PRIORITIES, ...(tg() === 'poe1' ? { chaos: true } : {}), ...(store.settings.priorities || {}) });
// Chaos Inoculation (seen in your PoB build) makes chaos resistance irrelevant
// (remembered per character from the last time PoB loaded the build, so it doesn't flip when the engine idles)
const pobCI = () => {
  const i = pobEngs[tg()] && pobEngs[tg()].info();
  if (i && i.stats && pobOn()) { const ci = pobVerdict.hasCI(i.stats); const m = store.settings.pobCI || {}; if (m[store.data.activeProfile] !== ci) store.setSetting('pobCI', { ...m, [store.data.activeProfile]: ci }); return ci; }
  return pobOn() && !!(store.settings.pobCI || {})[store.data.activeProfile];
};
const pobWeights = () => ({ damageWeight: store.settings.pobDamageWeight == null ? 0.6 : Number(store.settings.pobDamageWeight), priorities: pobPriorities(), ignoreChaos: pobCI() });
// list: [{ item, slot }] -> a PoB verdict for each (or null)
async function pobJudge(list) {
  if (!pobOn() || !list.length) return list.map(() => null);
  const req = []; const idx = [];
  list.forEach((x, i) => {
    const text = x.item && (x.item.raw || x.item.listingText);
    if (!text) return;
    // jewels: PoB tries it in every jewel socket you've allocated on the tree
    if (x.item.slot === 'Jewel' || /^Jewel \d$/.test(x.slot || '')) { req.push({ slot: 'Jewel', text }); idx.push([i, 'Jewel']); return; }
    if (x.item.slot === 'Flask') { req.push({ slot: 'Flask', text }); idx.push([i, 'Flask']); return; }
    // PoE1: a third ring slot (The Unseen Hand) when your build has a ring there
    if (tg() === 'poe1' && x.item.slot === 'Ring' && (((pobEngine().info() || {}).gear) || {})['Ring 3']) { req.push({ slot: 'Ring 3', text }); idx.push([i, 'Ring 3']); }
    const group = x.item.slot && SLOT_GROUPS[x.item.slot];
    const slots = group && group.every((g) => pobVerdict.SLOT_TO_POB[g]) ? group : [x.slot || x.item.slot];
    for (const sl of slots) { const ps = pobVerdict.SLOT_TO_POB[sl]; if (ps) { req.push({ slot: ps, text }); idx.push([i, sl]); } }
  });
  const per = list.map(() => []);
  const errs = list.map(() => null);
  if (req.length) {
    const res = await pobEngine().evalItems(req);
    res.forEach((r, k) => {
      if (!r || !r.ok) { if (r && r.error && !errs[idx[k][0]]) errs[idx[k][0]] = String(r.error); return; }
      if (r.multi && idx[k][1] === 'Flask') {
        for (const m of flaskSlots(r)) {
          const j = pobVerdict.judge(m.before || r.before, m.after, pobWeights());
          if (!j) continue;
          j.slot = 'Flask'; j.socket = { kind: 'flask', slot: m.slot, label: m.label, replacing: m.replacing || null, active: m.active };
          const note = flaskNote(r, m);
          if (note) j.flaskNote = note;
          // a life / mana flask in place of the same kind: its recovery isn't in Path of Building's
          // damage and effective HP, so clearly more (or less) recovery decides when PoB sees no change
          const rec = flaskRecovery(r, m);
          if (rec && ['same', 'small'].includes(j.verdict)) {
            if (rec.ratio >= 1.15) { j.byRecovery = true; j.verdict = rec.ratio >= 1.4 ? 'upgrade' : 'small'; j.flaskNote = `Judged on recovery (Path of Building's damage and effective HP don't count it): ${Math.round((rec.ratio - 1) * 100)}% more ${rec.what} than yours. ${j.flaskNote || ''}`.trim(); }
            else if (rec.ratio <= 0.87) { j.byRecovery = true; j.verdict = 'downgrade'; j.flaskNote = `Judged on recovery (Path of Building's damage and effective HP don't count it): ${Math.round((1 - rec.ratio) * 100)}% less ${rec.what} than yours. ${j.flaskNote || ''}`.trim(); }
          }
          if (!m.active && m.replacing) j.breaks.push(`Your ${m.label} is switched off in your Path of Building build, so it was switched on for this check`);
          per[idx[k][0]].push(j);
        }
        if (!per[idx[k][0]].length) errs[idx[k][0]] = errs[idx[k][0]] || 'Path of Building has no flask slot this fits.';
        return;
      }
      if (r.multi) {
        // a jewel that's already in one of your sockets is only compared with itself there
        const nm = list[idx[k][0]].item && list[idx[k][0]].item.name;
        const own = r.multi.filter((m) => nm && m.replacing === nm);
        // PoE1: taking out a cluster jewel would remove its passives, which PoB's quick calculation
        // keeps: a result in a cluster jewel's socket would overstate, so those sockets aren't tried
        const usable = own.length ? own : r.multi.filter((m) => !m.replacingCluster);
        // "Limited to: 1" (Watcher's Eye...): PoB ignores a second copy, so one you have is only swapped for itself
        const lim = list[idx[k][0]].item && list[idx[k][0]].item.limitedTo;
        if (!usable.length) { errs[idx[k][0]] = errs[idx[k][0]] || 'Your only jewel sockets this fits hold cluster jewels, which the app can\'t judge a swap for yet.'; return; }
        for (const m of usable) {
          const j = pobVerdict.judge(r.before, m.after, pobWeights());
          if (j) { j.slot = idx[k][1]; j.socket = { slot: m.slot, label: m.label, replacing: m.replacing || null }; if (lim && own.length) j.limitNote = `Limited to ${lim}: compared in place of the one in your tree`; per[idx[k][0]].push(j); }
        }
        return;
      }
      const j = pobVerdict.judge(r.before, r.after, pobWeights());
      if (j) { j.slot = idx[k][1]; gearBreaks(j, list[idx[k][0]].item, req[k].slot); per[idx[k][0]].push(j); }
    });
  }
  const out = per.map((arr) => pobVerdict.best(arr));
  out.errors = errs; // why PoB couldn't judge an item, when it said
  return out;
}
// which flask slots a flask is compared in: the one with the same flask (base) first, else the
// same kind (life with life, mana with mana), else your utility flasks / tinctures and empty slots
function flaskSlots(r) {
  const m = r.multi || [];
  const same = m.filter((x) => x.replacingBase && x.replacingBase === r.base);
  if (same.length) return same;
  const life = (x) => /^(Life|Mana|Hybrid)$/.test(x || '');
  if (life(r.sub)) { const k = m.filter((x) => x.replacingSub === r.sub); if (k.length) return k; }
  const other = m.filter((x) => !x.replacing || (!life(x.replacingSub) && (x.replacingType === r.type || !r.type)));
  return other.length ? other : m;
}
// how a life / mana flask's recovery compares with the one it replaces (same kind only)
function flaskRecovery(r, m) {
  const a = r.flask; const b = m.replacingFlask;
  if (!a || !b || !m.replacing || m.replacingSub !== r.sub) return null;
  for (const [k, what] of [['life', 'life'], ['mana', 'mana']]) if (a[k] > 0 && b[k] > 0) return { ratio: a[k] / b[k], what };
  return null;
}
// life / mana flasks: their recovery isn't in the damage / effective HP numbers, so it's said
function flaskNote(r, m) {
  const a = r.flask; const b = m.replacingFlask;
  if (!a) return null;
  const n = (v) => Math.round(v).toLocaleString('en');
  const part = (k, word) => (a[k] > 0 ? `${n(a[k])} ${word}${b && b[k] > 0 ? ` (yours: ${n(b[k])})` : ''}` : null);
  const rec = [part('life', 'life'), part('mana', 'mana')].filter(Boolean);
  if (!rec.length) return null;
  return `Recovers ${rec.join(' and ')}${a.duration ? ` over ${a.duration}s` : ''}`;
}
// PoE1 checks Path of Building's quick calculation can't make: it keeps your gems linked whatever
// the new item's sockets are, and judges a quiver as if any weapon could use it
function gearBreaks(j, item, pobSlot) {
  if (!item) return;
  // amulets: the anoint (PoE1) or instill (PoE2) is part of the item, so Path of Building counts yours as
  // lost on one without it (and adds the new one's); say so, since it can be put on again
  if (pobSlot === 'Amulet') {
    const anoint = (it) => { const m = String((it && (it.raw || it.listingText)) || '').match(/^Allocates (.+?)(?: \(enchant\))?\s*$/m); return m ? m[1].trim() : null; };
    const mine = anoint(store.equipped.Amulet); const theirs = anoint(item);
    const p1 = tg() === 'poe1';
    if (mine && mine !== theirs) j.breaks.push(`Your amulet's ${p1 ? 'anoint' : 'instilled passive'} (${mine}) isn't on this one${theirs ? ` (it has ${theirs})` : ''}: the verdict counts that. ${p1 ? 'Anointing it again costs oils' : 'Instilling it again costs Distilled Emotions'}`);
  }
  if (tg() !== 'poe1') return;
  const add = (msg, bad) => {
    j.breaks.push(msg);
    if (bad || !(j.score > 0)) { if (!['resloss', 'dmgloss'].includes(j.verdict)) j.verdict = 'downgrade'; } else if (['upgrade', 'small', 'same'].includes(j.verdict)) j.verdict = 'risky';
  };
  const g = ((pobEngine().info() || {}).slotGems || {})[pobSlot];
  if (g && g.gems >= 2 && /^(Weapon [12]|Helmet|Body Armour|Gloves|Boots)$/.test(pobSlot)) {
    const links = item.links || (item.socketCount ? 1 : 0);
    if (links < g.gems) {
      const what = links ? `It has a ${links}-link` : 'It has no sockets';
      add(`${what}: your ${g.label || 'gems'} in this slot use${g.gems === 1 ? 's' : ''} ${g.gems} linked gems${item.corrupted || links === 0 ? '' : ' (link it first)'}`, !!item.corrupted || links === 0);
    }
  }
  const wep = store.equipped.Weapon;
  if (/^Quivers?$/i.test(item.itemClass || '') && wep && !/^Bows?$/i.test(wep.itemClass || '')) add('Quivers only work with a bow, and your weapon isn\'t one', true);
}
// PoE1 flasks and tinctures: Path of Building tries them in each of your five flask slots
const isFlaskClass = (item) => !!item && /flask|tincture/i.test(item.itemClass || '');
// cluster and timeless jewels change the passive tree itself, which the quick calculation doesn't redo
const isClusterJewel = (item) => !!item && (!!item.cluster || / Cluster Jewel$/i.test(item.baseType || ''));
const isTimelessJewel = (item) => !!item && (/^Timeless Jewel$/i.test(item.baseType || '') || /^Timeless Jewel$/i.test(item.name || ''));
// PoE1 items Path of Building isn't asked about, and why (shown instead of a verdict)
function poe1Unjudged(item, slot) {
  if (!item) return null;
  if (isClusterJewel(item)) return "Cluster jewels aren't judged yet: they add passives, which the app's Path of Building check doesn't redo.";
  if (isTimelessJewel(item)) return "Timeless jewels aren't judged yet: their passive changes need data that doesn't come with the app.";

  if (!pobCanJudge(item, slot)) return null;
  if (!pobOn()) return pobEngine().available() ? 'Not judged: PoE1 items are judged by Path of Building only. Paste your Path of Building Community build on My gear.' : "Not judged: Path of Building for PoE1 isn't installed with this copy of the app.";
  return null;
}
// can Path of Building judge this item? (charms and flasks use the gear score)
function pobCanJudge(item, slot) {
  if (!item) return false;
  if (tg() === 'poe1' && (isClusterJewel(item) || isTimelessJewel(item))) return false;
  if (item.slot === 'Flask') return tg() === 'poe1';
  if (item.slot === 'Jewel' || /^Jewel \d$/.test(slot || '')) return true;
  const group = item.slot && SLOT_GROUPS[item.slot];
  return !!(pobVerdict.SLOT_TO_POB[slot] || (group && group.every((g) => pobVerdict.SLOT_TO_POB[g])) || pobVerdict.SLOT_TO_POB[item.slot]);
}
const pobErrorOf = (res, i) => (res && res.errors && res.errors[i]) || 'Path of Building could not read this item.';
// Path of Building's own weighted trade search for a slot ("Trader"), trimmed to what the trade
// site accepts; every listing it finds is then checked exactly with your build.
const pobQueries = new Map(); // slot|weights -> { at, r }
// which of your tree's jewel sockets a jewel search is for: the one holding this jewel if it's in
// your tree, otherwise your first socketed one (the weights are the same for every normal socket)
function pobJewelSocket(item) {
  const socks = ((pobEngine().info() || {}).sockets) || [];
  return (item && socks.find((s) => s.jewel && s.jewel === item.name)) || socks.find((s) => s.jewel) || socks[0] || null;
}
const isRadiusJewel = (item) => !!item && (/^Time-Lost /i.test(item.baseType || '') || (item.lines || []).some((l) => /^Radius:/i.test(l.text || '')));

async function pobQueryFor(slot, item) {
  const eng = pobEngine();
  const info = await eng.ensureLoaded();
  const key = pobVerdict.dpsKey(info && info.stats);
  const w = pobWeights().damageWeight;
  // the damage number PoB's search should raise: the same one the verdicts use for this build
  const dmgStat = { MinionDPS: 'MinionCombinedDPS', FullDPS: 'FullDPS', CombinedDPS: 'CombinedDPS', TotalDPS: 'TotalDPS' }[key] || 'FullDPS';
  const weights = [{ stat: dmgStat, weightMult: w }, { stat: 'TotalEHP', weightMult: Math.max(0.05, 1 - w) }];
  let pobSlotName = pobVerdict.SLOT_TO_POB[slot]; let jewelType;
  if (slot === 'Jewel') {
    const sock = pobJewelSocket(item);
    if (!sock) throw new Error('Your Path of Building build has no allocated jewel socket.');
    // PoB2 knows Base and Radius jewels; PoB1 Base and Abyss
    if (tg() === 'poe1') {
      const abyss = !!item && (!!item.abyss || /Abyss Jewels?/i.test(item.itemClass || '') || /^(Murderous|Searching|Hypnotic|Ghastly) Eye Jewel$/i.test(item.baseType || ''));
      const s2 = abyss ? (((pobEngine().info() || {}).sockets) || []).find((x) => x.abyssal) : null;
      if (abyss && !s2) throw new Error('Your Path of Building build has no abyssal socket for this jewel.');
      pobSlotName = (s2 || sock).slot; jewelType = abyss ? 'Abyss' : 'Base';
    } else { pobSlotName = sock.slot; jewelType = isRadiusJewel(item) ? 'Radius' : 'Base'; }
  }
  const ck = `${store.data.activeProfile}|${slot}|${jewelType || ''}|${w}`; // resistance priority is applied after, per search
  const hit = pobQueries.get(ck);
  if (hit && Date.now() - hit.at < 15 * 60000) return hit.r;
  const t0 = Date.now();
  const r = await eng.makeQuery({ slot: pobSlotName, weights, jewelType });
  r.query = typeof r.query === 'string' ? JSON.parse(r.query) : r.query;
  log(`pob: built a ${slot} search in ${Date.now() - t0} ms (${((r.query.query.stats || []).find((g) => g.type === 'weight') || { filters: [] }).filters.length} weighted stats)`);
  pobQueries.set(ck, { at: Date.now(), r });
  return r;
}
async function pobSearch(item, slot, league, budget, opts) {
  const pq = await pobQueryFor(slot, item);
  const all = JSON.parse(JSON.stringify(pq.query));
  const wg = (all.query.stats || []).find((g) => g.type === 'weight');
  if (!wg || !wg.filters.length) return null;
  // "cap resistances first": push the resistances you're still missing to the top of the search
  const pr = pobPriorities();
  const boosted = [];
  if (pr.resFirst && opts.statIndex) {
    const info = pobEngine().info();
    const st = (info && (info.stats || {})) || {};
    const short = ['Fire', 'Cold', 'Lightning', ...(pr.chaos && !pobCI() ? ['Chaos'] : [])].filter((El) => {
      const v = Number(st[`${El}Resist`]); const tot = Number(st[`${El}ResistTotal`]);
      const max = Number(st[`${El}ResistMax`]) || 75; // your real cap (e.g. raised by passives)
      return Number.isFinite(v) && v < max - 0.5 && !(tot > v + 0.5);
    });
    if (short.length) {
      const re = new RegExp(`^\\+?#% to (all Elemental Resistances|(${short.join('|')})( and (Fire|Cold|Lightning|Chaos))? Resistances?|(Fire|Cold|Lightning|Chaos) and (${short.join('|')}) Resistances)$`, 'i');
      const ids = (opts.statIndex.all || []).filter((e) => (e.type === 'explicit' || e.type === 'implicit') && re.test(e.text)).map((e) => e.id);
      // Each resistance point counts half as much as a point of your best % stat (e.g. minion damage).
      // So an item with your damage mods *and* the resistance comes first, and one with only a big
      // resistance roll doesn't push them out. (Matching the top stat filled the search with res-only rings.)
      const text = new Map((opts.statIndex.all || []).map((e) => [e.id, e.text]));
      const isRes = (id) => /Resistances?$/i.test(text.get(id) || '');
      const pctW = wg.filters.filter((f) => !isRes(f.id) && /#%/.test(text.get(f.id) || '')).map((f) => Math.abs(f.value.weight));
      const ref = pctW.length ? Math.max(...pctW) : Math.max(...wg.filters.map((f) => Math.abs(f.value.weight)), 1);
      for (const id of ids) {
        const f = wg.filters.find((x) => x.id === id);
        if (f) f.value.weight = Math.max(f.value.weight, ref * 0.5);
        else wg.filters.push({ id, value: { weight: ref * 0.5 } });
        boosted.push(id);
      }
      log(`pob search: resistances first – boosting ${short.join(', ')} res (${ids.length} stats)`);
    }
  }
  wg.filters.sort((a, b) => Math.abs(b.value.weight) - Math.abs(a.value.weight));
  // "never lose damage": the weighted sum alone happily trades your damage mods for one big
  // resistance roll (PoB values filling a resistance highly), so a listing must also have as many of
  // the build's damage mods as the item you wear in this slot (up to 2)
  let dmgGroup = null;
  if (pr.keepDmg && opts.statIndex) {
    const text = new Map((opts.statIndex.all || []).map((e) => [e.id, e.text]));
    const norm = (t) => String(t || '').replace(/^\+/, '').toLowerCase();
    const isDmg = (t) => /damage|critical|attack speed|cast speed|cooldown|level of|minions? (deal|have)/i.test(t) && !/resistances?$|energy shield|armour|evasion|life|mana/i.test(t);
    const dmg = wg.filters.filter((f) => f.value.weight > 0 && isDmg(text.get(f.id))).slice(0, 8);
    // for jewels: the jewel in the socket the search is for (as saved on My gear, matched by name)
    const sockJewel = slot === 'Jewel' && pobJewelSocket(item) ? pobJewelSocket(item).jewel : null;
    const worn = slot === 'Jewel' ? Object.entries(store.equipped).filter(([k]) => /^Jewel /.test(k)).map(([, v]) => v).find((v) => v && v.name === sockJewel) || null : store.equipped[slot];
    const have = new Set(Object.keys((worn && worn.stats) || {}).map(norm));
    const own = new Set(dmg.filter((f) => have.has(norm(text.get(f.id)))).map((f) => norm(text.get(f.id)))).size;
    if (own > 0 && dmg.length) {
      dmgGroup = { type: 'count', value: { min: Math.min(2, own) }, filters: dmg.map((f) => ({ id: f.id, disabled: false })) };
      log(`pob search: never lose damage – needs ${dmgGroup.value.min} of ${dmg.length} damage stats (your ${slot} has ${own})`);
    }
  }
  // the site's complexity limit is lower when you're not signed in: start at the size it took last time
  const SIZES = [30, 15, 10, 7, 5, 3];
  const sizeKey = (await signedIn()) ? 'signed' : 'anon';
  let size = Math.min((store.settings.pobSearchSize || {})[sizeKey] || 0, SIZES.length - 1);
  let r = null; let body = null;
  for (;;) {
    body = JSON.parse(JSON.stringify(all));
    const g = body.query.stats.find((x) => x.type === 'weight');
    g.filters = g.filters.slice(0, SIZES[size]);
    if (dmgGroup) body.query.stats.push({ ...dmgGroup, filters: dmgGroup.filters.slice(0, Math.max(3, Math.min(8, SIZES[size] / 2))) });
    body.query.status = { option: trade.statusOpt(opts.status) };
    delete body.engine;
    trade.applyBudget(body, budget, tg());
    r = await runSearch(league, body, `pob ${slot}${size ? ` size${size}` : ''}`);
    if (!(r && r.tooComplex) || size >= SIZES.length - 1) break;
    size++;
    setGameSetting('pobSearchSize', { ...(store.settings.pobSearchSize || {}), [sizeKey]: size });
  }
  if (r && r.tooComplex) return { ok: false, error: `The trade site says this search has too many filters.${(await signedIn()) ? '' : ' Signing in to pathofexile.com (Settings → Trade site account) raises the limit.'}` };
  if (!r || !r.ok) return r;
  let droppedDmg = false;
  if (!r.total && dmgGroup) {
    // nothing with your damage mods in this budget: show the best without that rule (marked LOSES DAMAGE)
    body.query.stats = body.query.stats.filter((x) => x.type !== 'count');
    const r2 = await runSearch(league, body, `pob ${slot} no-dmg-rule`);
    if (r2 && r2.ok) { r = r2; dmgGroup = null; droppedDmg = true; }
  }
  const used = body.query.stats.find((x) => x.type === 'weight').filters.length;
  const needDmg = dmgGroup ? `; every listing has at least ${dmgGroup.value.min} of your damage mods` : droppedDmg ? '; nothing in your budget has your damage mods, so these may lose damage' : '';
  const ctx = {
    item, mode: 'pob', body, searchKey: searchKey(body),
    title: `Best for your build: ${item.slot === 'Ring' ? 'rings' : slot === 'Jewel' ? (tg() !== 'poe1' && isRadiusJewel(item) ? 'radius jewels' : item.abyss ? 'abyss jewels' : 'jewels') : slot}`,
    note: `Path of Building weighted this search by what each stat does to your build (${used} stats${used < wg.filters.length ? `, the trade site allowed ${used} of ${wg.filters.length}` : ''})${boosted.length ? ', with extra weight on the resistances you still need' : ''}${needDmg}. Every listing below is then checked with your build: items that lose resistance or damage are marked and go to the bottom.`,
  };
  if (opts.noOpen) return { ok: true, r, body, ctx, filters: used }; // "where to spend" looks at the listings itself
  const res = await openIfAny(r, ctx);
  return { ...res, mode: 'pob', filters: used };
}

// put a PoB verdict onto a comparison (popup result or listing compare)
function applyPob(r, j) {
  if (!r || !j) return r;
  r.pob = j;
  r.verdict = j.verdict;
  r.scoreMode = 'pob';
  r.delta = j.byRecovery ? null : j.score; // a flask judged by its recovery: no "0% for your build"
  r.pct = null;
  if (j.socket) { r.replacing = [j.socket.replacing ? `${j.socket.replacing} (${j.socket.label})` : `an empty ${j.socket.kind === 'flask' ? 'flask slot' : 'jewel socket'} (${j.socket.label})`]; if (j.socket.kind === 'flask') r.targetSlot = j.socket.label; }
  else if (j.slot === 'Ring 3') { const g3 = (((pobEngine().info() || {}).gear) || {})['Ring 3']; r.targetSlot = 'Ring 3'; r.replacing = [g3 ? `${g3} (Ring 3)` : 'Ring 3']; }
  else if (j.slot && j.slot !== r.targetSlot && store.equipped[j.slot]) { r.targetSlot = j.slot; r.replacing = [store.equipped[j.slot].name]; }
  if (j.flaskNote) r.flaskNote = j.flaskNote;
  if (j.limitNote) r.limitNote = j.limitNote;
  r.risks = j.breaks.length ? j.breaks : null;
  r.resRank = j.resRank;
  return r;
}
function liveResists() { return resLib.live(store.settings.resists, store.equipped); }
function resNeedFor(slot) {
  const rs = liveResists();
  if (!rs || !slot) return null;
  // resistance keeps counting until you're over the cap by the safety buffer
  const cur = store.equipped[slot];
  const out = {};
  let any = false;
  for (const [El, el] of Object.entries(RES_EL)) {
    const total = Number(rs[el]);
    if (rs[el] === '' || rs[el] == null || !Number.isFinite(total)) continue;
    const fromSlot = cur && cur.stats ? (cur.stats[`#% to ${El} Resistance`] || 0) : 0;
    const cap = ((rs.caps && rs.caps[el]) || rs.cap) + (rs.buffer || 0);
    out[El] = Math.max(0, cap - (total - fromSlot));
    any = true;
  }
  return any ? out : null;
}

// gear score of `item` if it went in `slot` (defaults to the item's own slot)
// the gear score's build profiles are for PoE2; PoE1 items are judged by Path of Building only
const gearScoreOn = () => store.settings.build !== 'off' && tg() === 'poe2';
function gearOf(item, slot) {
  if (!item || !gearScoreOn()) return null;
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
  const gearOn = gearScoreOn();
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
        // a few points either way is noise: only +6 or more is a real upgrade
        r.verdict = r.delta >= 6 ? 'upgrade' : r.delta >= 3 ? 'small' : r.delta <= -3 ? 'downgrade' : 'same';
      }
    }
  } else {
    r.scoreMode = 'weights';
    r.gearEquipped = r.isEquipped ? null : gearOf(store.equipped[r.targetSlot], r.targetSlot);
  }
  // what changes on your character if you equip it
  if (!r.isEquipped && r.targetSlot) {
    const slots = [r.targetSlot];
    if (item.twoHanded && r.targetSlot === 'Weapon' && store.equipped.Offhand) slots.push('Offhand');
    try {
      r.character = characterLib.changeIfEquipped(store.equipped, item, slots, {
        resists: liveResists(),
        gearScore: gearOn ? (it, sl) => { const g = gearOf(it, sl); return g && g.score != null ? g.score : null; } : null,
      });
    } catch (err) { log('character change: ' + err.message); }
    // things the score doesn't see that can make an "upgrade" a sidegrade (or worse)
    const ch = r.character;
    const risks = [];
    if (ch) {
      const sp = (ch.lines || []).find((l) => l.label === 'Spirit');
      if (sp && sp.delta < 0) risks.push(`Spirit ${sp.delta}: check your minions and auras still fit`);
      for (const w of ch.warnings || []) risks.push(w);
      const lv = (ch.lines || []).find((l) => l.label === 'Minion skill levels');
      if (lv && lv.delta < 0) risks.push(`${lv.delta} minion skill level${lv.delta === -1 ? '' : 's'}`);
      // your resistance totals aren't known: a big drop can't be checked against the cap, so it's said
      for (const x of ch.res || []) {
        if (x.from == null && x.delta <= -10 && (x.el !== 'chaos' || pobPriorities().chaos)) risks.push(`${x.label || x.el} ${x.delta}%: type your resistances on My gear (or add your Path of Building build) to see if this takes you under the cap`);
      }
    }
    if (risks.length) {
      r.risks = risks;
      if (r.verdict === 'upgrade' || r.verdict === 'small') r.verdict = 'risky';
    }
    // resistances matter most: losing them (off the cap or further under it) is its own verdict
    const lost = ch ? (ch.res || []).filter((x) => x.from != null && x.delta < 0 && x.under && (x.el !== 'chaos' || (!pobCI() && (pobPriorities().chaos || !x.wasUnder)))) : [];
    if (lost.length && !r.isEquipped) r.verdict = 'resloss';
    r.resRank = lost.length ? -1 : ch && (ch.res || []).some((x) => x.wasUnder && !x.under) ? 2 : ch && (ch.res || []).some((x) => x.wasUnder && x.delta > 0) ? 1 : 0;
  }
  // how much each changed stat matters to the build (for colours / top changes)
  const go = gearOpts();
  r.rows = r.rows.map((row) => ({ ...row, useful: gearOn ? gearLib.usefulness(item.slot, row.key, go) : (row.weight || 0) }))
    .sort((a, b) => Math.abs(b.diff * b.useful) - Math.abs(a.diff * a.useful) || Math.abs(b.diff) - Math.abs(a.diff));
  // PoE1: no gear score, so without Path of Building there's no honest verdict to give
  // PoE1 flasks have no slot of their own in the app: Path of Building's flask slots decide, so
  // until it answers (or without a build) there's no verdict, never "empty slot"
  if (item.slot === 'Flask') { r.verdict = 'unjudged'; r.delta = null; r.pct = null; r.unjudged = poe1Unjudged(item, r.targetSlot) || null; }
  // (an "empty" slot in PoE1 usually just means nothing was saved there, so it's no verdict either)
  else if (tg() === 'poe1' && !r.isEquipped) {
    const why = poe1Unjudged(item, r.targetSlot);
    if (why) { r.verdict = 'unjudged'; r.unjudged = why; r.delta = null; r.pct = null; }
  }
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
    alwaysOnTop: true, skipTaskbar: true, focusable: false, hasShadow: false,
    webPreferences: {
      preload, contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false,
    },
  });
  popup.setAlwaysOnTop(true, 'screen-saver');
  popup.loadFile(path.join(__dirname, 'ui', 'popup.html'));
  popup.on('blur', () => { if (!popupHovered) scheduleHide(1500); });
  // you dragged it (by its name): it stays there from now on (Settings → Popup → Position: where I dragged it)
  let moveTimer = null;
  popup.on('move', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (!popup || !popup.isVisible() || !placedAt) return;
      const b = popup.getBounds();
      if (Math.abs(b.x - placedAt.x) <= 2 && Math.abs(b.y - placedAt.y) <= 2) return; // our own placing
      placedAt = { x: b.x, y: b.y };
      store.setSetting('popupDragged', { x: b.x, y: b.y });
      if (store.settings.popupPosition !== 'dragged') { store.setSetting('popupPosition', 'dragged'); notifySettings('settings:changed'); }
      log(`popup dragged to ${b.x},${b.y}`);
    }, 250);
  });
  popup.on('closed', () => { popup = null; });
  popup.webContents.on('render-process-gone', () => { try { popup.destroy(); } catch (_) {} popup = null; });
}

function uiScale() { const v = Number(store && store.settings.uiScale); return v >= 0.8 && v <= 1.6 ? v : 1; }
function popupWidth() { return Math.round(400 * uiScale()); }

// Where the popup goes (Options → Popup position): next to the mouse, or
// pinned to a side / the top of the screen so it never covers the game's tooltip.
let placedAt = null; // where the app last put the popup: a different place means you dragged it
function placePopupNearCursor(height) {
  const cursor = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(cursor).workArea;
  const w = popupWidth();
  const h = Math.max(120, Math.min((height || 300) * uiScale(), area.height - 20));
  let pos = store.settings.popupPosition || 'cursor';
  const dragged = store.settings.popupDragged;
  if (pos === 'dragged' && !(dragged && Number.isFinite(dragged.x) && Number.isFinite(dragged.y))) pos = 'cursor';
  let x; let y;
  let area2 = area;
  if (pos === 'dragged') { area2 = screen.getDisplayNearestPoint({ x: dragged.x, y: dragged.y }).workArea; x = dragged.x; y = dragged.y; }
  else if (pos === 'left') { x = area.x + 16; y = area.y + Math.round(area.height * 0.12); }
  else if (pos === 'right') { x = area.x + area.width - w - 16; y = area.y + Math.round(area.height * 0.12); }
  else if (pos === 'top') { x = area.x + Math.round((area.width - w) / 2); y = area.y + 16; }
  else {
    // Prefer the right of the cursor; flip left if it would go off screen.
    x = cursor.x + 24;
    if (x + w > area.x + area.width) x = cursor.x - w - 24;
    y = cursor.y - Math.round(h / 3);
  }
  x = Math.max(area2.x + 4, Math.min(x, area2.x + area2.width - w - 4));
  y = Math.max(area2.y + 4, Math.min(y, area2.y + area2.height - h - 4));
  placedAt = { x: Math.round(x), y: Math.round(y) };
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
    // the renderer reports CSS pixels; the window is zoomed by uiScale. Keep it on screen.
    const b = popup.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const h = Math.round(Math.min(Math.max(height * uiScale(), 120), area.height - 8));
    const y = Math.max(area.y + 4, Math.min(b.y, area.y + area.height - h - 4));
    placedAt = { x: b.x, y };
    popup.setBounds({ ...b, y, height: h });
  }
  if (!popupHovered) scheduleHide((store.settings.autoHideSeconds || 12) * 1000);
}

let popupItem = null;
let popupSeq = 0; // bumped by every new render; a late PoB answer for an older one is dropped
function showResult(result) {
  const seq = ++popupSeq;
  popupItem = result && result.item ? recentItems.get(result.item.id) || result.item : null;
  if (!popup) createPopup();
  pendingShow = true; // every new copy re-positions the popup at the cursor
  const withPob = result && result.ok && result.kind !== 'price' && result.kind !== 'map' && !result.isEquipped && result.item && pobOn() && pobCanJudge(result.item, result.targetSlot);
  if (withPob) result.pobPending = true;
  const send = () => popup && popup.webContents.send('popup:result', serialise(result));
  if (popup.webContents.isLoading()) popup.webContents.once('did-finish-load', send);
  else send();
  if (withPob) {
    const item = popupItem;
    pobJudge([{ item: result.item.raw ? result.item : (item || result.item), slot: result.targetSlot }]).then((res) => {
      const j = res[0];
      result.pobPending = false;
      if (!j) result.pobError = pobErrorOf(res, 0);
      else applyPob(result, j);
    }).catch((err) => { result.pobPending = false; result.pobError = err.message; log('pob: ' + err.message); })
      .then(() => { if (seq === popupSeq && popupItem === item && popup && !popup.isDestroyed() && popup.isVisible()) popup.webContents.send('popup:result', serialise(result)); });
  }
  // uniques: poe.ninja's price next to the verdict
  if (result && result.ok && result.kind !== 'price' && result.item && /unique/i.test(result.item.rarity || '')) {
    const item = popupItem;
    ninjaPrice(result.item).then((p) => { if (p) { result.ninja = p; result.sellNote = ninjaLib.sellNote(p); } })
      .catch((err) => log('poe.ninja: ' + err.message))
      .then(() => { if (result.ninja && seq === popupSeq && popupItem === item && popup && !popup.isDestroyed() && popup.isVisible()) popup.webContents.send('popup:result', serialise(result)); });
  }
  // Renderer replies with its height via popup:resize; show anyway if it doesn't.
  clearTimeout(showFallback);
  showFallback = setTimeout(() => { if (pendingShow) revealPopup(null); }, 400);
}

// the league searches and prices are for, as far as the app knows without waiting: the one you
// picked for this game, else the one the trade site lists first (shown in the popup, so a Standard
// player sees at once that it's set)
function shownLeague() {
  try { const d = tradeDataBy[tg()]; return d ? pickLeague(d) : (store.settings.league || null); } catch (_) { return store.settings.league || null; }
}
function serialise(result) {
  return JSON.parse(JSON.stringify({
    ...result, links: (result && result.links) || (result && result.item ? ninjaLib.infoLinks(result.item, tg()) : []), pobNudge: !!(result && result.ok && !result.pob && !result.pobPending && !result.pobError && pobEngine().available() && !pobXml()), slots: SLOTS, slotGroups: SLOT_GROUPS, budgetLabel: trade.budgetLabel(budgetNow(), tg()),
    ui: { detail: store.settings.popupDetail || 'compact', colorblind: !!store.settings.colorblind, divineRate: store.settings.divineRate || null },
    worthEx: result && result.item && result.item.id && lastWorth.has(result.item.id) ? lastWorth.get(result.item.id) : null,
    game: tg(), league: shownLeague(), unit: G().baseShort, gameBeta: !!G().beta, gameShort: G().short,
  }));
}

ipcMain.on('popup:resize', (_e, height) => revealPopup(Number(height) || null));

ipcMain.on('popup:hover', (_e, hovered) => {
  popupHovered = !!hovered;
  // the popup only becomes focusable while the mouse is on it (so its inputs work),
  // otherwise the game keeps the keyboard: no more clicking the game after every copy
  try {
    if (popup && !popup.isDestroyed()) {
      popup.setFocusable(popupHovered);
      if (!popupHovered && popup.isFocused()) popup.blur();
    }
  } catch (_) { /* ignore */ }
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
// Which game a copy came from (the game window, else the item text, else the game you played
// last), and switch to your character for that game. Returns the game, or null if unknown.
// When the item text can't tell (a plain ring copied with Ctrl+C), it's the game of the character
// you have open: picking a character by hand is never undone by an ambiguous copy.
function followGame(text, sent) {
  const game = gamesLib.detectGame({ sent, text, last: store.activeGame() });
  if (!game) return null;
  if (game !== store.data.lastGame) { store.data.lastGame = game; store.save(); log(`playing ${gamesLib.gameOf(game).short}`); }
  useGame(game);
  return game;
}
// make `game` the one you're on: its character, or (first time) your untouched one or a new one
function useGame(game) {
  if (gamesLib.gameOf(game).supported && game !== store.activeGame()) {
    const id = store.profileForGame(game);
    const cur = store.data.activeProfile;
    if (id) {
      store.switchProfile(id);
      log(`switched to your ${gamesLib.gameOf(game).short} character "${store.data.profiles[id].name}"`);
    } else if (store.isUntouched(cur) && !pobXml()) {
      // the character you have open was never set up (a fresh install): make it this game's
      store.setProfileGame(cur, game);
      store.renameProfile(cur, `My ${gamesLib.gameOf(game).short} character`);
      store.setSetting('build', game === 'poe1' ? 'off' : (store.settings.build === 'off' ? gearLib.DEFAULT_BUILD : store.settings.build));
      log(`first ${gamesLib.gameOf(game).short} item: your empty character is now a ${gamesLib.gameOf(game).short} one`);
    } else {
      // first time in this game: a character of its own, so this game's items aren't judged
      // against the other game's gear (add its Path of Building build on My gear)
      store.createProfile(`My ${gamesLib.gameOf(game).short} character`, false, game);
      log(`first ${gamesLib.gameOf(game).short} item: made a new character for it`);
    }
    popupItem = null; // the item on show is the other game's: don't re-judge it with this one
    gameChanged();
  }
}
// the first-run guide: you pick the game (later, copying an item from the other game switches by itself)
ipcMain.handle('game:choose', (_e, game) => {
  if (!['poe1', 'poe2'].includes(game)) return { ok: false };
  store.data.lastGame = game; store.save();
  useGame(game);
  return { ok: true, game: store.activeGame() };
});

// Everything that has to follow when the game you're on changes (a copy from the other game,
// picking or importing a character of the other game): one place, so nothing is left behind.
let shownGame = null;
function gameChanged() {
  const game = tg();
  if (game === shownGame) { pobSync(); refreshAll(); buildTrayMenu(); return; }
  const from = shownGame; shownGame = game;
  store.data.lastGame = game;
  stopOtherEngines(game);
  pobSync();
  // results from the other game stay as they were (frozen) and get out of the way
  if (resultsState && resultsState.r.game && resultsState.r.game !== game && resultsWin && !resultsWin.isDestroyed()) resultsWin.hide();
  notifySettings('game:changed', { game, from });
  refreshAll(); buildTrayMenu();
  // this game's divine rate, so prices are right on the first search
  if (store.settings.autoRate !== false) refreshDivineRate(false).catch(() => {});
  log(`now on ${G(game).short}${from ? ` (was ${G(from).short})` : ''}`);
}

function handleItemText(text, source, sent) {
  const item = parseItem(text);
  if (!item) {
    log(`${source}: clipboard is not item text: ${JSON.stringify(String(text).slice(0, 80))}`);
    return false;
  }
  const game = followGame(text, sent);
  if (game && !gamesLib.gameOf(game).supported) {
    // a PoE1 item: say so instead of judging it against your PoE2 gear
    lastClip = text;
    log(`${source}: ${gamesLib.gameOf(game).short} item "${item.name}" (${item.itemClass}) – not supported yet`);
    if (source === 'clipboard' && !item.slot) return true;
    showResult({ ok: false, reason: `That's a ${gamesLib.gameOf(game).name} item. Support for ${gamesLib.gameOf(game).short} is being built: for now the app only judges Path of Exile 2 items. Your PoE2 characters and gear are kept separate.` });
    return true;
  }
  usage.used(game || store.activeGame());
  // PoE1 flasks and tinctures are judged by Path of Building in your flask slots
  if ((game || store.activeGame()) === 'poe1' && isFlaskClass(item)) item.slot = 'Flask';
  // Tag the clipboard so copying the same item again still counts as a change.
  // (Just a trailing line break; pasting into the trade site / PoB is unaffected.)
  try { const tagged = text.endsWith(TAG) ? text : text + TAG; clipboard.writeText(tagged); lastClip = tagged; } catch (_) { lastClip = text; }
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
  // a map or waystone: what its mods mean for your build
  if (mapLib.isMap(item)) { try { showMapCard(item); } catch (err) { log('popup failed: ' + err.stack); } return true; }
  // not gear (currency, a gem, a divination card...): its price
  if (!item.slot) { try { showPriceCard(item); } catch (err) { log('popup failed: ' + err.stack); } return true; }
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

// Why a hotkey press found no item, in words you can act on. sent: the key sender's answer
// ("fg=<process that got the keystroke>;over=<process under the mouse>[;refocused|;refocus-failed]")
function noItemReason(sent, text) {
  if (!sent) return (keys && keys.unavailable) || 'Couldn\'t send Ctrl+C to the game (the key sender didn\'t start). Press Ctrl+C on the item yourself, or see Tray → Open log.';
  const s = String(sent);
  const fg = (s.match(/fg=([^;]*)/) || [])[1] || ''; const over = (s.match(/over=([^;]*)/) || [])[1] || '';
  const isGame = (n) => /^PathOfExile/i.test(n);
  const me = path.basename(process.execPath, '.exe').toLowerCase();
  const isMe = (n) => n && (n === 'self' || n.toLowerCase() === me || /^electron$/i.test(n));
  const hk = store.settings.hotkey || DEFAULT_HOTKEY;
  if (/game-admin/.test(s)) return `${G(store.data.lastGame || tg()).name} is running as administrator, so Windows blocks the Ctrl+C this app sends it. Start the game normally (not "Run as administrator"), or start this app as administrator too.`;
  if (/hotkey-held/.test(s) && !text) return `${hk} was still held down when the copy was sent, so the game didn't see it. Tap ${hk} (press and let go quickly) while hovering the item.`;
  if (isMe(over)) return `Your mouse was over this app's window, not the game. Hover the item in game, then press ${hk}.`;
  if (/refocus-failed/.test(s) || (fg && !isGame(fg) && fg !== '?')) {
    return `${G(store.data.lastGame || tg()).name} wasn't the active window${fg && fg !== '?' ? ` (${isMe(fg) ? 'this app' : fg} was)` : ''}, so the copy went there. Click once in the game, then press ${hk} again.`;
  }
  if (over && !isGame(over) && over !== '?') return `Your mouse wasn't over the game (it was over ${over}). Hover the item in game, then press ${hk}.`;
  if (text) return 'That wasn\'t an item (the game copied something else). Hover an item so its tooltip shows, then press the hotkey.';
  return `No item under the mouse. Hover an item until its tooltip shows, then press ${hk}.`;
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
    // The last popup is often still up, right where you moved the mouse for the next item: the game
    // then sees the popup, not the item, and copies nothing. Hide it first (the key sender then
    // nudges the mouse so the game hovers the item again).
    let nudge = false;
    if (popup && !popup.isDestroyed() && popup.isVisible()) {
      const c = screen.getCursorScreenPoint(); const b = popup.getBounds();
      if (c.x >= b.x - 4 && c.x <= b.x + b.width + 4 && c.y >= b.y - 4 && c.y <= b.y + b.height + 4) { popup.hide(); nudge = true; }
    }
    // send the copy before anything appears on screen: a window popping up first can make
    // the game drop its tooltip (then nothing gets copied). One Ctrl+C per press, never more.
    const sent = await keys.copy(!!store.settings.advancedCopy, { nudge });
    if (!sent) log('hotkey: could not send Ctrl+C to the game');
    else if (sent !== true && !/^fg=PathOfExile[^;]*;over=PathOfExile/i.test(sent)) log('hotkey: sent to ' + sent);
    let text = await waitForText(250);
    if (!text && sent) {
      showResult({ ok: false, loading: true, reason: 'Reading item…' });
      text = await waitForText(1250); // the game can be slow to fill the clipboard when it's busy
    }
    if (text && handleItemText(text, 'hotkey', sent)) return;
    // Nothing copied: put the old clipboard back and say why.
    try { clipboard.writeText(before || ''); } catch (_) { /* ignore */ }
    lastClip = before || '';
    log(`hotkey: no item text (${sent ? `sent: ${sent}` : 'not sent'}, got ${text ? 'non-item text' : 'nothing'})`);
    showResult({ ok: false, reason: noItemReason(sent, text) });
  } finally {
    hotkeyBusy = false;
  }
}

// F2: letters are game keys (with WASD movement, Ctrl+D also walked your character right).
const DEFAULT_HOTKEY = 'F2';
// keys that move your character or are common skill keys in PoE2
function gameKeyWarning(accel) {
  const parts = String(accel || '').split('+');
  const k = parts.pop();
  if (parts.some((m) => /^(ctrl|control|alt|cmdorctrl|commandorcontrol)$/i.test(m))) return null; // Ctrl/Alt + key doesn't move you

  if (/^[WASD]$/i.test(k)) return `${k.toUpperCase()} is a movement key (WASD) in Path of Exile, so the game will also act on it. An F-key (e.g. F2) works best.`;
  if (/^[QERTF]$/i.test(k)) return `${k.toUpperCase()} is often a skill key in Path of Exile, so the game may also act on it. An F-key (e.g. F2) works best.`;
  return null;
}

function registerHotkey(accel) {
  const want = accel || store.settings.hotkey || DEFAULT_HOTKEY;
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

const sameKey = (a, b) => String(a || '').toLowerCase().replace(/control/g, 'ctrl') === String(b || '').toLowerCase().replace(/control/g, 'ctrl');
ipcMain.handle('hotkey:set', (_e, accel) => {
  const prev = store.settings.hotkey || DEFAULT_HOTKEY;
  if (sameKey(accel, store.settings.resultsHotkey || 'Ctrl+Shift+D')) return { ok: false, accelerator: prev, error: `${accel} already opens the results window. Pick a different key.` };
  const st = registerHotkey(accel);
  if (st.ok) store.setSetting('hotkey', accel);
  else registerHotkey(prev); // put the old one back
  buildTrayMenu();
  return { ...st, accelerator: accel, warning: gameKeyWarning(accel) };
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
  if (target && typeof target === 'object' && target.itemId) return itemById(target.itemId);
  // the item you copied last, unless it's from the other game (its stat ids and league differ)
  if (target === '__last') return lastItem && (!lastItem.game || lastItem.game === tg()) ? lastItem : null;
  if (WEAKEST_OF.includes(target)) {
    // your weakest ring / charm / jewel (by gear score, or weights if the build is off)
    const items = SLOT_GROUPS[target].map((sl) => store.equipped[sl]).filter(Boolean);
    // no jewels saved, but PoB has your tree's: search from the jewel you just copied
    if (!items.length) return target === 'Jewel' && pobOn() && lastItem && lastItem.slot === 'Jewel' ? lastItem : null;
    const val = (it) => { const g = gearOf(it); if (g && g.score != null) return g.score; return require('./core/scorer').score(it, store.weights); };
    return items.slice().sort((a, b) => val(a) - val(b))[0];
  }
  return store.equipped[target] || null;
}

function resolveSlotOf(item) {
  for (const [sl, it] of Object.entries(store.equipped || {})) if (it === item || (it && item && it.id && it.id === item.id)) return sl;
  return null;
}

function refreshAll() {
  // a price card (currency, gems...) or map check isn't a comparison: it stays as it is
  if (popupItem && popupItem.slot && popup && popup.isVisible()) {
    const r = evaluate(popupItem);
    const seq = ++popupSeq;
    const withPob = r && r.ok && !r.isEquipped && pobOn() && pobCanJudge(popupItem, r.targetSlot);
    if (withPob) r.pobPending = true;
    popup.webContents.send('popup:result', serialise({ ...r, keepState: true }));
    // and Path of Building again (settings like priorities change its verdict)
    if (withPob) {
      const item = popupItem;
      pobJudge([{ item, slot: r.targetSlot }]).then((res) => {
        const j = res[0];
        r.pobPending = false;
        if (j) applyPob(r, j); else r.pobError = pobErrorOf(res, 0);
      }).catch((err) => { r.pobPending = false; r.pobError = err.message; log('pob: ' + err.message); })
        .then(() => { if (seq === popupSeq && popupItem === item && popup && !popup.isDestroyed() && popup.isVisible()) popup.webContents.send('popup:result', serialise({ ...r, keepState: true })); });
    }
  }
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings:changed');
  if (resultsWin && !resultsWin.isDestroyed()) resultsWin.webContents.send('settings:changed');
}

ipcMain.handle('equip', (_e, slot, ref) => {
  let item = null;
  if (ref && typeof ref === 'object' && ref.itemId) item = itemById(ref.itemId);
  else if (typeof ref === 'string' && ref) item = parseItem(ref);
  else item = lastItem;
  if (!item || !SLOTS.includes(slot)) return false;
  log(`equip ${slot}: "${item.name}"`);
  setTimeout(pobSync, 0);
  const before = store.equipped[slot];
  if (store.settings.resists) store.setSetting('resists', resLib.rebase(store.settings.resists, before, item));
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
ipcMain.handle('slot:clear', (_e, slot) => { store.setEquipped(slot, null); pobSync(); refreshAll(); return true; });
ipcMain.handle('setting:set', (_e, key, value) => {
  store.setSetting(key, value);
  if (key === 'build') store.setSetting('buildPicked', true); // you chose it: PoB imports won't change it
  if (key === 'startWithWindows') applyLoginItem();
  if (key === 'build' || key === 'colorblind' || key === 'popupDetail' || key === 'buildTweaks' || key === 'pobDamageWeight') { if (key === 'pobDamageWeight') pobQueries.clear(); refreshAll(); }
  if (key === 'resultsHotkey') registerResultsHotkey();
  if (key === 'autoUpdate' && updates.updater()) updates.updater().autoDownload = value !== false;
  if (key === 'betaUpdates') updates.setBetas();
  if ((key === 'wizardDone' || key === 'usageStats') && value) setTimeout(() => usage.send(), 5000);
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
ipcMain.handle('profiles:switch', (_e, id) => { const ok = store.switchProfile(id); log(`switched to character ${id}`); gameChanged(); return ok; });
ipcMain.handle('profiles:create', (_e, name, copy) => { const id = store.createProfile(name, copy); gameChanged(); return id; });
ipcMain.handle('profiles:rename', (_e, id, name) => { store.renameProfile(id, name); buildTrayMenu(); return true; });
ipcMain.handle('profiles:delete', (_e, id) => { const ok = store.deleteProfile(id); gameChanged(); return ok; });

// ---------- resistances ----------
ipcMain.handle('resists:set', (_e, r) => {
  const clean = {};
  for (const k of ['fire', 'cold', 'lightning', 'chaos', 'cap', 'buffer']) {
    const v = r && r[k] !== '' && r[k] != null ? Number(r[k]) : null;
    if (Number.isFinite(v)) clean[k] = v;
  }
  const prev = store.settings.resists;
  const hasRes = ['fire', 'cold', 'lightning', 'chaos'].some((k) => k in clean);
  // typed in = read off the character sheet with the gear you're wearing now
  const changedRes = !prev || ['fire', 'cold', 'lightning', 'chaos'].some((k) => clean[k] !== (resLib.live(prev, store.equipped) || {})[k]);
  if (!hasRes) store.setSetting('resists', null);
  else if (changedRes) store.setSetting('resists', resLib.snapshot(clean, store.equipped, 'game', prev));
  else store.setSetting('resists', { ...prev, cap: clean.cap || prev.cap, ...(clean.buffer != null ? { buffer: clean.buffer, bufferSet: true } : {}) });
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
    const xml = pobLib.decodeCode(code);
    const r = pobLib.parsePob(xml);
    // the build says which game this character is for. A build for the other game goes into a new
    // character, unless this one is still empty.
    const bg = gamesLib.gameFromPobXml(xml);
    // checked before anything changes: a build without gear mustn't leave you on a new, empty character
    if (!Object.keys(r.items).length) return { ok: false, error: 'No equipped items found in that build. Put your gear on the character in Path of Building (Items tab), export it again and paste it here.' };
    let newChar = null;
    if (bg && bg !== tg()) {
      const empty = !Object.values(store.equipped || {}).some(Boolean) && !pobXml();
      const cls = r.character.ascendancy || r.character.className;
      const who0 = cls ? `${cls} ${G(bg).short}` : `My ${G(bg).short} character`;
      if (empty) store.setProfileGame(store.data.activeProfile, bg);
      else { store.createProfile(who0 || `${G(bg).short} character`, false, bg); newChar = store.listProfiles().find((p) => p.active).name; }
      if (bg === 'poe1') store.setSetting('build', 'off'); // the gear score profiles are for PoE2: PoE1 is judged by Path of Building
      store.data.lastGame = bg;
      stopOtherEngines(bg);
      gameChanged();
      log(`pob import: a ${G(bg).short} build${newChar ? `, new character "${newChar}"` : ''}`);
    }
    const slots = Object.keys(r.items);
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
    // numbers you typed from your character sheet beat PoB's
    const typed = store.settings.resists && store.settings.resists.source === 'game';
    if (r.resists && !typed) store.setSetting('resists', resLib.snapshot({ ...r.resists, cap: (store.settings.resists && store.settings.resists.cap) || 75 }, store.equipped, 'pob', store.settings.resists));
    // keep the build itself for the Path of Building engine
    try { fs.mkdirSync(path.dirname(pobFile()), { recursive: true }); fs.writeFileSync(pobFile(), xml); } catch (err) { log('pob: could not save the build: ' + err.message); }
    pobSync();
    refreshAll();
    const who = [r.character.ascendancy || r.character.className, r.character.level ? `level ${r.character.level}` : ''].filter(Boolean).join(', ');
    let message = `Imported ${slots.length} item${slots.length === 1 ? '' : 's'}${who ? ` (${who})` : ''}${r.resists ? ' and your resistances' : ''}.`;
    if (newChar) message = `New ${G(bg).short} character "${newChar}": ` + message.charAt(0).toLowerCase() + message.slice(1);
    if (kept) message += ` Kept ${kept} you'd already copied from the game (same item, more detail).`;
    if (r.missingBase && tg() === 'poe2') message += ` PoB doesn't store base Armour/Energy Shield, so ${r.missingBase} armour piece${r.missingBase === 1 ? '' : 's'} score a bit low until you copy them in game once.`;
    log('pob import: ' + message);
    let engine = null;
    if (pobOn()) {
      try {
        const info = await pobEngine().ensureLoaded();
        fixPoe1Weapons(info);
        engine = pobSummary(info);
        // the gear score (used when PoB can't judge something) gets a profile that fits this build
        if (!store.settings.buildPicked && engine && tg() === 'poe2') {
          const fit = engine.dpsKey === 'MinionDPS' ? 'djinn-varashta' : (engine.es || 0) > (engine.life || 0) * 2 ? 'es-caster' : 'life-res';
          if (fit !== store.settings.build) { store.setSetting('build', fit); log(`gear score profile set to ${fit} from the PoB build`); }
        }
        if (engine.mismatch.length) message += ` Note: ${engine.mismatch.join('; ')}.`;
      } catch (err) { engine = { ok: false, error: err.message }; log('pob: ' + err.message); }
    }
    if (newChar) { notifySettings('settings:changed'); buildTrayMenu(); }
    return { ok: true, message, slots, engine, newCharacter: newChar };
  } catch (err) {
    log('pob import failed: ' + (err.stack || err));
    return { ok: false, error: err.message || String(err) };
  }
});

// PoE1: a PoB export doesn't say what kind of weapon an item is; PoB itself knows
const POE1_WEAPON_CLASS = {
  'Two Handed Axe': 'Two Hand Axes', 'Two Handed Mace': 'Two Hand Maces', 'Two Handed Sword': 'Two Hand Swords',
  'One Handed Axe': 'One Hand Axes', 'One Handed Mace': 'One Hand Maces', 'One Handed Sword': 'One Hand Swords',
  Bow: 'Bows', Claw: 'Claws', Dagger: 'Daggers', Wand: 'Wands', Sceptre: 'Sceptres', Staff: 'Staves',
  Shield: 'Shields', Quiver: 'Quivers', 'Fishing Rod': 'Fishing Rods',
};
function fixPoe1Weapons(info) {
  if (tg() !== 'poe1' || !info || !info.gearTypes) return;
  const ours = { 'Weapon 1': 'Weapon', 'Weapon 2': 'Offhand', 'Weapon 1 Swap': 'Weapon 2', 'Weapon 2 Swap': 'Offhand 2' };
  const { isTwoHanded } = require('./core/slots');
  for (const [ps, t] of Object.entries(info.gearTypes)) {
    const it = store.equipped[ours[ps]];
    if (!it || !it.fromPob || !t || !t.type) continue;
    let cls = POE1_WEAPON_CLASS[t.type];
    if (t.type === 'One Handed Sword' && /thrust/i.test(t.subType || '')) cls = 'Thrusting One Hand Swords';
    if (t.type === 'Dagger' && /rune/i.test(t.subType || '')) cls = 'Rune Daggers';
    if (t.type === 'Staff' && /warstaff/i.test(t.subType || '')) cls = 'Warstaves';
    if (!cls || cls === it.itemClass) continue;
    it.itemClass = cls; it.twoHanded = isTwoHanded(cls);
    if (it.raw) it.raw = it.raw.replace(/^Item Class:.*$/m, `Item Class: ${cls}`);
    store.setEquipped(ours[ps], it);
  }
}

// what the engine says about your build, plus where it disagrees with your character sheet
function pobSummary(info) {
  if (!info) return null;
  const st = info.stats || {};
  const rs = liveResists();
  const mismatch = [];
  if (rs && rs.source === 'game') {
    for (const [El, el] of Object.entries(RES_EL)) {
      const typedV = rs[el]; const pobV = st[`${El}ResistTotal`];
      if (typedV != null && pobV != null && Math.abs(typedV - pobV) >= 5) mismatch.push(`PoB has ${El.toLowerCase()} res at ${Math.round(pobV)}%, your character sheet ${typedV}% – check PoB's Configuration (${tg() === 'poe1' ? 'flasks' : 'charms'}, buffs) and gear`);
    }
  }
  const dk = pobVerdict.dpsKey(st);
  const tv = (v) => String(v).replace(/_/g, '.').replace(/\.(ruthless|alternate)$/i, ' $1');
  if (info.treeConverted && info.treeConverted.newer) mismatch.push(`your build was made with a newer Path of Building (passive tree ${tv(info.treeConverted.from)}) than the one in this app (${tv(info.treeConverted.to)}), so new passives may be missing from the verdicts – the app's Path of Building is updated with the app`);
  else if (info.treeConverted) mismatch.push(`your build is on an old passive tree (${tv(info.treeConverted.from)}); it was moved to ${tv(info.treeConverted.to)}, which can drop passives – update the build in Path of Building and import it again`);
  if (info.timelessRemoved) mismatch.push(`${info.timelessRemoved === 1 ? 'your timeless jewel was' : `your ${info.timelessRemoved} timeless jewels were`} left out of the calculations (the data it needs doesn't come with the app), so verdicts don't include ${info.timelessRemoved === 1 ? 'its' : 'their'} passive changes`);
  if (!(pobVerdict.dpsOf(st, dk) > 0)) mismatch.push(`your main skill in Path of Building${info.mainSkill ? ` (${info.mainSkill})` : ''} deals no damage, so damage changes can't be judged – set your damage skill as the main skill in PoB (or tick "Include in Full DPS" on your damage skills) and import again`);
  return {
    ok: true, className: info.className, ascendancy: info.ascendancy, level: info.level, mainSkill: info.mainSkill,
    dps: pobVerdict.dpsOf(st, dk), dpsKey: dk, ehp: st.TotalEHP, es: st.EnergyShield, life: st.Life, spirit: st.Spirit, spiritFree: st.SpiritUnreserved,
    res: Object.keys(RES_EL).map((El) => ({ el: El, value: st[`${El}Resist`], total: st[`${El}ResistTotal`] })),
    gear: info.gear || {}, overridden: info.equipped || [], mismatch,
    ci: pobVerdict.hasCI(st),
  };
}
const pobLastSummary = new Map();
// Character page: everything Path of Building calculates for your character (with the gear you
// copied in game), plus what the app itself knows. Kept per character so it shows instantly next time.
const pobLastSheet = new Map();
ipcMain.handle('pob:sheet', async (_e, refresh) => {
  const key = store.data.activeProfile;
  const out = { on: pobOn(), hasBuild: !!pobXml(), available: pobEngine().available(), enabled: store.settings.usePob !== false, resists: liveResists() || null };
  if (!out.on) return out;
  if (!refresh && pobLastSheet.has(key) && pobLastSheet.get(key).gen === pobSheetGen) return { ...out, sheet: pobLastSheet.get(key).sheet, at: pobLastSheet.get(key).at };
  try {
    if (refresh) pobEngine().resetFailure(); // you pressed Refresh: try again now
    await pobEngine().ensureLoaded();
    const sheet = await pobEngine().sheet();
    sheet.overridden = (pobEngine().info() || {}).equipped || [];
    pobLastSheet.set(key, { sheet, at: Date.now(), gen: pobSheetGen });
    return { ...out, sheet, at: Date.now() };
  } catch (err) {
    log('pob sheet: ' + (err.message || err));
    const last = pobLastSheet.get(key);
    return { ...out, error: err.message || String(err), sheet: last ? last.sheet : null, at: last ? last.at : null };
  }
});
// search strings to paste into the game's search box (stash, vendor, map device)
const searchStr = require('./core/searchstr');
function resShort() {
  const rs = liveResists();
  if (!rs) return [];
  return ['fire', 'cold', 'lightning'].filter((el) => rs[el] != null && rs[el] < ((rs.caps && rs.caps[el]) || rs.cap || 75));
}
function avoidKeys(extra) {
  const marks = ((store.settings.mapMarks || {})[tg()]) || {};
  return [...(Array.isArray(extra) ? extra.filter((k) => typeof k === 'string').slice(0, 30) : []), ...Object.keys(marks).filter((k) => marks[k] === 'd')];
}
ipcMain.handle('strings:get', () => ({ game: tg(), resShort: resShort(), mapAvoid: searchStr.mapAvoid(avoidKeys()), limit: searchStr.LIMIT,
  marked: avoidKeys().length }));
ipcMain.handle('strings:vendor', (_e, opts) => searchStr.vendor({ ...(opts || {}), game: tg() }));
ipcMain.handle('strings:mapAvoid', (_e, keys) => {
  const r = searchStr.mapAvoid(avoidKeys(keys));
  if (r.text) { try { clipboard.writeText(r.text); lastClip = r.text; } catch (_) { /* ignore */ } }
  return r;
});
// PoE1: how many hits of each Path of Building boss preset your character takes (Pinnacle and Uber)
ipcMain.handle('pob:bosscheck', async () => {
  if (tg() !== 'poe1') return { ok: false, error: 'The boss check is for Path of Exile 1.' };
  if (!pobOn()) return { ok: false, error: 'Add your Path of Building build on My gear first.' };
  try {
    await pobEngine().ensureLoaded();
    const r = await pobEngine().bossCheck({});
    return { ok: true, skills: (r.skills || []).filter((x) => x.damageType !== 'DamageOverTime') };
  } catch (err) { log('boss check: ' + (err.message || err)); return { ok: false, error: err.message || String(err) }; }
});
ipcMain.handle('pob:status', async (_e, load) => {
  const eng = pobEngine();
  const out = { available: eng.available(), hasBuild: !!pobXml(), on: pobOn(), enabled: store.settings.usePob !== false };
  if (load && pobOn()) {
    eng.resetFailure();
    try { out.summary = pobSummary(await eng.ensureLoaded()); } catch (err) { out.error = err.message; }
  } else if (eng.info()) out.summary = pobSummary(eng.info());
  // keep showing the last good summary while the engine reloads after a gear change
  const key = store.data.activeProfile;
  if (out.summary) pobLastSummary.set(key, out.summary);
  else if (pobOn() && pobLastSummary.has(key)) out.summary = pobLastSummary.get(key);
  return out;
});
ipcMain.handle('priorities:set', (_e, p) => {
  const clean = {};
  for (const k of Object.keys(pobVerdict.DEFAULT_PRIORITIES)) if (p && typeof p[k] === 'boolean') clean[k] = p[k];
  store.setSetting('priorities', { ...pobPriorities(), ...clean });
  pobQueries.clear();
  refreshAll();
  return pobPriorities();
});
ipcMain.handle('pob:enable', (_e, on) => { store.setSetting('usePob', !!on); if (on) { pobEngine().resetFailure(); pobSync(); } refreshAll(); return pobOn(); });

ipcMain.handle('ignore:set', (_e, rules) => {
  store.setSetting('ignoreStats', ignoreLib.cleanRules(rules));
  log('ignored stats: ' + JSON.stringify(store.settings.ignoreStats));
  refreshAll();
  return store.settings.ignoreStats;
});

ipcMain.handle('state:get', () => JSON.parse(JSON.stringify({
  platform: process.platform, dataDir: app.getPath('userData'), loadError: store.loadError || null,
  game: store.activeGame(), lastGame: store.data.lastGame || null,
  defaultBuild: gearLib.DEFAULT_BUILD,
  pobOn: pobOn(),
  resultsHotkeyOk: !!resultsHotkey,
  priorities: pobPriorities(),
  profiles: store.listProfiles(),
  buildStats: gearLib.buildStats(store.settings.build),
  builds: gearLib.buildList(),
  gearScores: Object.fromEntries(Object.entries(store.equipped).map(([slot, it]) => [slot, gearOf(it, slot)])),
  mainSlots: MAIN_SLOTS,
  ignorePresets: Object.entries(ignoreLib.PRESETS).map(([id, p]) => ({ id, label: p.label })),
  budgetLabel: trade.budgetLabel(budgetNow(), tg()),
  charLevel: pobOn() ? ((pobEngine().info() || {}).level || null) : null,
  weights: store.weights,
  equipped: store.equipped,
  seenStats: Object.keys(store.data.seenStats),
  settings: store.settings,
  liveResists: liveResists(),
  slots: SLOTS,
  lastItem,
  hotkeyStatus,
})));

ipcMain.handle('evaluate:text', (_e, text) => {
  const item = parseItem(text);
  if (!item) return { ok: false, reason: 'That doesn\'t look like Path of Exile item text. In game, hover an item and press Ctrl+C.' };
  // an item from the other game is judged against that game's character, as F2 would
  const ig = gamesLib.gameFromItemText(text);
  if (ig && ig !== store.activeGame() && !store.profileForGame(ig)) return { ok: false, reason: `That's a ${G(ig).name} item, and you have no ${G(ig).short} character yet. Press F2 on an item in ${G(ig).short}, or import a ${G(ig).short} build on My gear, to make one.` };
  if (ig && ig !== store.activeGame()) { store.switchProfile(store.profileForGame(ig)); popupItem = null; gameChanged(); }
  store.noteStats(item);
  remember(item);
  notifySettings('item:copied', { id: item.id, name: item.name });
  const r = evaluate(item);
  // the same Path of Building verdict the popup gives, so "Check an item" agrees with it
  if (!(r && r.ok && !r.isEquipped && pobOn() && pobCanJudge(item, r.targetSlot))) return serialise(r);
  return pobJudge([{ item, slot: r.targetSlot }]).then((res) => { if (res[0]) applyPob(r, res[0]); else r.pobError = pobErrorOf(res, 0); })
    .catch((err) => { r.pobError = err.message; log('pob: ' + err.message); })
    .then(() => serialise(r));
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

// an identifiable User-Agent, as GGG and poe.ninja ask of tools
const UA = `PoE-Upgrade-Checker/${app.getVersion()} (contact: support@poe2upgrade.com)`;
// pathofexile.com pages the app opens (search fallback, sign-in) share this
// cookie store, so if you sign in, searches and "Travel to hideout" use it.
const POE_PARTITION = 'persist:poe';

async function getJson(url) {
  const res = await net.fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);
  return res.json();
}

const tradeDataBy = {};
async function loadTradeData(force) {
  const game = tg();
  let tradeData = tradeDataBy[game];
  const cacheFile = path.join(app.getPath('userData'), game === 'poe2' ? 'trade-cache.json' : `trade-cache-${game}.json`);
  const DAY = 24 * 3600 * 1000;
  if (!force && !tradeData) {
    try { tradeData = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (_) { tradeData = null; }
  }
  // leagues change at a league start: check them every hour, not once a day with the stats
  if (!force && tradeData && tradeData.stats && Date.now() - tradeData.fetchedAt <= DAY && Date.now() - (tradeData.leaguesAt || tradeData.fetchedAt) > 3600 * 1000) {
    try {
      const leagues = await getJson(trade.apiUrl(game, 'data/leagues'));
      if (leagues && Array.isArray(leagues.result) && leagues.result.length) { tradeData.leagues = leagues; tradeData.leaguesAt = Date.now(); try { fs.writeFileSync(cacheFile, JSON.stringify({ ...tradeData, index: undefined })); } catch (_) { /* ignore */ } }
    } catch (_) { tradeData.leaguesAt = Date.now(); /* offline: try again in an hour */ }
  }
  if (force || !tradeData || Date.now() - tradeData.fetchedAt > DAY) {
    try {
      const [stats, filters, leagues] = await Promise.all([
        getJson(trade.apiUrl(game, 'data/stats')),
        getJson(trade.apiUrl(game, 'data/filters')).catch(() => null),
        getJson(trade.apiUrl(game, 'data/leagues')).catch(() => null),
      ]);
      tradeData = { stats, filters, leagues, fetchedAt: Date.now() };
      try { fs.writeFileSync(cacheFile, JSON.stringify(tradeData)); } catch (_) { /* ignore */ }
    } catch (err) {
      // Offline or the site is down: keep using an older cache if we have one.
      if (!tradeData || !tradeData.stats) throw err;
    }
  }
  tradeData.index = trade.buildStatIndex(tradeData.stats);
  tradeDataBy[game] = tradeData;
  return tradeData;
}

ipcMain.handle('trade:data', async (_e, force) => {
  try {
    const d = await loadTradeData(force);
    const leagues = ((d.leagues && d.leagues.result) || [])
      .filter(leagueOfGame)
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

ipcMain.handle('items:recent', () => Array.from(recentItems.values()).filter((i) => !i.game || i.game === tg()).reverse().slice(0, 8)
  .map((i) => ({ id: i.id, name: i.name, itemClass: i.itemClass, copiedAt: i.copiedAt })));

ipcMain.on('open:url', (_e, url) => {
  if (trade.isTradePage(url) || ninjaLib.isInfoPage(url)) shell.openExternal(url);
});

// ---------- poe.ninja prices (currency, gems, maps, divination cards, uniques...) ----------
const ninjaLib = require('./core/ninja');
// ---------- feature modules (src/features) ----------
// They reach the app's state and helpers through C; getters, so they always see the current value.
const C = {
  get G() { return G; },
  get HOUR() { return HOUR; },
  get ICON() { return ICON; },
  get SWITCHED() { return SWITCHED; },
  get applyLinuxAutostart() { return applyLinuxAutostart; },
  get budgetNow() { return budgetNow; },
  get buildTrayMenu() { return buildTrayMenu; },
  get fetchListings() { return fetchListings; },
  get gearLib() { return gearLib; },
  get gearOf() { return gearOf; },
  get gearOpts() { return gearOpts; },
  get gearScoreOn() { return gearScoreOn; },
  get getJson() { return getJson; },
  get ignoreRules() { return ignoreRules; },
  get inGame() { return inGame; },
  get gameCtx() { return gameCtx; },
  get shownLeague() { return shownLeague; },
  get keepNotification() { return keepNotification; },
  get listingLib() { return listingLib; },
  get loadTradeData() { return loadTradeData; },
  get log() { return log; },
  get UA() { return UA; },
  get ninjaLeague() { return ninjaLeague; },
  get ninjaLib() { return ninjaLib; },
  get ninjaPrice() { return ninjaPrice; },
  get notifySettings() { return notifySettings; },
  get openIfAny() { return openIfAny; },
  get pickLeague() { return pickLeague; },
  get pobCI() { return pobCI; },
  get pobEngine() { return pobEngine; },
  get pobListings() { return pobListings; },
  get pobOn() { return pobOn; },
  get pobPriorities() { return pobPriorities; },
  get pobQueryFor() { return pobQueryFor; },
  get pobSearch() { return pobSearch; },
  get pobVerdict() { return pobVerdict; },
  get pobWeights() { return pobWeights; },
  get popup() { return popup; },
  get popupSeq() { return popupSeq; },
  get refreshDivineRate() { return refreshDivineRate; },
  get rememberListing() { return rememberListing; },
  get resNeedFor() { return resNeedFor; },
  get resolveItem() { return resolveItem; },
  get resolveSlotOf() { return resolveSlotOf; },
  get resultsState() { return resultsState; },
  get runSearch() { return runSearch; },
  get sameGame() { return sameGame; },
  get scoreListing() { return scoreListing; },
  get searchKey() { return searchKey; },
  get searchLog() { return searchLog; },
  get searchWait() { return searchWait; },
  get serialise() { return serialise; },
  get settingsWin() { return settingsWin; },
  get showResult() { return showResult; },
  get showResults() { return showResults; },
  get signedIn() { return signedIn; },
  get store() { return store; },
  get savedList() { return savedList; },
  get tg() { return tg; },
  get trade() { return trade; },
};
const prices = require('./features/prices')(C);
const mapFeature = require('./features/mapcheck')(C);
require('./features/lootfilter')(C);
require('./features/spend')(C);
const mapLib = require('./core/mapcheck');
function ninjaPrice(item) { return prices.ninjaPrice(item); }
function showPriceCard(item) { return prices.showPriceCard(item); }
function showMapCard(item) { return mapFeature.showMapCard(item); }
const updates = require('./features/updates')(C);
const usage = require('./features/stats')(C);
const savedFeature = require('./features/saved')(C);
function savedList() { return savedFeature.savedList(); }
function runAlerts(force) { return savedFeature.runAlerts(force); }
function keepNotification(n) { return savedFeature.keepNotification(n); }

// ---------- loot filter from your build ----------
// ---------- map / waystone check ----------
ipcMain.handle('trade:search', inGame(async (_e, req) => {
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
  if (!sameGame()) return SWITCHED();
  if (req.league && leagueOk(d, req.league)) setGameSetting('league', req.league);
  if (req.status) store.setSetting('status', req.status);
  if (req.budget !== undefined) setGameSetting('budget', req.budget);
  await refreshDivineRate(false);
  const budget = budgetNow(req.budget !== undefined ? req.budget : store.settings.budget);
  trade.applyBudget(body, budget, tg());
  const r = await runSearch(pickLeague(d, req.league), body, 'custom');
  if (r.ok) await openIfAny(r, { item, mode: 'custom', title: `Custom search: ${item.name}`, body, searchKey: searchKey(body) });
  return { ...r, unmatched, excluded, budget: trade.budgetLabel(budget, tg()), item: item.name };
}));

// PoE2's leagues are realm "poe2"; PoE1's (on its own trade API) "pc", or none
function leagueOfGame(l) { const realm = G().trade.realm; return realm ? (!l.realm || l.realm === realm) : (!l.realm || l.realm === 'pc'); }
const leagueIds = (d) => ((d && d.leagues && d.leagues.result) || []).filter(leagueOfGame).map((l) => l.id);
// private leagues ("Name (PL12345)") are never in the trade site's public list
const isPrivateLeague = (l) => /\(PL\d+\)\s*$/.test(String(l || ''));
// a league that belongs to this game (or we can't tell): the other game's never is
function leagueOk(d, l) { const ids = leagueIds(d); return !!l && (!ids.length || ids.includes(l) || isPrivateLeague(l)); }
function pickLeague(d, wanted) {
  const ids = leagueIds(d);
  if (wanted && leagueOk(d, wanted)) return wanted;
  if (store.settings.league && leagueOk(d, store.settings.league)) return store.settings.league;
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

// ---------- search rate limiting ----------
// The trade site allows only a few searches per 10 s / 60 s / 300 s (it says how many in the
// x-rate-limit headers) and bans you for a minute when you go over. Every search waits for a
// free slot instead, keeping one spare, and a 429 blocks searching until the site says so.
const searchLog = [];
let searchRules = [[5, 10], [15, 60], [30, 300]]; // safe guesses until the site tells us
let searchBlockedUntil = 0;
function learnLimits(get) {
  try {
    const parse = (v) => String(v || '').split(',').filter(Boolean).map((r) => r.split(':').map(Number)).filter((x) => x[0] > 0 && x[1] > 0).map((x) => [x[0], x[1]]);
    const rules = [...parse(get('x-rate-limit-ip')), ...parse(get('x-rate-limit-account'))];
    if (rules.length) searchRules = rules;
    const ra = Number(get('retry-after'));
    if (ra > 0) searchBlockedUntil = Math.max(searchBlockedUntil, Date.now() + ra * 1000);
  } catch (_) { /* keep the old rules */ }
}
function searchWait() {
  const now = Date.now();
  let wait = Math.max(0, searchBlockedUntil - now);
  for (const [hits, sec] of searchRules) {
    const recent = searchLog.filter((t) => now - t < sec * 1000);
    const room = Math.max(1, hits - 1); // keep one spare for safety
    if (recent.length >= room) wait = Math.max(wait, recent[recent.length - room] + sec * 1000 - now + 250);
  }
  return wait;
}
// waits for a slot (up to maxWait ms); false if it would take longer
async function searchSlot(maxWait = 30000) {
  for (let i = 0; i < 20; i++) {
    const w = searchWait();
    if (!w) {
      searchLog.push(Date.now());
      while (searchLog.length > 200) searchLog.shift();
      return true;
    }
    if (w > maxWait) return false;
    if (w > 1500) log(`search: waiting ${Math.round(w / 1000)} s for the trade site rate limit`);
    await new Promise((r) => setTimeout(r, w));
  }
  return false;
}

async function postSearch(league, body, game) {
  const res = await net.fetch(trade.searchUrl(league, game), {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  learnLimits((h) => res.headers.get(h));
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
async function postSearchViaPage(league, body, game) {
  if (!tradeWin || tradeWin.isDestroyed()) {
    tradeWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, partition: POE_PARTITION } });
  }
  const page = trade.pageUrl(game, league);
  if (!tradeWin.webContents.getURL().startsWith(trade.BASE)) {
    await Promise.race([tradeWin.loadURL(page), new Promise((_, rej) => setTimeout(() => rej(new Error('page load timed out')), 15000))]);
  }
  const js = `fetch(${JSON.stringify(trade.searchUrl(league, game))}, { method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: ${JSON.stringify(JSON.stringify(body))} })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})),
      h: Object.fromEntries(['x-rate-limit-ip', 'x-rate-limit-ip-state', 'x-rate-limit-account', 'x-rate-limit-account-state', 'retry-after'].map((k) => [k, r.headers.get(k)])) }))`;
  const r = await Promise.race([
    tradeWin.webContents.executeJavaScript(js, true),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 15000)),
  ]);
  if (r && r.h) learnLimits((k) => r.h[k]);
  if (r && r.status === 429) {
    const wait = r.h && r.h['retry-after'];
    const err = new Error(`The trade site says too many searches – wait ${wait || 'a minute'} seconds and try again.`);
    err.rateLimited = true; throw err;
  }
  if (r && r.json && r.json.id && r.h) r.json._near = nearRateLimit({ get: (k) => r.h[k] });
  if (!r || r.status !== 200 || !r.json || !r.json.id) {
    throw new Error((r && r.json && r.json.error && r.json.error.message) || `HTTP ${r && r.status}`);
  }
  return r.json;
}

// Runs a search and returns { ok, total, url }. Doesn't open the browser:
// callers decide (so a search with 0 results can be loosened first).
const statusBroken = {}; // per game: set if that trade site rejects 'available'
// o.game: which game's trade site (default: the game you're playing; a saved search keeps its own)
async function runSearch(league, body, label, o = {}) {
  const game = o.game || tg();
  // a search for the game you just left (alerts excepted: they run for both games)
  if (!o.anyGame && game !== store.activeGame()) { log(`search ${label || ''}: stopped, you changed game`); return SWITCHED(); }
  trade.adaptQuery(body, game);
  if (statusBroken[game] && body.query.status && body.query.status.option === 'available') body.query.status.option = 'online';
  log(`search ${label || ''} ${G(game).short} league=${league} body=${JSON.stringify(body)}`);
  const errors = []; let complex = 0;
  // signed in, the trade site allows bigger searches: send it from the signed-in page first
  const order = (await signedIn()) ? [['page', postSearchViaPage], ['app', postSearch]] : [['app', postSearch], ['page', postSearchViaPage]];
  for (const [name, fn] of order) {
    if (!(await searchSlot(o.maxWait == null ? 30000 : o.maxWait))) {
      const w = Math.ceil(searchWait() / 1000);
      return { ok: false, league, rateLimited: true, error: `The trade site allows only a few searches a minute – try again in ${w} seconds.` };
    }
    try {
      const json = await fn(league, body, game);
      log(`search via ${name}: id=${json.id} total=${json.total}`);
      return {
        ok: true, league, game, total: json.total, url: trade.resultsUrl(league, json.id, game), near: !!json._near,
        searchId: json.id, ids: Array.isArray(json.result) ? json.result.slice(0, 100) : [], body,
      };
    } catch (err) {
      const msg = err.message || String(err);
      log(`search via ${name} failed: ${msg}`);
      if (err.rateLimited) return { ok: false, league, error: msg, rateLimited: true };
      if (/status/i.test(msg) && body.query.status && body.query.status.option !== 'online') {
        statusBroken[game] = true;
        log('trade site rejected the listing status; retrying with "online"');
        return runSearch(league, { ...body, query: { ...body.query, status: { option: 'online' } } }, label, o);
      }
      errors.push(`${name}: ${msg}`);
      // the other route would get the same answer and cost another search
      if (/too complex/i.test(msg)) { complex++; break; }
      if (/rate limit/i.test(msg)) { searchBlockedUntil = Math.max(searchBlockedUntil, Date.now() + 60000); return { ok: false, league, error: msg, rateLimited: true }; }
    }
  }
  // the browser link would fail the same way: let the caller make the search smaller
  if (complex) return { ok: false, league, tooComplex: true, error: 'The trade site says this search has too many filters.' };
  // Last resort: a pre-filled search link (we can't know how many results).
  return { ok: true, league, game, total: null, url: trade.prefilledUrl(league, body, game), fallback: errors.join('; ') };
}

// Show the results: in the app's results window (default) or the browser.
// ctx: { item, mode, title } - the item searched for (its class is needed to
// read the listings, and listings are scored against your equipped gear).
async function deliver(r, ctx) {
  if (!r.url || (r.total != null && r.total <= 0)) return r;
  if (r.game && r.game !== store.activeGame()) return SWITCHED(); // finished after you changed game
  try { savedFeature.record(r, ctx); } catch (err) { log('history: ' + err.message); }
  const inApp = r.searchId && r.ids && r.ids.length;
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

// listing fetches are paced too: a short gap between them, longer when the trade site says we're
// close to its limit, and when it says "too many requests" we wait as long as it asks (and don't
// try again through the page, which would only be another request)
let fetchNextAt = 0;
async function fetchViaApp(league, searchId, ids, game) {
  const url = trade.fetchUrl(ids, searchId, game);
  const res = await net.fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
  if (res.status === 429) {
    fetchNextAt = Date.now() + (ra > 0 ? ra * 1000 : 10000);
    const e = new Error(`The trade site says too many requests – wait ${Math.ceil((fetchNextAt - Date.now()) / 1000)} seconds.`); e.rateLimited = true; throw e;
  }
  try { fetchNextAt = Date.now() + (res.headers && nearRateLimit(res.headers) ? 2500 : 350); } catch (_) { fetchNextAt = Date.now() + 350; }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !Array.isArray(json.result)) throw new Error((json.error && json.error.message) || `HTTP ${res.status}`);
  return json.result;
}
async function fetchViaPage(league, searchId, ids, game) {
  if (!tradeWin || tradeWin.isDestroyed()) {
    tradeWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, partition: POE_PARTITION } });
  }
  if (!tradeWin.webContents.getURL().startsWith(trade.BASE)) {
    await Promise.race([tradeWin.loadURL(trade.pageUrl(game, league)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('page load timed out')), 15000))]);
  }
  const url = trade.fetchUrl(ids, searchId, game);
  const r = await tradeWin.webContents.executeJavaScript(`fetch(${JSON.stringify(url)}, { credentials: 'include', headers: { Accept: 'application/json' } }).then(async (x) => ({ status: x.status, json: await x.json().catch(() => ({})) }))`, true);
  if (!r || r.status !== 200 || !Array.isArray(r.json.result)) throw new Error(`HTTP ${r && r.status}`);
  return r.json.result;
}
let loggedSample = false;
async function fetchListings(league, searchId, ids, game = tg()) {
  const out = [];
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    let got = null; let lastErr = null;
    const wait = fetchNextAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 60000)));
    for (const fn of [fetchViaApp, fetchViaPage]) {
      try { got = await fn(league, searchId, chunk, game); break; } catch (err) { lastErr = err; log(`fetch via ${fn.name} failed: ${err.message || err}`); if (err.rateLimited) break; }
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
  if (tg() === 'poe1' && isFlaskClass(s.item)) s.item.slot = 'Flask';
  const r = evaluate(s.item);
  const c = r && r.ok ? {
    verdict: r.verdict, delta: r.delta, pct: r.pct, targetSlot: r.targetSlot, replacing: r.replacing, scoreMode: r.scoreMode,
    rows: r.rows.slice(0, 16).map((x) => ({ key: x.key, diff: x.diff, weight: x.weight, impact: x.impact, useful: x.useful })),
    character: r.character || null, risks: r.risks || null, resRank: r.resRank || 0,
  } : null;
  const dr = (resultsState && resultsState.divineRate) || store.settings.divineRate;
  const value = c && s.priceEx && c.delta != null && dr > 0 ? (c.delta / Math.max(s.priceEx, 1)) * dr : null; // score per divine
  const g = gearOf(s.item, c && c.targetSlot);
  const ge = c && store.equipped[c.targetSlot] ? gearOf(store.equipped[c.targetSlot], c.targetSlot) : null;
  const slim = (x) => ({ score: x.score, grade: x.grade, missing: x.missing, unique: x.unique, ideal: x.ideal, wasted: x.wasted, resNote: x.resNote,
    contributions: (x.contributions || []).map((k) => ({ label: k.label, points: k.points, quality: k.quality, source: k.source })) });
  return { ...s, compare: c, valuePerDiv: value, gear: g ? slim(g) : null, gearEquipped: ge ? ge.score : null, gearEquippedDetail: ge ? slim(ge) : null };
}

async function pobListings(list) {
  const fresh = list.filter((x) => x.item && x.compare);
  if (!fresh.length || !pobOn()) return;
  try {
    const t0 = Date.now();
    const js = await pobJudge(fresh.map((x) => ({ item: x.item, slot: x.compare.targetSlot })));
    fresh.forEach((x, i) => {
      if (!js[i]) return;
      applyPob(x.compare, js[i]);
      const dr = (resultsState && resultsState.divineRate) || store.settings.divineRate;
      x.valuePerDiv = x.priceEx && js[i].score > 0 && dr > 0 ? (js[i].score / Math.max(x.priceEx, 1)) * dr : null;
    });
    log(`pob: judged ${js.filter(Boolean).length} of ${fresh.length} listings in ${Date.now() - t0} ms`);
  } catch (err) { log('pob: listings: ' + err.message); }
}

function resultsPayload() {
  const { r, ctx, listings } = resultsState;
  return JSON.parse(JSON.stringify({
    title: ctx.title || 'Trade results', mode: ctx.mode, league: r.league, total: r.total, url: r.url,
    itemName: ctx.item && ctx.item.name, itemClass: ctx.item && ctx.item.itemClass,
    note: ctx.note || null, priceSummary: ctx.priceSummary || null,
    shown: listings.length, more: resultsState.next < r.ids.length,
    divineRate: resultsState.divineRate, unit: G(r.game).baseShort, game: r.game || tg(), gameBeta: !!G(r.game).beta, gameShort: G(r.game).short,
    otherGame: r.game && r.game !== tg() ? `These are ${G(r.game).name} results, kept as they were. Press F2 in ${G(r.game).short} (or pick your ${G(r.game).short} character) to check them with that character again.` : null,
    listings: listings.map((x) => ({ ...x, item: x.item ? { name: x.item.name, baseType: x.item.baseType, rarity: x.item.rarity, itemLevel: x.item.itemLevel, corrupted: !!x.item.corrupted, lines: x.item.lines, id: x.item.id } : null })),
    saved: !!(store.data.savedSearches || []).find((x) => x.searchKey === ctx.searchKey),
    signedIn: !!resultsState.signedIn,
    resFirst: !!pobPriorities().resFirst,
    resultsHotkey: resultsHotkey || null,
    pobOn: pobOn(),
  }));
}

async function loadMoreListings(count) {
  const st = resultsState;
  const ids = st.r.ids.slice(st.next, st.next + count);
  if (!ids.length) return;
  const raw = await fetchListings(st.r.league, st.r.searchId, ids, st.r.game);
  st.next += ids.length;
  if (st.r.game && st.r.game !== store.activeGame()) throw new Error('you changed game'); // never judged against the other game's character
  const rates = st.rates;
  for (const res of raw) {
    const s = listingLib.summarise(res, st.ctx.item && st.ctx.item.itemClass, rates, G(st.r.game).base);
    s.pos = st.r.ids.indexOf(res.id) + 1; // where it sits on the trade site page
    if (s.item) rememberListing(s.item);
    st.listings.push(scoreListing(s));
  }
  // judge the new ones with Path of Building (one request for all of them)
  await pobListings(st.listings.slice(-raw.length));
}

// Show the results window where you'll see it: a minimised one is restored (showInactive alone
// leaves it in the taskbar, so a search looked like it did nothing). Searching from the app window
// brings it to the front, and onto that window's monitor if it was left on one that's gone or far off;
// searching from the popup over the game doesn't take focus away from the game.
function bringUpResults() {
  if (!resultsWin || resultsWin.isDestroyed()) return;
  if (resultsWin.isMinimized()) resultsWin.restore();
  const fromApp = settingsWin && !settingsWin.isDestroyed() && settingsWin.isFocused();
  if (fromApp) {
    const rb = resultsWin.getBounds();
    const onScreen = screen.getAllDisplays().some((d) => { const a = d.workArea; return rb.x + 100 > a.x && rb.x < a.x + a.width - 100 && rb.y >= a.y - 50 && rb.y < a.y + a.height - 100; });
    if (!onScreen) {
      const a = screen.getDisplayMatching(settingsWin.getBounds()).workArea;
      resultsWin.setBounds({ width: rb.width, height: Math.min(rb.height, a.height - 40), x: a.x + a.width - rb.width - 20, y: a.y + 20 });
    }
    resultsWin.show(); resultsWin.moveTop(); resultsWin.focus();
  } else {
    resultsWin.showInactive(); resultsWin.moveTop();
  }
}

async function showResults(r, ctx) {
  // the search's own game and rates: an open window keeps them when you change game
  r.game = r.game || tg();
  if (r.game !== store.activeGame()) return false; // you changed game: these aren't for this character
  const rates = { ...(store.settings.currencyRates || {}), ...(store.settings.divineRate ? { divine: store.settings.divineRate } : {}) };
  resultsState = { r, ctx, listings: [], next: 0, signedIn: await signedIn(), rates, divineRate: store.settings.divineRate || null };
  try {
    await loadMoreListings(ctx.mode === 'price' ? 40 : 20); // a price needs more than one page
  } catch (err) {
    log('could not load listings, opening the browser instead: ' + (err.message || err));
    // an open results window still shows the last search: say this one failed, don't leave it looking current
    if (resultsWin && !resultsWin.isDestroyed()) resultsWin.webContents.send('results:data', { ...resultsPayload(), listings: [], error: `Couldn't load the listings (${err.message || err}) – opened the search in your browser instead.` });
    return false;
  }
  if (r.game !== store.activeGame() || resultsState.r !== r) return false; // changed game (or searched again) while it loaded
  if (!resultsWin || resultsWin.isDestroyed()) createResultsWindow();
  const send = () => resultsWin.webContents.send('results:data', resultsPayload());
  if (resultsWin.webContents.isLoading()) resultsWin.webContents.once('did-finish-load', send); else send();
  bringUpResults();
  buildTrayMenu();
  return true;
}

const resultsOtherGame = () => !!(resultsState && resultsState.r.game && resultsState.r.game !== tg());
ipcMain.handle('results:more', async () => {
  if (!resultsState) return null;
  if (resultsOtherGame()) return { ...resultsPayload(), error: `Switch back to ${G(resultsState.r.game).short} to load more of these.` };
  try { await loadMoreListings(10); } catch (err) { return { error: err.message || String(err) }; }
  if (resultsState.ctx.mode === 'price') resultsState.ctx.priceSummary = priceSummary(resultsState.listings, resultsState.ctx.priceLeague);
  return resultsPayload();
});
ipcMain.handle('results:rescore', async () => {
  if (!resultsState) return null;
  if (resultsOtherGame()) return resultsPayload(); // never judged against the other game's character
  resultsState.listings = resultsState.listings.map((x) => scoreListing(x));
  await pobListings(resultsState.listings);
  return resultsPayload();
});
ipcMain.on('results:hide', () => { if (resultsWin && !resultsWin.isDestroyed()) resultsWin.hide(); });
function toggleResults() {
  if (resultsWin && !resultsWin.isDestroyed()) {
    if (resultsWin.isVisible() && !resultsWin.isMinimized()) resultsWin.hide(); else bringUpResults();
  } else if (resultsState) {
    createResultsWindow();
    resultsWin.webContents.once('did-finish-load', () => resultsWin.webContents.send('results:data', resultsPayload()));
    resultsWin.showInactive();
  }
}
let resultsHotkey = null;
function registerResultsHotkey() {
  const want = store.settings.resultsHotkey || 'Ctrl+Shift+D';
  if (sameKey(want, hotkeyStatus.accelerator || store.settings.hotkey || DEFAULT_HOTKEY)) { log(`results hotkey ${want}: same as the copy hotkey, not registered`); if (resultsHotkey) { try { globalShortcut.unregister(resultsHotkey); } catch (_) { /* ignore */ } } resultsHotkey = null; return; }
  if (resultsHotkey) { try { globalShortcut.unregister(resultsHotkey); } catch (_) { /* ignore */ } resultsHotkey = null; }
  try { if (globalShortcut.register(want, toggleResults)) resultsHotkey = want; } catch (_) { /* ignore */ }
  log(`results hotkey ${want}: ${resultsHotkey ? 'registered' : 'FAILED'}`);
}
ipcMain.on('clipboard:write', (_e, text) => {
  if (typeof text !== 'string' || !text) return;
  try { clipboard.writeText(text); lastClip = text; } catch (_) { /* ignore */ }
});
ipcMain.on('results:open', (_e, url) => {
  if (trade.isTradePage(url)) shell.openExternal(url);
});

// ---------- divine -> exalted rate (poe.ninja) ----------

const HOUR = 3600 * 1000;
const rateFetches = {}; // one poe.ninja fetch in flight per game

// Budget with the auto rate filled in (uses the last fetched rate).
// leveling mode (Find upgrades): only items you can wear at your level, for every upgrade search
function levelCap() {
  const lv = store.settings.leveling;
  return lv && lv.on && Number(lv.level) > 0 ? Math.min(100, Math.round(Number(lv.level))) : null;
}
function budgetNow(b) {
  const base = b === undefined ? store.settings.budget : b;
  const cap = levelCap();
  const noC = store.settings.noCorrupted === true;
  const budget = cap || noC ? { ...(base || {}), ...(cap ? { maxLevel: cap } : {}), ...(noC ? { noCorrupted: true } : {}) } : base;
  if (!budget) return budget;
  if (budget.currency === 'divine' && store.settings.autoRate !== false && store.settings.divineRate > 0) {
    return { ...budget, divineRate: store.settings.divineRate };
  }
  return budget;
}

async function ninjaLeague() {
  // the league searches use (a chosen league that has ended, or another game's, isn't used)
  try { const d = await loadTradeData(false); return pickLeague(d); } catch (_) { /* fall through */ }
  if (store.settings.league) return store.settings.league;
  try {
    const l = await getJson(`https://poe.ninja/${G().ninja}/api/economy/leagues`);
    const first = Array.isArray(l) ? l[0] : (l && (l.economyLeagues || l.leagues || [])[0]);
    if (first) return first.name || first.id;
  } catch (_) { /* ignore */ }
  return 'Standard';
}

async function refreshDivineRate(force) {
  if (store.settings.autoRate === false) return { ok: true, auto: false, rate: store.settings.divineRate || null };
  let fresh = store.settings.divineRateAt && Date.now() - store.settings.divineRateAt < HOUR;
  // a rate from another league (e.g. Standard while you play the new one) is far off: fetch again
  if (fresh && store.settings.divineRateLeague) { try { fresh = store.settings.divineRateLeague === await ninjaLeague(); } catch (_) { /* keep it */ } }
  if (!force && fresh && store.settings.divineRate) {
    return { ok: true, auto: true, rate: store.settings.divineRate, at: store.settings.divineRateAt, league: store.settings.divineRateLeague };
  }
  const game = tg(); const base = G(game).base;
  if (rateFetches[game]) return rateFetches[game];
  const p = rateFetches[game] = (async () => {
    const league = await ninjaLeague();
    if (game !== store.activeGame()) return { ok: false, auto: true, error: 'game changed' };
    let lastErr = 'no data';
    for (const url of rates.ninjaUrls(league, game)) {
      try {
        const data = await getJson(url);
        const rate = rates.divineInExalts(data, base);
        const all = rates.currencyRatesInExalts(data, base);
        if (game !== store.activeGame()) return { ok: false, auto: true, error: 'game changed' }; // you switched game meanwhile
        // a near-empty answer (a league poe.ninja doesn't track) mustn't replace good saved rates
        if (all && Object.keys(all).length >= 3) store.setSetting('currencyRates', { ...all, divine: rate || all.divine });
        if (rate) {
          store.setSetting('divineRate', rate);
          store.setSetting('divineRateAt', Date.now());
          store.setSetting('divineRateLeague', league);
          log(`divine rate ${rate} ${G(game).baseShort} (${G(game).short} ${league}) from ${url}`);
          return { ok: true, auto: true, rate, at: Date.now(), league };
        }
        lastErr = `Divine/${base} price not found in poe.ninja data`;
      } catch (err) { lastErr = err.message || String(err); }
    }
    log('divine rate fetch failed: ' + lastErr);
    return { ok: false, auto: true, rate: store.settings.divineRate || null, at: store.settings.divineRateAt, league, error: lastErr };
  })();
  try { return await p; } finally { if (rateFetches[game] === p) delete rateFetches[game]; }
}

ipcMain.handle('rate:get', (_e, force) => refreshDivineRate(!!force));

// One click searches. target: a slot, 'Ring' (your weaker ring), '__last' or
// { itemId } (a copied item). mode 'similar' (default) = same stats or better,
// loosened step by step until something is listed; 'weights' = beats your
// item by your stat weights.
ipcMain.handle('trade:quick', inGame(async (_e, target, mode, extra) => {
  const item = resolveItem(target);
  if (!item) return { ok: false, error: `Nothing saved for ${typeof target === 'string' ? target : 'that item'} yet.` };
  let d;
  try { d = await loadTradeData(false); } catch (err) {
    return { ok: false, error: 'Could not load trade site data: ' + (err.message || err) };
  }
  if (!sameGame()) return SWITCHED();
  if (extra && extra.league && leagueOk(d, extra.league)) setGameSetting('league', extra.league);
  if (extra && extra.status) store.setSetting('status', extra.status);
  const league = pickLeague(d, extra && extra.league);
  const armourOrWeapon = ['Weapon', 'Offhand', 'Helmet', 'Body Armour', 'Gloves', 'Boots'].includes(item.slot);
  const opts = {
    statIndex: d.index, filtersData: d.filters, preferLocal: armourOrWeapon,
    minGainPct: store.settings.minGainPct || 0, status: store.settings.status,
    ignoreRules: ignoreRules(), game: tg(),
  };
  await refreshDivineRate(false);
  const budget = budgetNow();
  const base = { item: item.name, itemClass: item.itemClass, budget: trade.budgetLabel(budget, tg()) };

  if (mode === 'craft') {
    if (tg() === 'poe1') return { ok: false, error: "Craftable bases isn't available for PoE1 yet (it uses the PoE2 gear score)." };
    const go = gearOpts();
    const top = gearLib.topStats(item.slot, 2, go);
    if (!top.length) return { ok: false, error: 'Pick a build (Build & stats) so the app knows which stats matter on this slot.' };
    const q = trade.buildCraftQuery(item, { ...opts, top });
    trade.applyBudget(q.body, budget, tg());
    const r = await openIfAny(await runSearch(league, q.body, 'craft'), {
      item, mode: 'craft', body: q.body, searchKey: searchKey(q.body),
      title: `Craftable ${item.itemClass || 'bases'}: ${q.keyStats.join(' + ')} + an open affix`,
      note: `Rare, not corrupted, at least one open prefix or suffix, with ${q.keyStats.join(' and ')} already on it. Cheapest first.`,
    });
    return { ...base, ...r, mode: 'craft', keyStats: q.keyStats, unmatched: q.unmatched };
  }

  // default "Find upgrades": Path of Building's weighted search when your build is loaded,
  // otherwise better for your build by gear score
  const pobSlot = (() => {
    if (item.slot === 'Jewel') return 'Jewel'; // PoB picks the socket (pobJewelSocket)
    const sl = WEAKEST_OF.includes(item.slot) ? (resolveSlotOf(item) || (SLOT_GROUPS[item.slot] || [])[0]) : item.slot; return pobVerdict.SLOT_TO_POB[sl] ? sl : null;
  })();
  if (mode === 'upgrade' && pobOn() && pobSlot) mode = 'pob';
  if (mode === 'upgrade') mode = !gearScoreOn() || /unique/i.test(item.rarity || '') ? 'similar' : 'gear';
  if (mode === 'pob') {
    try {
      const r = await pobSearch(item, pobSlot, league, budget, opts);
      if (r) return { ...base, ...r };
    } catch (err) { log('pob search: ' + (err.stack || err)); }
    mode = !gearScoreOn() || /unique/i.test(item.rarity || '') ? 'similar' : 'gear'; // fall back
  }
  if (mode === 'gear') {
    const go = gearOpts();
    const slot = WEAKEST_OF.includes(item.slot) ? (resolveSlotOf(item) || SLOT_GROUPS[item.slot][0]) : item.slot;
    const weights = gearLib.searchWeights(item.slot, { ...go, resNeed: resNeedFor(slot) });
    if (!weights.length) return { ok: false, error: 'Your build has no weighted stats for this slot.' };
    const g = gearOf(item, slot);
    let r = null; let q = null; let level = 0;
    const LEVELS = [{ share: 1.06, baseShare: 0.9, label: 'clearly better than yours' }, { share: 1, baseShare: 0.85, label: 'a little better than yours' }, { share: 0.9, baseShare: 0.75, label: 'within 10% of yours' }];
    // if the trade site says "too complex", shrink the search step by step (logged out it
    // allows only a handful of filters); the results are still scored by your gear score
    const SIZES = [{ maxFilters: 40 }, { maxFilters: 20, explicitOnly: true }, { maxFilters: 10, explicitOnly: true, coreShare: 0 }, { maxFilters: 6, explicitOnly: true, coreShare: 0 }, { countOnly: true, explicitOnly: true }];
    // start at the size the trade site accepted last time, so we don't spend searches on ones it rejects
    const sizeKey = (await signedIn()) ? 'signed' : 'anon';
    const learnedSize = (store.settings.gearSearchSize || {})[sizeKey] || 0;
    let size = Math.min(learnedSize, SIZES.length - 1); let shrunk = size > 0;
    for (; level < LEVELS.length; level++) {
      for (;;) {
        q = trade.buildGearQuery(item, { ...opts, weights, ...LEVELS[level], ...SIZES[size] });
        if (!q.filters) return { ok: false, error: 'None of your build\'s stats for this slot could be matched on the trade site.' };
        trade.applyBudget(q.body, budget, tg());
        r = await runSearch(league, q.body, `gear L${level}${size ? ` size${size}` : ''}`);
        if (!(r && r.tooComplex) || size >= SIZES.length - 1) break;
        size++; shrunk = true;
        setGameSetting('gearSearchSize', { ...(store.settings.gearSearchSize || {}), [sizeKey]: Math.max(size, (store.settings.gearSearchSize || {})[sizeKey] || 0) });
      }
      if (r && r.tooComplex) return { ok: false, error: `The trade site says this search has too many filters even at its smallest.${(await signedIn()) ? '' : ' Signing in to pathofexile.com (Settings → Trade site account) raises the limit.'}` };
      if (!r.ok || r.total == null || r.total > 0) break;
      if (q.countOnly) break; // the simplest form doesn't get looser
      if (r.near) break;
      await new Promise((res) => setTimeout(res, 700));
    }
    if (level >= LEVELS.length) level = LEVELS.length - 1;
    if (r && r.ok) {
      await openIfAny(r, {
        item, mode: 'gear', body: q.body, searchKey: searchKey(q.body),
        title: `Better for your build than ${item.name}${g && g.score != null ? ` (gear score ${g.score})` : ''}`,
        note: q.countOnly ? `The trade site only allowed a simple search${(await signedIn()) ? '' : ' (sign in under Settings for better ones)'}: items with ${q.body.query.stats[0].value.min}+ of ${q.keyStats.join(', ')} at a good roll, cheapest first. Use Upgrades only / Best gear score to see which beat yours.`
          : shrunk && level === 0 ? `Scored with your build's main weights (the trade site limits filters${(await signedIn()) ? '' : ' – signing in under Settings allows more'}). Best for your build first.`
          : level === 1 ? 'No clear upgrade is listed right now, so these are the ones a little better than yours.'
          : level > 1 ? `Nothing beats it yet, so these come close (${LEVELS[level].label}). Sorted cheapest first; sort by Best gear score to compare.`
          : `Scored with your build's weights (${q.parts.slice(0, 5).join(', ')}${q.parts.length > 5 ? '…' : ''})${q.needCore ? `, with at least ${q.needCore} of: ${q.keyStats.join(', ')}` : ''}. Best for your build first.`,
      });
    }
    return { ...base, ...r, mode: 'gear', level, levelLabel: LEVELS[level].label, score: g && g.score, filters: q.filters, excluded: q.excluded };
  }

  if (mode === 'weights') {
    const q = trade.buildUpgradeQuery(item, store.weights, opts);
    if (!(q.currentScore > 0)) {
      return { ok: false, error: `None of your stat weights are on this ${item.itemClass ? item.itemClass.toLowerCase().replace(/s$/, '') : 'item'}, so "By my weights" would match almost anything. Use Find upgrades, or set weights for its stats (Build & stats).` };
    }
    if (!q.body.query.stats.length && !q.body.query.filters.equipment_filters) {
      return { ok: false, error: 'None of your weighted stats could be matched on the trade site. Set weights for your build\'s stats first.' };
    }
    trade.applyBudget(q.body, budget, tg());
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
    trade.applyBudget(q.body, budget, tg());
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
}));

// ---------- price check ("What's it worth?") ----------

// Both units, so prices are easy to compare: "2 div (1,393 ex)" / "180 ex (0.26 div)"
function fmtEx(ex) {
  if (ex == null) return '?';
  const div = store.settings.divineRate;
  const u = G().baseShort; // ex (PoE2) or chaos (PoE1)
  const exText = ex < 10 ? `${Math.round(ex * 10) / 10} ${u}` : `${Math.round(ex).toLocaleString('en')} ${u}`;
  if (!div) return exText;
  if (ex >= div * 0.95) return `${Math.round((ex / div) * 10) / 10} div (${Math.round(ex).toLocaleString('en')} ${G().baseShort})`;
  if (ex / div < 0.05) return exText; // "0.01 div" says nothing
  return `${exText} (${Math.round((ex / div) * 100) / 100} div)`;
}

// the price verdict, with everything that makes it less certain said out loud
function priceSummary(listings, league) {
  const s = priceLib.priceStats(listings);
  if (!s) return null;
  const pl = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const notes = [];
  const rate = store.settings.divineRate;
  if (s.unconvertible) notes.push(`${pl(s.unconvertible, 'listing is', 'listings are')} priced in ${rate ? 'a currency' : 'divines or a currency'} without a known ${G().base} rate${rate ? '' : " (poe.ninja couldn't be reached)"}, so ${s.unconvertible === 1 ? "it's" : "they're"} left out`);
  if (rate && store.settings.divineRateAt && Date.now() - store.settings.divineRateAt > 6 * HOUR) notes.push(`the divine rate (${rate} ${G().baseShort}) is ${Math.round((Date.now() - store.settings.divineRateAt) / HOUR)} hours old`);
  if (rate && league && store.settings.divineRateLeague && store.settings.divineRateLeague !== league) notes.push(`the divine rate is from ${store.settings.divineRateLeague}, not ${league}`);
  if (s.baits) notes.push(`${pl(s.baits, 'listing', 'listings')} far under the rest left out (likely price-fixing bait)`);
  if (s.stale) notes.push(`${pl(s.stale, 'listing', 'listings')} older than ${priceLib.STALE_DAYS} days left out`);
  if (s.staleKept) notes.push(`${pl(s.staleKept, 'listing is', 'listings are')} over ${priceLib.STALE_DAYS} days old and may not be a real offer`);
  if (s.noPrice) notes.push(`${s.noPrice} unpriced`);
  if (s.spread && !s.few) notes.push('prices vary a lot');
  const out = {
    count: s.count, sellers: s.sellers, total: s.total, notes,
    cheapestEx: s.cheapestEx == null ? null : s.cheapestEx, typicalEx: null, few: !!s.few, unreliable: s.unreliable,
    cheapest: s.cheapestEx == null ? null : fmtEx(s.cheapestEx), typical: null, range: null,
  };
  if (s.unreliable) {
    out.verdict = `Can't price this reliably: ${s.unconvertible} of the listings are priced in currencies without a known rate.`;
  } else if (s.few) {
    out.verdict = s.count ? `Only ${s.count} listed – not enough to judge${s.count ? ` (from ${fmtEx(s.cheapestEx)})` : ''}.` : 'No priced listings.';
  } else {
    out.typicalEx = s.typicalEx; out.typical = fmtEx(s.typicalEx);
    out.range = s.lowEx !== s.highEx ? `${fmtEx(s.lowEx)} – ${fmtEx(s.highEx)}` : null;
    out.verdict = `Worth about ${out.typical}${out.range ? ` (most ${out.range})` : ''}.`;
  }
  return out;
}

// ---------- where to spend your divines ----------
ipcMain.handle('trade:price', inGame(async (_e, target, picks) => {
  const item = resolveItem(target);
  if (!item) return { ok: false, error: 'No item to price.' };
  let d;
  try { d = await loadTradeData(false); } catch (err) { return { ok: false, error: 'Could not load trade site data: ' + (err.message || err) }; }
  await refreshDivineRate(false);
  const league = pickLeague(d);
  const armourOrWeapon = ['Weapon', 'Offhand', 'Helmet', 'Body Armour', 'Gloves', 'Boots'].includes(item.slot);
  // Price check looks for close matches to THIS item, without your price range
  // or ignored stats (those are about what you want, not what it's worth).
  // always "available" listings (instant buyout + in person): offline sellers' prices aren't what it sells for
  const opts = { statIndex: d.index, filtersData: d.filters, preferLocal: armourOrWeapon, forPrice: true, game: tg() };
  let r = null; let q = null;
  // you chose the stats in the popup: exactly those, at your minimums (with the same rarity,
  // corruption, links and influences as the item), one search
  const chosen = Array.isArray(picks) ? picks.filter((p) => p && typeof p.key === 'string').slice(0, 20) : null;
  for (let level = 0; level < (chosen ? 1 : 3); level++) {
    q = trade.buildSimilarQuery(item, { ...opts, level });
    if (chosen) {
      const c = trade.buildQuery(chosen.map((p) => ({ key: p.key, min: p.min, max: p.max, source: p.source, id: p.id, idType: p.idType })), { itemClass: item.itemClass, statIndex: d.index, filtersData: d.filters, preferLocal: armourOrWeapon, status: 'available' });
      q.body.query.stats = c.body.query.stats;
      const eq = c.body.query.filters && c.body.query.filters.equipment_filters;
      if (eq) q.body.query.filters.equipment_filters = eq; else delete q.body.query.filters.equipment_filters;
      q.levelLabel = 'the stats you chose'; q.need = chosen.length - c.unmatched.length; q.total = chosen.length;
      if (c.unmatched.length) q.unmatched = c.unmatched;
    }
    q.body.sort = { price: 'asc' };
    r = await runSearch(league, q.body, chosen ? 'price chosen' : `price L${level}`);
    if (!r.ok || r.total == null || r.total >= 3) break;
    if (r.near) break;
    await new Promise((res) => setTimeout(res, 700));
  }
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'Search failed.' };
  // the search itself failed (only a pre-filled link came back): open that rather than saying "nothing listed"
  if (r.total == null) { if (r.url) shell.openExternal(r.url); return { ok: true, mode: 'price', total: null, league, item: item.name, url: r.url, opened: true, levelLabel: q.levelLabel }; }
  if (!r.total) return { ok: true, mode: 'price', total: 0, league, item: item.name, url: r.url, levelLabel: q.levelLabel };
  const ctx = { item, mode: 'price', title: `Price check: ${item.name}`, body: q.body, searchKey: searchKey(q.body),
    note: `Listings like this one (${q.levelLabel}, ${q.need} of ${q.total} stats), cheapest first.` };
  if (!sameGame()) return SWITCHED();
  const shown = r.ids && r.ids.length ? await showResults(r, ctx) : false;
  let summary = null;
  if (shown) {
    summary = priceSummary(resultsState.listings, league);
    resultsState.ctx.priceSummary = summary;
    resultsState.ctx.priceLeague = league;
    if (summary && summary.typicalEx != null && item.id) lastWorth.set(item.id, summary.typicalEx);
    if (resultsWin && !resultsWin.isDestroyed()) resultsWin.webContents.send('results:data', resultsPayload());
  } else {
    await shell.openExternal(r.url);
  }
  return { ok: true, mode: 'price', total: r.total, league, item: item.name, url: r.url, inApp: shown, opened: true,
    summary, levelLabel: q.levelLabel, level: q.level, need: q.need, of: q.total };
}));

// ---------- saved searches ----------

// ---------- saved-search alerts ----------
const { Notification, session } = require('electron');
// ---------- pathofexile.com account (optional) ----------
// pathofexile.com gives every visitor a POESESSID cookie, signed in or not, so the cookie alone
// proves nothing (that made the sign-in window close at once). Ask the site itself: the account
// page answers normally when you're signed in and redirects to /login when you're not.
// (backup check: a signed-in page has a log-out link)
const CHECK_JS = `(async () => {
  try {
    const r = await fetch('/my-account', { redirect: 'manual', credentials: 'include' });
    if (r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) return { type: 'opaqueredirect', status: r.status };
    if (r.status === 200 && !/\\/login/.test(r.url)) return { type: r.type, status: 200, url: r.url };
    const h = await fetch('/', { credentials: 'include' }).then((x) => x.text());
    return /href="[^"]*\\/logout/i.test(h) ? { type: 'basic', status: 200, url: '/' } : { type: 'none', status: r.status };
  } catch (e) { return { error: String(e) }; }
})()`;
async function checkIn(wc) {
  try {
    const r = await Promise.race([wc.executeJavaScript(CHECK_JS, true), new Promise((res) => setTimeout(() => res({ error: 'timeout' }), 10000))]);
    return !!r && !r.error && r.type !== 'opaqueredirect' && r.status === 200 && !/\/login/.test(r.url || '');
  } catch (_) { return false; }
}
let signedCache = { at: 0, v: false };
async function signedIn(force) {
  try {
    const c = await session.fromPartition(POE_PARTITION).cookies.get({ url: trade.BASE, name: 'POESESSID' });
    if (!c.length) { signedCache = { at: Date.now(), v: false }; return false; }
  } catch (_) { return false; }
  if (!force && Date.now() - signedCache.at < 10 * 60000) return signedCache.v;
  try {
    if (!tradeWin || tradeWin.isDestroyed()) tradeWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, partition: POE_PARTITION } });
    if (!tradeWin.webContents.getURL().startsWith(trade.BASE)) {
      await Promise.race([tradeWin.loadURL(`${trade.BASE}/${G().trade.page}`), new Promise((_, rej) => setTimeout(() => rej(new Error('page load timed out')), 15000))]);
    }
    signedCache = { at: Date.now(), v: await checkIn(tradeWin.webContents) };
  } catch (err) { log('sign-in check: ' + (err.message || err)); signedCache = { at: Date.now(), v: false }; }
  return signedCache.v;
}
ipcMain.handle('account:status', async () => ({ signedIn: await signedIn(true) }));
ipcMain.handle('account:signin', async () => {
  const w = new BrowserWindow({ width: 980, height: 820, title: 'Sign in to pathofexile.com', icon: ICON, autoHideMenuBar: true, webPreferences: { partition: POE_PARTITION, sandbox: true, contextIsolation: true } });
  w.loadURL(`${trade.BASE}/login`);
  return new Promise((resolve) => {
    let busy = false; let done = false;
    const finish = async (v) => { if (done) return; done = true; clearInterval(t); signedCache = { at: Date.now(), v }; if (v) log('signed in to pathofexile.com'); notifySettings('settings:changed'); resolve({ signedIn: v }); };
    // only check once you've left the login page (after submitting it), and keep the window open until it's real
    const t = setInterval(async () => {
      if (busy || w.isDestroyed()) return;
      const url = w.webContents.getURL();
      if (!url.startsWith(trade.BASE) || /\/login/i.test(url) || w.webContents.isLoading()) return;
      busy = true;
      const ok = await checkIn(w.webContents);
      busy = false;
      if (ok) { await finish(true); if (!w.isDestroyed()) w.close(); }
    }, 1500);
    w.on('closed', async () => { if (!done) await finish(await signedIn(true)); });
  });
});
ipcMain.handle('account:signout', async () => {
  await session.fromPartition(POE_PARTITION).clearStorageData();
  signedCache = { at: Date.now(), v: false };
  log('signed out of pathofexile.com');
  return { signedIn: false };
});
// Open the trade site on this one listing: same search, narrowed to the seller's account,
// so it's at the top of the page with the site's own Travel to Hideout / whisper buttons.
function listingUrl(l) {
  const st = resultsState;
  if (!st || !st.r) return null;
  if (!l || !l.account || !st.r.body) return st.r.url;
  const body = JSON.parse(JSON.stringify(st.r.body));
  const q = body.query || (body.query = {});
  q.filters = q.filters || {};
  const tf = q.filters.trade_filters || (q.filters.trade_filters = { filters: {} });
  tf.filters = tf.filters || {};
  tf.filters.account = { input: l.account };
  return trade.prefilledUrl(st.r.league, body, st.r.game);
}
ipcMain.handle('trade:openListing', (_e, listingId) => {
  const l = resultsState && resultsState.listings.find((x) => x.id === listingId);
  const url = listingUrl(l);
  if (!url) return { ok: false };
  shell.openExternal(url);
  return { ok: true, exact: !!(l && l.account) };
});
// Instant Buyout: ask the trade site to take you to the seller's hideout (needs sign-in).
ipcMain.handle('trade:hideout', async (_e, listingId) => {
  const l = resultsState && resultsState.listings.find((x) => x.id === listingId);
  if (!l || !l.instant) return { ok: false, error: 'This seller takes whispers, not instant buyouts: use Copy whisper.' };
  if (!(await signedIn())) return { ok: false, needSignIn: true, error: 'Sign in to pathofexile.com first – it only takes you to hideouts for a signed-in account.' };
  try {
    // the trade site only hands out the hideout token to a signed-in account: listings fetched by the app
    // don't have it, so fetch this one listing again through your signed-in trade page (as the site does)
    if (!l.hideoutToken) {
      const got = await fetchViaPage(resultsState.r.league, resultsState.r.searchId, [l.id], resultsState.r.game);
      const tok = got && got[0] && got[0].listing && got[0].listing.hideout_token;
      if (!tok) return { ok: false, error: 'The trade site didn\'t offer a hideout trip for this listing (it may be sold). Try "on trade site".' };
      l.hideoutToken = tok;
    }
    if (!tradeWin || tradeWin.isDestroyed()) tradeWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, partition: POE_PARTITION } });
    if (!tradeWin.webContents.getURL().startsWith(trade.BASE)) await tradeWin.loadURL(trade.pageUrl(resultsState.r.game, resultsState.r.league));
    const js = `fetch('/api/${G(resultsState.r.game).trade.api}/whisper', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: ${JSON.stringify(JSON.stringify({ token: l.hideoutToken }))} }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }))`;
    const r = await tradeWin.webContents.executeJavaScript(js, true);
    log(`hideout travel: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    if (r.status === 200 && !(r.json && r.json.error)) return { ok: true };
    return { ok: false, error: (r.json && r.json.error && r.json.error.message) || `The trade site said ${r.status}.` };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

// ---------- start with Windows (or with your Linux desktop) ----------

function applyLoginItem() {
  if (process.platform === 'linux') return applyLinuxAutostart();
  try {
    const openAtLogin = !!store.settings.startWithWindows;
    const args = app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'];
    // the portable .exe runs from a temporary copy: start the real file instead
    const portable = process.env.PORTABLE_EXECUTABLE_FILE;
    app.setLoginItemSettings({ openAtLogin, path: portable || process.execPath, args });
  } catch (err) { log('login item: ' + err.message); }
}

// Linux desktops start what's in ~/.config/autostart (the AppImage, quietly in the tray)
function applyLinuxAutostart() {
  try {
    const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(require('os').homedir(), '.config'), 'autostart');
    const file = path.join(dir, 'poe2-upgrade-checker.desktop');
    if (!store.settings.startWithWindows) { if (fs.existsSync(file)) fs.unlinkSync(file); return; }
    const exe = process.env.APPIMAGE || process.execPath;
    const q = (s) => `"${String(s).replace(/(["\\`$])/g, '\\$1')}"`;
    const exec = app.isPackaged ? `${q(exe)} --hidden` : `${q(exe)} ${q(app.getAppPath())} --hidden`;
    fs.mkdirSync(dir, { recursive: true });
    // .desktop Exec: quoted args escape " ` $ \ with a backslash, then the value's own escaping doubles backslashes; % is %%
    const execLine = exec.replace(/\\/g, '\\\\').replace(/%/g, '%%');
    fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=PoE Upgrade Checker\nExec=${execLine}\nX-GNOME-Autostart-enabled=true\nTerminal=false\n`);
  } catch (err) { log('autostart: ' + err.message); }
}

// ---------- settings window & tray ----------

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  // reopen where you left it (e.g. maximized on your second monitor)
  const saved = store.settings.settingsBounds;
  const onScreen = saved && screen.getAllDisplays().some((d) => {
    const a = d.workArea; return saved.x >= a.x - 50 && saved.y >= a.y - 50 && saved.x < a.x + a.width - 100 && saved.y < a.y + a.height - 100;
  });
  settingsWin = new BrowserWindow({
    width: onScreen ? saved.width : 1240, height: onScreen ? saved.height : 860, ...(onScreen ? { x: saved.x, y: saved.y } : {}),
    minWidth: 640, minHeight: 480,
    title: 'PoE Upgrade Checker', icon: ICON, autoHideMenuBar: true,
    backgroundColor: '#14110f',
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  if (onScreen && store.settings.settingsMaximized) settingsWin.maximize();
  let bt = null;
  const remember = () => {
    clearTimeout(bt);
    bt = setTimeout(() => {
      if (!settingsWin || settingsWin.isDestroyed()) return;
      const max = settingsWin.isMaximized();
      store.setSetting('settingsMaximized', max);
      if (!max && !settingsWin.isMinimized()) store.setSetting('settingsBounds', settingsWin.getBounds());
    }, 400);
  };
  settingsWin.on('move', remember); settingsWin.on('resize', remember); settingsWin.on('maximize', remember); settingsWin.on('unmaximize', remember);
  settingsWin.loadFile(path.join(__dirname, 'ui', 'settings.html'));
}

// ---------- auto-update (installed app only; releases on GitHub) ----------
function buildTrayMenu() {
  const paused = !!store.settings.paused;
  tray.setToolTip(paused ? 'PoE Upgrade Checker (paused)' : 'PoE Upgrade Checker');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: hotkeyStatus.ok ? `Hotkey: ${hotkeyStatus.accelerator}` : 'Hotkey not set (see Settings)', enabled: false },
    { label: `${G(store.activeGame()).short}${G(store.activeGame()).beta ? ' (beta)' : ''} · Character: ${(store.listProfiles().find((p) => p.active) || {}).name || '—'}`, enabled: false },
    { label: `Show / hide results${resultsHotkey ? ` (${resultsHotkey})` : ''}`, click: toggleResults, enabled: !!resultsState },
    ...(updates.upd.state === 'ready' ? [{ label: `Restart to update to ${updates.upd.version}`, click: () => updates.updater() && updates.updater().quitAndInstall(true, true) }] : []),
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
  shownGame = store.activeGame();
  store.onError = (err) => log('could not save settings: ' + err.message);
  if (store.loadError) setTimeout(() => log(`settings file couldn't be read (${store.loadError}); a copy was kept as poe2-upgrade-checker.json.unreadable-*`), 0);
  // Don't pop up for whatever happened to be on the clipboard at launch.
  try { lastClip = clipboard.readText(); } catch (_) { lastClip = ''; }

  tray = new Tray(nativeImage.createFromPath(ICON));
  tray.on('click', openSettings);
  buildTrayMenu();
  createPopup();
  log(`started v${app.getVersion()} on ${process.platform}`);
  keys = new KeySender(log, app.getPath('userData'));
  keys.start();
  // one-time: old letter defaults clash with WASD movement -> F-keys
  if (!store.settings.hotkeyMigrated) {
    if (!store.settings.hotkey || store.settings.hotkey === 'Ctrl+D') { store.setSetting('hotkey', DEFAULT_HOTKEY); log('hotkey: moved from Ctrl+D to F2 (D is a movement key)'); }
    store.setSetting('hotkeyMigrated', true);
  }
  // older resistance records: pin them to the gear worn now so later swaps move the totals
  if (store.settings.resists && !store.settings.resists.gear) {
    store.setSetting('resists', { ...store.settings.resists, gear: resLib.gearRes(store.equipped), source: store.settings.resists.source || 'pob' });
  }
  // the gear-score profile used to default to the Djinn summoner: keep it for people already using it
  if (!store.settings.build) store.setSetting('build', store.settings.wizardDone || Object.keys(store.equipped || {}).length ? 'djinn-varashta' : gearLib.DEFAULT_BUILD);
  pobSync();
  // start Path of Building for the game you're on a little after launch, so the first F2 doesn't
  // wait for it to load (it still stops by itself after a while unused)
  if (store.settings.warmPob !== false) setTimeout(() => { if (pobOn()) pobEngine().ensureLoaded().then(() => log('pob: ready before the first F2')).catch((err) => log('pob warm-up: ' + err.message)); }, 6000);
  process.on('uncaughtException', (err) => log('error: ' + (err && err.stack || err)));
  process.on('unhandledRejection', (err) => log('error (promise): ' + (err && err.stack || err)));
  registerHotkey();
  registerResultsHotkey();
  buildTrayMenu();
  setInterval(pollClipboard, 250);
  setInterval(watchCursor, 200);
  setInterval(() => runAlerts(false).catch((e) => log('alerts: ' + e.message)), 60000);
  try { app.setAppUserModelId('local.poe2.upgradechecker'); } catch (_) { /* ignore */ }
  refreshDivineRate(false).catch(() => {});
  setInterval(() => refreshDivineRate(false).catch(() => {}), HOUR);
  applyLoginItem();
  updates.setupUpdater();
  usage.start();
  const hidden = process.argv.includes('--hidden') || store.settings.openSettingsOnStart === false;
  if (!hidden) openSettings();
});

app.on('window-all-closed', (e) => { /* keep running in the tray */ });
app.on('will-quit', () => { globalShortcut.unregisterAll(); if (keys) keys.stop(); for (const e of Object.values(pobEngs)) e.kill(); });
