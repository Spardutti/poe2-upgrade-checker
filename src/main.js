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
let pobEng = null;
function pobEngine() {
  if (!pobEng) pobEng = createEngine({ log, appPath: path.join(__dirname, '..'), resourcesPath: process.resourcesPath, packaged: app.isPackaged });
  return pobEng;
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
const pobPriorities = () => ({ ...pobVerdict.DEFAULT_PRIORITIES, ...(store.settings.priorities || {}) });
// Chaos Inoculation (seen in your PoB build) makes chaos resistance irrelevant
// (remembered per character from the last time PoB loaded the build, so it doesn't flip when the engine idles)
const pobCI = () => {
  const i = pobEng && pobEng.info();
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
    const group = x.item.slot && SLOT_GROUPS[x.item.slot];
    const slots = group && group.every((g) => pobVerdict.SLOT_TO_POB[g]) ? group : [x.slot || x.item.slot];
    for (const sl of slots) { const ps = pobVerdict.SLOT_TO_POB[sl]; if (ps) { req.push({ slot: ps, text }); idx.push([i, sl]); } }
  });
  const per = list.map(() => []);
  if (req.length) {
    const res = await pobEngine().evalItems(req);
    res.forEach((r, k) => {
      if (!r || !r.ok) return;
      if (r.multi) {
        // a jewel that's already in one of your sockets is only compared with itself there
        const nm = list[idx[k][0]].item && list[idx[k][0]].item.name;
        const own = r.multi.filter((m) => nm && m.replacing === nm);
        for (const m of (own.length ? own : r.multi)) {
          const j = pobVerdict.judge(r.before, m.after, pobWeights());
          if (j) { j.slot = idx[k][1]; j.socket = { slot: m.slot, label: m.label, replacing: m.replacing || null }; per[idx[k][0]].push(j); }
        }
        return;
      }
      const j = pobVerdict.judge(r.before, r.after, pobWeights());
      if (j) { j.slot = idx[k][1]; per[idx[k][0]].push(j); }
    });
  }
  return per.map((arr) => pobVerdict.best(arr));
}
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
    pobSlotName = sock.slot; jewelType = isRadiusJewel(item) ? 'Radius' : 'Base';
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
      return Number.isFinite(v) && v < 75 - 0.5 && !(tot > v + 0.5);
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
    trade.applyBudget(body, budget);
    r = await runSearch(league, body, `pob ${slot}${size ? ` size${size}` : ''}`);
    if (!(r && r.tooComplex) || size >= SIZES.length - 1) break;
    size++;
    store.setSetting('pobSearchSize', { ...(store.settings.pobSearchSize || {}), [sizeKey]: size });
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
  const res = await openIfAny(r, {
    item, mode: 'pob', body, searchKey: searchKey(body),
    title: `Best for your build: ${item.slot === 'Ring' ? 'rings' : slot === 'Jewel' ? (isRadiusJewel(item) ? 'radius jewels' : 'jewels') : slot}`,
    note: `Path of Building weighted this search by what each stat does to your build (${used} stats${used < wg.filters.length ? `, the trade site allowed ${used} of ${wg.filters.length}` : ''})${boosted.length ? ', with extra weight on the resistances you still need' : ''}${needDmg}. Every listing below is then checked with your build: items that lose resistance or damage are marked and go to the bottom.`,
  });
  return { ...res, mode: 'pob', filters: used };
}

// put a PoB verdict onto a comparison (popup result or listing compare)
function applyPob(r, j) {
  if (!r || !j) return r;
  r.pob = j;
  r.verdict = j.verdict;
  r.scoreMode = 'pob';
  r.delta = j.score;
  r.pct = null;
  if (j.socket) r.replacing = [j.socket.replacing ? `${j.socket.replacing} (${j.socket.label})` : `an empty jewel socket (${j.socket.label})`];
  else if (j.slot && j.slot !== r.targetSlot && store.equipped[j.slot]) { r.targetSlot = j.slot; r.replacing = [store.equipped[j.slot].name]; }
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
  const withPob = result && result.ok && !result.isEquipped && result.item && pobOn();
  if (withPob) result.pobPending = true;
  const send = () => popup && popup.webContents.send('popup:result', serialise(result));
  if (popup.webContents.isLoading()) popup.webContents.once('did-finish-load', send);
  else send();
  if (withPob) {
    const item = popupItem;
    pobJudge([{ item: result.item.raw ? result.item : (item || result.item), slot: result.targetSlot }]).then(([j]) => {
      result.pobPending = false;
      if (!j) result.pobError = 'Path of Building could not read this item.';
      else applyPob(result, j);
    }).catch((err) => { result.pobPending = false; result.pobError = err.message; log('pob: ' + err.message); })
      .then(() => { if (popupItem === item && popup && !popup.isDestroyed() && popup.isVisible()) popup.webContents.send('popup:result', serialise(result)); });
  }
  // Renderer replies with its height via popup:resize; show anyway if it doesn't.
  clearTimeout(showFallback);
  showFallback = setTimeout(() => { if (pendingShow) revealPopup(null); }, 400);
}

function serialise(result) {
  return JSON.parse(JSON.stringify({
    ...result, pobNudge: !!(result && result.ok && !result.pob && !result.pobPending && !result.pobError && pobEngine().available() && !pobXml()), slots: SLOTS, slotGroups: SLOT_GROUPS, budgetLabel: trade.budgetLabel(budgetNow()),
    ui: { detail: store.settings.popupDetail || 'compact', colorblind: !!store.settings.colorblind, divineRate: store.settings.divineRate || null },
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
function handleItemText(text, source) {
  const item = parseItem(text);
  if (!item) {
    log(`${source}: clipboard is not item text: ${JSON.stringify(String(text).slice(0, 80))}`);
    return false;
  }
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
  if (/game-admin/.test(s)) return 'Path of Exile 2 is running as administrator, so Windows blocks the Ctrl+C this app sends it. Start the game normally (not "Run as administrator"), or start this app as administrator too.';
  if (isMe(over)) return `Your mouse was over this app's window, not the game. Hover the item in game, then press ${hk}.`;
  if (/refocus-failed/.test(s) || (fg && !isGame(fg) && fg !== '?')) {
    return `Path of Exile 2 wasn't the active window${fg && fg !== '?' ? ` (${fg} was)` : ''}, so the copy went there. Click once in the game, then press ${hk} again.`;
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
    if (text && handleItemText(text, 'hotkey')) return;
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
  const k = String(accel || '').split('+').pop();
  if (/^[WASD]$/i.test(k)) return `${k.toUpperCase()} is a movement key (WASD) in PoE2, so the game will also act on it. An F-key (e.g. F2) works best.`;
  if (/^[QERTF]$/i.test(k)) return `${k.toUpperCase()} is often a skill key in PoE2, so the game may also act on it. An F-key (e.g. F2) works best.`;
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

ipcMain.handle('hotkey:set', (_e, accel) => {
  const prev = store.settings.hotkey || DEFAULT_HOTKEY;
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
  if (target === '__last') return lastItem;
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
  if (popupItem && popup && popup.isVisible()) {
    const r = evaluate(popupItem);
    popup.webContents.send('popup:result', serialise(r));
    // and Path of Building again (settings like priorities change its verdict)
    if (r && r.ok && !r.isEquipped && pobOn()) {
      const item = popupItem;
      pobJudge([{ item, slot: r.targetSlot }]).then(([j]) => {
        if (j && popupItem === item && popup && !popup.isDestroyed() && popup.isVisible()) popup.webContents.send('popup:result', serialise(applyPob(r, j)));
      }).catch((err) => log('pob: ' + err.message));
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
ipcMain.handle('profiles:switch', (_e, id) => { const ok = store.switchProfile(id); log(`switched to character ${id}`); pobSync(); refreshAll(); buildTrayMenu(); return ok; });
ipcMain.handle('profiles:create', (_e, name, copy) => { const id = store.createProfile(name, copy); pobSync(); refreshAll(); return id; });
ipcMain.handle('profiles:rename', (_e, id, name) => { store.renameProfile(id, name); buildTrayMenu(); return true; });
ipcMain.handle('profiles:delete', (_e, id) => { const ok = store.deleteProfile(id); pobSync(); refreshAll(); return ok; });

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
    // numbers you typed from your character sheet beat PoB's
    const typed = store.settings.resists && store.settings.resists.source === 'game';
    if (r.resists && !typed) store.setSetting('resists', resLib.snapshot({ ...r.resists, cap: (store.settings.resists && store.settings.resists.cap) || 75 }, store.equipped, 'pob', store.settings.resists));
    // keep the build itself for the Path of Building engine
    try { fs.mkdirSync(path.dirname(pobFile()), { recursive: true }); fs.writeFileSync(pobFile(), xml); } catch (err) { log('pob: could not save the build: ' + err.message); }
    pobSync();
    refreshAll();
    const who = [r.character.ascendancy || r.character.className, r.character.level ? `level ${r.character.level}` : ''].filter(Boolean).join(', ');
    let message = `Imported ${slots.length} item${slots.length === 1 ? '' : 's'}${who ? ` (${who})` : ''}${r.resists ? ' and your resistances' : ''}.`;
    if (kept) message += ` Kept ${kept} you'd already copied from the game (same item, more detail).`;
    if (r.missingBase) message += ` PoB doesn't store base Armour/Energy Shield, so ${r.missingBase} armour piece${r.missingBase === 1 ? '' : 's'} score a bit low until you copy them in game once.`;
    log('pob import: ' + message);
    let engine = null;
    if (pobOn()) {
      try {
        const info = await pobEngine().ensureLoaded();
        engine = pobSummary(info);
        // the gear score (used when PoB can't judge something) gets a profile that fits this build
        if (!store.settings.buildPicked && engine) {
          const fit = engine.dpsKey === 'MinionDPS' ? 'djinn-varashta' : (engine.es || 0) > (engine.life || 0) * 2 ? 'es-caster' : 'life-res';
          if (fit !== store.settings.build) { store.setSetting('build', fit); log(`gear score profile set to ${fit} from the PoB build`); }
        }
        if (engine.mismatch.length) message += ` Note: ${engine.mismatch.join('; ')}.`;
      } catch (err) { engine = { ok: false, error: err.message }; log('pob: ' + err.message); }
    }
    return { ok: true, message, slots, engine };
  } catch (err) {
    log('pob import failed: ' + (err.stack || err));
    return { ok: false, error: err.message || String(err) };
  }
});

// what the engine says about your build, plus where it disagrees with your character sheet
function pobSummary(info) {
  if (!info) return null;
  const st = info.stats || {};
  const rs = liveResists();
  const mismatch = [];
  if (rs && rs.source === 'game') {
    for (const [El, el] of Object.entries(RES_EL)) {
      const typedV = rs[el]; const pobV = st[`${El}ResistTotal`];
      if (typedV != null && pobV != null && Math.abs(typedV - pobV) >= 5) mismatch.push(`PoB has ${El.toLowerCase()} res at ${Math.round(pobV)}%, your character sheet ${typedV}% – check PoB's Configuration (charms, buffs) and gear`);
    }
  }
  const dk = pobVerdict.dpsKey(st);
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
ipcMain.handle('pob:status', async (_e, load) => {
  const eng = pobEngine();
  const out = { available: eng.available(), hasBuild: !!pobXml(), on: pobOn(), enabled: store.settings.usePob !== false };
  if (load && pobOn()) {
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
ipcMain.handle('pob:enable', (_e, on) => { store.setSetting('usePob', !!on); if (on) pobSync(); refreshAll(); return pobOn(); });

ipcMain.handle('ignore:set', (_e, rules) => {
  store.setSetting('ignoreStats', ignoreLib.cleanRules(rules));
  log('ignored stats: ' + JSON.stringify(store.settings.ignoreStats));
  refreshAll();
  return store.settings.ignoreStats;
});

ipcMain.handle('state:get', () => JSON.parse(JSON.stringify({
  platform: process.platform, dataDir: app.getPath('userData'),
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
  budgetLabel: trade.budgetLabel(budgetNow()),
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

async function postSearch(league, body) {
  const res = await net.fetch(trade.searchUrl(league), {
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
let statusBroken = false; // set if the trade site rejects 'available'
async function runSearch(league, body, label, o = {}) {
  if (statusBroken && body.query.status && body.query.status.option === 'available') body.query.status.option = 'online';
  log(`search ${label || ''} league=${league} body=${JSON.stringify(body)}`);
  const errors = []; let complex = 0;
  // signed in, the trade site allows bigger searches: send it from the signed-in page first
  const order = (await signedIn()) ? [['page', postSearchViaPage], ['app', postSearch]] : [['app', postSearch], ['page', postSearchViaPage]];
  for (const [name, fn] of order) {
    if (!(await searchSlot(o.maxWait == null ? 30000 : o.maxWait))) {
      const w = Math.ceil(searchWait() / 1000);
      return { ok: false, league, rateLimited: true, error: `The trade site allows only a few searches a minute – try again in ${w} seconds.` };
    }
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
  return { ok: true, league, total: null, url: trade.prefilledUrl(league, body), fallback: errors.join('; ') };
}

// Show the results: in the app's results window (default) or the browser.
// ctx: { item, mode, title } - the item searched for (its class is needed to
// read the listings, and listings are scored against your equipped gear).
async function deliver(r, ctx) {
  if (!r.url || (r.total != null && r.total <= 0)) return r;
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
    rows: r.rows.slice(0, 16).map((x) => ({ key: x.key, diff: x.diff, weight: x.weight, impact: x.impact, useful: x.useful })),
    character: r.character || null, risks: r.risks || null, resRank: r.resRank || 0,
  } : null;
  const value = c && s.priceEx ? (c.delta / Math.max(s.priceEx, 1)) * (store.settings.divineRate || 1) : null; // score per divine
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
      x.valuePerDiv = x.priceEx && js[i].score > 0 ? (js[i].score / Math.max(x.priceEx, 1)) * (store.settings.divineRate || 1) : null;
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
    divineRate: store.settings.divineRate || null,
    listings: listings.map((x) => ({ ...x, item: x.item ? { name: x.item.name, baseType: x.item.baseType, rarity: x.item.rarity, itemLevel: x.item.itemLevel, lines: x.item.lines, id: x.item.id } : null })),
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
  const raw = await fetchListings(st.r.league, st.r.searchId, ids);
  st.next += ids.length;
  const rates = { ...(store.settings.currencyRates || {}), ...(store.settings.divineRate ? { divine: store.settings.divineRate } : {}) };
  for (const res of raw) {
    const s = listingLib.summarise(res, st.ctx.item && st.ctx.item.itemClass, rates);
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
  bringUpResults();
  buildTrayMenu();
  return true;
}

ipcMain.handle('results:more', async () => {
  if (!resultsState) return null;
  try { await loadMoreListings(10); } catch (err) { return { error: err.message || String(err) }; }
  return resultsPayload();
});
ipcMain.handle('results:rescore', async () => {
  if (!resultsState) return null;
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
    if (!top.length) return { ok: false, error: 'Pick a build (Build & stats) so the app knows which stats matter on this slot.' };
    const q = trade.buildCraftQuery(item, { ...opts, top });
    trade.applyBudget(q.body, budget);
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
  if (mode === 'upgrade') mode = store.settings.build === 'off' || /unique/i.test(item.rarity || '') ? 'similar' : 'gear';
  if (mode === 'pob') {
    try {
      const r = await pobSearch(item, pobSlot, league, budget, opts);
      if (r) return { ...base, ...r };
    } catch (err) { log('pob search: ' + (err.stack || err)); }
    mode = store.settings.build === 'off' || /unique/i.test(item.rarity || '') ? 'similar' : 'gear'; // fall back
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
        trade.applyBudget(q.body, budget);
        r = await runSearch(league, q.body, `gear L${level}${size ? ` size${size}` : ''}`);
        if (!(r && r.tooComplex) || size >= SIZES.length - 1) break;
        size++; shrunk = true;
        store.setSetting('gearSearchSize', { ...(store.settings.gearSearchSize || {}), [sizeKey]: Math.max(size, (store.settings.gearSearchSize || {})[sizeKey] || 0) });
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
      return { ok: false, error: `None of your stat weights are on this ${item.itemClass ? item.itemClass.toLowerCase().replace(/s$/, '') : 'item'}, so "By my weights" would match almost anything. Use Better for my build, or set weights for its stats (Build & stats).` };
    }
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
  // the search itself failed (only a pre-filled link came back): open that rather than saying "nothing listed"
  if (r.total == null) { if (r.url) shell.openExternal(r.url); return { ok: true, mode: 'price', total: null, league, item: item.name, url: r.url, opened: true, levelLabel: q.levelLabel }; }
  if (!r.total) return { ok: true, mode: 'price', total: 0, league, item: item.name, url: r.url, levelLabel: q.levelLabel };
  const ctx = { item, mode: 'price', title: `Price check: ${item.name}`, body: q.body, searchKey: searchKey(q.body),
    note: `Listings like this one (${q.levelLabel}, ${q.need} of ${q.total} stats), cheapest first.` };
  const shown = r.ids && r.ids.length ? await showResults(r, ctx) : false;
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

// keep notifications alive until they're used, or Windows may drop their click handlers
const liveNotes = new Set();
function keepNotification(n) {
  liveNotes.add(n);
  const done = () => liveNotes.delete(n);
  n.on('close', done); n.on('click', () => setTimeout(done, 1000));
  setTimeout(done, 10 * 60000);
}
async function runAlerts(force) {
  const every = Number(store.settings.alertEvery) || 0;
  if (alertsRunning || (!force && (!every || Date.now() - lastAlertRun < every * 60000))) return;
  const list = savedList().filter((x) => x.alert);
  if (!list.length) return;
  alertsRunning = true; lastAlertRun = Date.now();
  try {
    await refreshDivineRate(false);
    for (const s of list) {
      if (searchWait() > 0 || searchLog.filter((t) => Date.now() - t < 60000).length > 6) { log('alerts: leaving the searches to you for now'); break; }
      const r = await runSearch(s.league, JSON.parse(JSON.stringify(s.body)), `alert ${s.name}`, { maxWait: 0 });
      if (!r.ok) { log(`alert ${s.name}: ${r.error}`); if (r.rateLimited) break; continue; }
      if (!Array.isArray(r.ids)) { log(`alert ${s.name}: the trade site search couldn't be read in the app`); continue; }
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
          keepNotification(n);
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
      await Promise.race([tradeWin.loadURL(`${trade.BASE}/trade2`), new Promise((_, rej) => setTimeout(() => rej(new Error('page load timed out')), 15000))]);
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
  return trade.prefilledUrl(st.r.league, body);
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
  if (!l || !l.hideoutToken) return { ok: false, error: 'This listing has no hideout token – use Buy on trade site.' };
  if (!(await signedIn())) return { ok: false, needSignIn: true, error: 'Sign in to pathofexile.com first – it only takes you to hideouts for a signed-in account.' };
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
    fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=PoE2 Upgrade Checker\nExec=${exec}\nX-GNOME-Autostart-enabled=true\nTerminal=false\n`);
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
    title: 'PoE2 Upgrade Checker', icon: ICON, autoHideMenuBar: true,
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
const upd = { state: 'idle', version: null, error: null, progress: null, checked: null };
let autoUpdater = null;
// the installed app and the AppImage update themselves; the portable .exe and other Linux builds don't
function updaterAvailable() { return app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR && (process.platform !== 'linux' || !!process.env.APPIMAGE); }
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
      keepNotification(n);
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
    { label: hotkeyStatus.ok ? `Hotkey: ${hotkeyStatus.accelerator}` : 'Hotkey not set (see Settings)', enabled: false },
    { label: `Character: ${(store.listProfiles().find((p) => p.active) || {}).name || '—'}`, enabled: false },
    { label: `Show / hide results${resultsHotkey ? ` (${resultsHotkey})` : ''}`, click: toggleResults, enabled: !!resultsState },
    ...(upd.state === 'ready' ? [{ label: `Restart to update to ${upd.version}`, click: () => autoUpdater && autoUpdater.quitAndInstall(true, true) }] : []),
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
  pobSync(); // the engine itself starts on first use
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
  setupUpdater();
  const hidden = process.argv.includes('--hidden') || store.settings.openSettingsOnStart === false;
  if (!hidden) openSettings();
});

app.on('window-all-closed', (e) => { /* keep running in the tray */ });
app.on('will-quit', () => { globalShortcut.unregisterAll(); if (keys) keys.stop(); if (pobEng) pobEng.kill(); });
