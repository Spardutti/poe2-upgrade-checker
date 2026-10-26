'use strict';

// An item's own stats (with what sockets add), and searches for items like it or craftable bases.

const { expand } = require('../parser');
const ignoreLib = require('../ignore');
const { statusOpt, EQUIPMENT_FILTERS, matchStat, localFor, LOWER_BETTER, addExcludeGroup, categoryFor } = require('./stats');

const CURRENCIES = { divine: 'Divine Orb', exalted: 'Exalted Orb', chaos: 'Chaos Orb' };

// Splits an item's stats by where they come from, using the saved mod lines:
// [{ key, value, source }] where source is 'mod' (explicit/crafted/fractured/
// desecrated...), 'implicit', or 'socket' (runes / enchants - a buyer can add
// those themselves, so they're left out of "same stats" searches).
// PoE1 bench crafts too: they're on their own trade ids (crafted.*), and the buyer can craft them
const SOCKET_TAGS = ['rune', 'enchant', 'crafted'];
function statSources(item) {
  const lines = (item && item.lines) || [];
  if (!lines.some((l) => l.key)) {
    return Object.entries((item && item.stats) || {}).map(([key, value]) => ({ key, value, source: key.startsWith('[') ? 'base' : 'mod' }));
  }
  const acc = new Map();
  const put = (key, value, source) => {
    const k = key + '|' + source;
    const cur = acc.get(k) || { key, value: 0, source };
    cur.value += value; acc.set(k, cur);
  };
  for (const l of lines) {
    if (!l.key || l.value == null || l.tag === 'base' || l.tag === 'info') continue;
    const source = SOCKET_TAGS.includes(l.tag) ? 'socket' : l.tag === 'implicit' ? 'implicit' : 'mod';
    for (const [k, v] of expand(l.key, l.value)) put(k, v, source);
  }
  // stats with no mod line of their own (Mageblood's Legacies): count them as mods
  const fromLines = new Map();
  for (const x of acc.values()) fromLines.set(x.key, (fromLines.get(x.key) || 0) + x.value);
  for (const [key, value] of Object.entries(item.stats || {})) {
    if (key.startsWith('[')) { put(key, value, 'base'); continue; }
    const rest = value - (fromLines.get(key) || 0);
    if (Math.abs(rest) > 0.01) put(key, rest, 'mod');
  }
  return Array.from(acc.values()).map((x) => ({ ...x, value: Math.round(x.value * 100) / 100 }));
}

// Local "% increased <defence>" mods that scale an armour piece's base value.
const DEFENCE_WORDS = { '[Base] Armour': /Armour/i, '[Base] Evasion Rating': /Evasion/i, '[Base] Energy Shield': /Energy Shield/i, '[Base] Spirit': /Spirit/i };

// Your base Armour/Evasion/ES/Spirit WITHOUT the rune bonus: runes add to the
// "% increased" total, so a listing without the same runes shows less.
function baseWithoutSockets(key, value, sources) {
  const word = DEFENCE_WORDS[key];
  if (!word) return value;
  let mods = 0; let sockets = 0;
  for (const x of sources) {
    if (x.source === 'base' || !/^#% increased /.test(x.key) || !word.test(x.key) || /maximum|Recharge|Rate|Allies|Minion/i.test(x.key)) continue;
    if (x.source === 'socket') sockets += x.value; else mods += x.value;
  }
  if (!sockets) return value;
  return value * (100 + mods) / (100 + mods + sockets);
}

// Looseness levels used when a search finds nothing. tol = share of your
// values a listing needs; drop = how many of your stats it may be missing.
const RELAX = [
  { tol: 1.0, drop: (n) => (n >= 4 ? 1 : 0), label: 'your values or higher' },
  { tol: 0.9, drop: (n) => (n >= 4 ? 2 : n >= 2 ? 1 : 0), label: '90% of your values' },
  { tol: 0.8, drop: (n) => Math.max(n >= 2 ? 1 : 0, Math.ceil(n / 3)), label: '80% of your values' },
  { tol: 0.65, drop: (n) => Math.max(n >= 2 ? 1 : 0, Math.ceil(n / 2)), label: '65% of your values' },
];

// "Same stats or better": every mod on your item becomes a filter with your
// value as the minimum, inside a COUNT group so a listing may miss some of them.
// Base Armour/Evasion/ES/Spirit become minimums (rune bonus removed, 90%).
// Uniques are searched by name. opts.level picks a RELAX level (default 0).
function buildSimilarQuery(item, opts) {
  opts = opts || {};
  const level = RELAX[Math.max(0, Math.min(RELAX.length - 1, opts.level || 0))];
  const unique = /unique/i.test(item.rarity || '');
  const filters = [];
  const equipment = {};
  const unmatched = [];
  const skipped = [];
  const ignored = [];
  const sources = statSources(item);
  const pseudoTotals = new Map(); // pseudo id -> value from mods + implicits

  for (const { key, value, source } of sources) {
    if (ignoreLib.isIgnored(opts.ignoreRules, key)) { if (!ignored.includes(key)) ignored.push(key); continue; }
    if (source === 'base') {
      if (!EQUIPMENT_FILTERS[key] || unique) continue;
      if (/Attacks per Second|Critical Hit Chance|Physical DPS|Elemental DPS|Chaos DPS|Runic Ward|Block/.test(key)) continue;
      const v = baseWithoutSockets(key, value, sources);
      if (v > 0) equipment[EQUIPMENT_FILTERS[key]] = { min: Math.floor(v * 0.9 * level.tol) };
      continue;
    }
    if (source === 'socket') { skipped.push(key); continue; }
    const preferLocal = localFor(key, item.itemClass, opts.preferLocal);
    const m = matchStat(key, opts.statIndex, { preferLocal });
    if (!m) { unmatched.push(key); continue; }
    if (m.type === 'pseudo') { pseudoTotals.set(m.id, (pseudoTotals.get(m.id) || 0) + value); continue; }
    const typed = matchStat(key, opts.statIndex, { preferLocal, type: source === 'implicit' ? 'implicit' : 'explicit' }) || m;
    const existing = filters.find((f) => f.id === typed.id);
    if (existing) { existing._v += value; continue; }
    filters.push({ id: typed.id, _v: value, key });
  }
  for (const [id, v] of pseudoTotals) filters.push({ id, _v: v, key: id });
  const round = (x) => Math.round(x * 100) / 100;
  // A downside (-10% to Chaos Resistance, +attribute requirements) isn't something a better item
  // needs to have: only keep a stat in the direction that is good for it.
  const wanted = filters.filter((f) => (LOWER_BETTER.test(f.key) ? f._v < 0 : f._v > 0));
  const statFilters = wanted.map((f) => {
    const v = {};
    if (f._v > 0) v.min = round(f._v >= 3 ? Math.floor(f._v * level.tol) : f._v * level.tol);
    else if (f._v < 0) v.max = round(f._v * level.tol);
    // tiny values like "+1 to Level of all Skills" must not round down to 0
    if (v.min != null && f._v >= 1 && v.min < 1) v.min = 1;
    return { id: f.id, value: v, disabled: false };
  });

  const n = statFilters.length;
  const lastLevel = (opts.level || 0) >= RELAX.length - 1;
  // a price check compares like with like: every stat at first, then at most one missing
  // (a looser match is a different, usually cheaper item)
  const drop = opts.forPrice ? Math.min(1, (opts.level || 0) === 0 ? 0 : level.drop(n)) : level.drop(n);
  let need = Math.max(1, n - drop);
  if (unique && lastLevel) need = 0; // last try for a unique: just the name
  const qf = {};
  if (!unique) {
    const cat = categoryFor(item.itemClass, opts.filtersData);
    if (cat) qf.type_filters = { filters: { category: { option: cat } } };
  }
  if (Object.keys(equipment).length) qf.equipment_filters = { filters: equipment };
  if (opts.forPrice) {
    // same rarity (a magic or normal base isn't priced like a rare) and the same corruption state
    const rar = String(item.rarity || '').toLowerCase();
    if (!unique && ['rare', 'magic', 'normal'].includes(rar)) {
      qf.type_filters = qf.type_filters || { filters: {} };
      qf.type_filters.filters.rarity = { option: rar };
    }
    qf.misc_filters = { filters: { corrupted: { option: item.corrupted ? 'true' : 'false' } } };
    if (opts.game === 'poe1') {
      // what moves a PoE1 price most: links, influences, fractured and synthesised bases
      if (item.links >= 5) qf.socket_filters = { filters: { links: { min: item.links } } };
      for (const inf of item.influences || []) {
        const id = `${String(inf).toLowerCase()}_item`;
        if (/^(shaper|elder|crusader|redeemer|hunter|warlord)_item$/.test(id)) qf.misc_filters.filters[id] = { option: 'true' };
      }
      if (item.fractured) qf.misc_filters.filters.fractured_item = { option: 'true' };
      if (item.synthesised) qf.misc_filters.filters.synthesised_item = { option: 'true' };
    }
  }
  const query = {
    status: { option: opts.forPrice ? 'available' : statusOpt(opts.status) },
    stats: n && need > 0 ? [{ type: 'count', value: { min: need }, filters: statFilters }] : [],
    filters: qf,
  };
  if (unique) {
    if (item.name) query.name = item.name;
    if (item.baseType && item.baseType !== item.name) query.type = item.baseType;
  }
  const excluded = addExcludeGroup(query, opts.ignoreRules, opts.statIndex);
  return {
    body: { query, sort: { price: 'asc' } }, unmatched, skipped, ignored, excluded, need, total: n,
    level: opts.level || 0, levels: RELAX.length, levelLabel: level.label, unique,
  };
}

// "Craftable bases": rare, uncorrupted items of the same kind that already
// have your slot's key stats (opts.top: [{ key, cap }]) at a decent roll,
// with at least one open prefix or suffix you can craft into.
function buildCraftQuery(item, opts) {
  opts = opts || {};
  const filters = [];
  const unmatched = [];
  for (const t of opts.top || []) {
    const m = matchStat(t.key, opts.statIndex, { preferLocal: localFor(t.key, item.itemClass, opts.preferLocal) });
    if (!m || m.kind !== 'stat') { unmatched.push(t.key); continue; }
    const min = t.cap >= 5 ? Math.floor(t.cap * 0.55) : Math.max(1, Math.floor(t.cap * 0.5));
    filters.push({ id: m.id, value: { min }, disabled: false });
  }
  const empty = ['# Empty Prefix Modifiers', '# Empty Suffix Modifiers']
    .map((k) => matchStat(k, opts.statIndex, {})).filter((m) => m && m.kind === 'stat')
    .map((m) => ({ id: m.id, value: { min: 1 }, disabled: false }));
  const stats = [];
  if (filters.length) stats.push({ type: 'and', filters });
  if (empty.length) stats.push({ type: 'count', value: { min: 1 }, filters: empty });
  const qf = { type_filters: { filters: { rarity: { option: 'rare' } } }, misc_filters: { filters: { corrupted: { option: 'false' } } } };
  const cat = categoryFor(item.itemClass, opts.filtersData);
  if (cat) qf.type_filters.filters.category = { option: cat };
  // keep the base at least ~90% as good as yours (without your runes)
  const eq = {};
  for (const x of statSources(item)) {
    if (x.source !== 'base' || !EQUIPMENT_FILTERS[x.key] || /Weapon|Runic|Block/.test(x.key)) continue;
    const v = baseWithoutSockets(x.key, x.value, statSources(item));
    if (v > 0) eq[EQUIPMENT_FILTERS[x.key]] = { min: Math.floor(v * 0.9) };
  }
  if (Object.keys(eq).length) qf.equipment_filters = { filters: eq };
  const query = { status: { option: statusOpt(opts.status) }, stats, filters: qf };
  addExcludeGroup(query, opts.ignoreRules, opts.statIndex);
  return { body: { query, sort: { price: 'asc' } }, unmatched, keyStats: (opts.top || []).map((t) => t.label), hasEmptyFilter: empty.length > 0 };
}

// Budget: { min?, max?, currency, divineRate? } - either end can be left empty.

module.exports = { CURRENCIES, statSources, baseWithoutSockets, RELAX, buildSimilarQuery, buildCraftQuery };
