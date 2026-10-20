'use strict';

// Builds official PoE2 trade-site searches from an item + the stats you choose.
// Pure functions only; the network calls live in main.js.
//
// Trade data endpoints (public, no login):
//   GET  https://www.pathofexile.com/api/trade2/data/stats
//   GET  https://www.pathofexile.com/api/trade2/data/filters
//   GET  https://www.pathofexile.com/api/trade2/data/leagues
//   POST https://www.pathofexile.com/api/trade2/search/poe2/<league>  -> { id }
//   results page: https://www.pathofexile.com/trade2/search/poe2/<league>/<id>

const BASE = 'https://www.pathofexile.com';
const { expand } = require('./parser');
const ignoreLib = require('./ignore');

// Listing status. 'available' = Instant Buyout and In Person (what the trade
// site shows by default). 'online' alone leaves out merchant (instant buyout)
// listings, which are most of the market.
const STATUSES = ['available', 'securable', 'online', 'any'];
function statusOpt(s) { return STATUSES.includes(s) ? s : 'available'; }

// "[Base]" / "[Weapon]" stats map to the trade site's equipment filters.
const EQUIPMENT_FILTERS = {
  '[Base] Armour': 'ar',
  '[Base] Evasion Rating': 'ev',
  '[Base] Energy Shield': 'es',
  '[Base] Block Chance': 'block',
  '[Base] Spirit': 'spirit',
  '[Base] Runic Ward': 'ward',
  '[Weapon] Total DPS': 'dps',
  '[Weapon] Physical DPS': 'pdps',
  '[Weapon] Elemental DPS': 'edps',
  '[Weapon] Attacks per Second': 'aps',
  '[Weapon] Critical Hit Chance': 'crit',
};

// Fallback category ids if the filters endpoint can't be read.
const CATEGORY_FALLBACK = {
  'helmets': 'armour.helmet', 'body armours': 'armour.chest', 'gloves': 'armour.gloves',
  'boots': 'armour.boots', 'shields': 'armour.shield', 'foci': 'armour.focus',
  'bucklers': 'armour.buckler', 'quivers': 'armour.quiver', 'rings': 'accessory.ring',
  'amulets': 'accessory.amulet', 'belts': 'accessory.belt',
  'jewels': 'jewel', 'charms': 'flask.charm', 'life flasks': 'flask.life', 'mana flasks': 'flask.mana',
};

const { norm } = require('./statnorm');

// statsData: response of /api/trade2/data/stats ({ result: [{ id, label, entries: [{id,text,type}] }] })
function buildStatIndex(statsData) {
  const index = new Map(); // normText -> [{ id, text, type, local }]
  const all = [];
  for (const group of (statsData && statsData.result) || []) {
    for (const e of group.entries || []) {
      const type = e.type || group.id || '';
      const entry = { id: e.id, text: e.text, type, local: /\(local\)/i.test(e.text) };
      all.push(entry);
      const k = norm(e.text);
      if (!index.has(k)) index.set(k, []);
      index.get(k).push(entry);
    }
  }
  return { index, all };
}

const TYPE_PREF = ['pseudo', 'explicit', 'implicit', 'augment', 'rune', 'enchant', 'crafted', 'desecrated', 'fractured'];

// Find the best trade stat id for one of our stat keys.
function matchStat(key, statIndex, opts) {
  opts = opts || {};
  if (EQUIPMENT_FILTERS[key]) return { kind: 'equipment', id: EQUIPMENT_FILTERS[key], text: key };
  let cands = statIndex.index.get(norm(key));
  if (!cands || !cands.length) return null;
  if (opts.type) {
    // Only stats of one kind (e.g. 'implicit'), or explicit-style ones without pseudo.
    const want = opts.type;
    const same = cands.filter((c) => c.type === want);
    cands = same.length ? same : cands.filter((c) => c.type === 'explicit');
    if (!cands.length) return null;
  }
  const sorted = cands.slice().sort((a, b) => {
    // armour/weapon pieces: local version of a mod first
    if (opts.preferLocal && a.local !== b.local) return a.local ? -1 : 1;
    if (!opts.preferLocal && a.local !== b.local) return a.local ? 1 : -1;
    const ia = TYPE_PREF.indexOf(a.type); const ib = TYPE_PREF.indexOf(b.type);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const best = sorted[0];
  return { kind: 'stat', id: best.id, text: best.text, type: best.type };
}

// 'exclude' rules: listings that have any of these stats are left out.
function addExcludeGroup(query, rules, statIndex) {
  const ids = [];
  for (const key of ignoreLib.excludedKeys(rules)) {
    const m = matchStat(key, statIndex, {});
    if (m && m.kind === 'stat' && !ids.includes(m.id)) ids.push(m.id);
  }
  if (ids.length) query.stats.push({ type: 'not', filters: ids.map((id) => ({ id, disabled: false })) });
  return ids.length;
}

function singular(cls) {
  const c = String(cls || '').toLowerCase().trim();
  if (c === 'foci') return 'focus';
  if (c.endsWith('staves')) return c.replace(/staves$/, 'staff');
  if (c.endsWith('ies')) return c.replace(/ies$/, 'y');
  if (c.endsWith('s')) return c.slice(0, -1);
  return c;
}

// filtersData: response of /api/trade2/data/filters
function categoryFor(itemClass, filtersData) {
  const want = singular(itemClass);
  for (const group of (filtersData && filtersData.result) || []) {
    for (const f of group.filters || []) {
      if (f.id !== 'category') continue;
      const opts = (f.option && f.option.options) || [];
      const hit = opts.find((o) => o.id && String(o.text || '').toLowerCase() === want);
      if (hit) return hit.id;
    }
  }
  return CATEGORY_FALLBACK[String(itemClass || '').toLowerCase()] || null;
}

// picks: [{ key, min, max }] - our stat keys with the values you want
// opts: { itemClass, baseType, matchBase, onlineOnly, statIndex, filtersData, preferLocal }
function buildQuery(picks, opts) {
  const statFilters = [];
  const equipment = {};
  const unmatched = [];
  for (const p of picks) {
    let m = p.id ? { kind: 'stat', id: p.id, type: p.idType } : matchStat(p.key, opts.statIndex, { preferLocal: opts.preferLocal });
    if (!p.id && m && m.kind === 'stat' && m.type !== 'pseudo' && p.source) {
      const type = p.source === 'implicit' ? 'implicit' : p.source === 'socket' ? 'augment' : 'explicit';
      m = matchStat(p.key, opts.statIndex, { preferLocal: opts.preferLocal, type }) || m;
    }
    if (!m) { unmatched.push(p.key); continue; }
    const value = {};
    if (p.min !== '' && p.min != null && Number.isFinite(Number(p.min))) value.min = Number(p.min);
    if (p.max !== '' && p.max != null && Number.isFinite(Number(p.max))) value.max = Number(p.max);
    if (m.kind === 'equipment') equipment[m.id] = value;
    else statFilters.push({ id: m.id, value, disabled: false });
  }

  const filters = {};
  if (!opts.matchBase) {
    const cat = categoryFor(opts.itemClass, opts.filtersData);
    if (cat) filters.type_filters = { filters: { category: { option: cat } } };
  }
  if (Object.keys(equipment).length) filters.equipment_filters = { filters: equipment };

  const query = {
    status: { option: statusOpt(opts.status) },
    stats: [{ type: 'and', filters: statFilters }],
    filters,
  };
  if (opts.matchBase && opts.baseType) query.type = opts.baseType;
  if (!statFilters.length) query.stats = [];
  const excluded = addExcludeGroup(query, opts.ignoreRules, opts.statIndex);

  return { body: { query, sort: { price: 'asc' } }, unmatched, excluded };
}

// One-click "find upgrades": uses the trade site's weighted-sum stat group so it
// finds items whose weighted stats beat your current item, using YOUR weights.
// [Weapon] DPS stats become a min DPS filter; [Base] defences are left out
// (they depend on the base type), so you check those in the results.
function buildUpgradeQuery(item, weights, opts) {
  // Leave rune/enchant bonuses out of "your score": a listing usually comes without them.
  const natural = {};
  for (const x of statSources(item)) if (x.source !== 'socket') natural[x.key] = (natural[x.key] || 0) + x.value;
  const weightFilters = [];
  let current = 0;
  const equipment = {};
  const unmatched = [];
  for (const [key, w] of Object.entries(weights)) {
    if (!w || ignoreLib.isIgnored(opts.ignoreRules, key)) continue;
    if (EQUIPMENT_FILTERS[key]) {
      if (key.startsWith('[Weapon]') && item.stats[key] && w > 0) {
        equipment[EQUIPMENT_FILTERS[key]] = { min: Math.floor(item.stats[key]) };
      }
      continue;
    }
    const m = matchStat(key, opts.statIndex, { preferLocal: opts.preferLocal });
    if (!m) { if (item.stats[key]) unmatched.push(key); continue; }
    weightFilters.push({ id: m.id, value: { weight: w }, disabled: false });
    current += (natural[key] || 0) * w;
  }
  const filters = {};
  const cat = categoryFor(opts.itemClass || item.itemClass, opts.filtersData);
  if (cat) filters.type_filters = { filters: { category: { option: cat } } };
  if (Object.keys(equipment).length) filters.equipment_filters = { filters: equipment };
  const groupMin = Math.floor(current * (1 + (opts.minGainPct || 0) / 100)) + 1;
  const query = {
    status: { option: statusOpt(opts.status) },
    stats: weightFilters.length ? [{ type: 'weight', value: { min: groupMin }, filters: weightFilters }] : [],
    filters,
  };
  const excluded = addExcludeGroup(query, opts.ignoreRules, opts.statIndex);
  return { body: { query, sort: { 'statgroup.0': 'desc' } }, unmatched, currentScore: current, groupMin, excluded };
}

// Budget: { max, currency: 'divine'|'exalted'|'chaos', divineRate? }
// - If currency is divine and you give a divine->exalted rate, the max is turned
//   into "exalted orb equivalent", so listings priced in exalts are included too.
// - Otherwise only listings priced in that currency are matched.
const CURRENCIES = { divine: 'Divine Orb', exalted: 'Exalted Orb', chaos: 'Chaos Orb' };

// Splits an item's stats by where they come from, using the saved mod lines:
// [{ key, value, source }] where source is 'mod' (explicit/crafted/fractured/
// desecrated...), 'implicit', or 'socket' (runes / enchants - a buyer can add
// those themselves, so they're left out of "same stats" searches).
const SOCKET_TAGS = ['rune', 'enchant'];
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
  for (const [key, value] of Object.entries(item.stats || {})) if (key.startsWith('[')) put(key, value, 'base');
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
    const m = matchStat(key, opts.statIndex, { preferLocal: opts.preferLocal });
    if (!m) { unmatched.push(key); continue; }
    if (m.type === 'pseudo') { pseudoTotals.set(m.id, (pseudoTotals.get(m.id) || 0) + value); continue; }
    const typed = matchStat(key, opts.statIndex, { preferLocal: opts.preferLocal, type: source === 'implicit' ? 'implicit' : 'explicit' }) || m;
    const existing = filters.find((f) => f.id === typed.id);
    if (existing) { existing._v += value; continue; }
    filters.push({ id: typed.id, _v: value });
  }
  for (const [id, v] of pseudoTotals) filters.push({ id, _v: v });
  const round = (x) => Math.round(x * 100) / 100;
  const statFilters = filters.map((f) => {
    const v = {};
    if (f._v > 0) v.min = round(f._v >= 3 ? Math.floor(f._v * level.tol) : f._v * level.tol);
    else if (f._v < 0) v.max = round(f._v * level.tol);
    // tiny values like "+1 to Level of all Skills" must not round down to 0
    if (v.min != null && f._v >= 1 && v.min < 1) v.min = 1;
    return { id: f.id, value: v, disabled: false };
  });

  const n = statFilters.length;
  const lastLevel = (opts.level || 0) >= RELAX.length - 1;
  let need = Math.max(1, n - level.drop(n));
  if (unique && lastLevel) need = 0; // last try for a unique: just the name
  const qf = {};
  if (!unique) {
    const cat = categoryFor(item.itemClass, opts.filtersData);
    if (cat) qf.type_filters = { filters: { category: { option: cat } } };
  }
  if (Object.keys(equipment).length) qf.equipment_filters = { filters: equipment };
  const query = {
    status: { option: statusOpt(opts.status) },
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
    const m = matchStat(t.key, opts.statIndex, { preferLocal: opts.preferLocal });
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
function num(v) { const n = Number(v); return v !== '' && v != null && Number.isFinite(n) && n > 0 ? n : null; }

function priceFilter(budget) {
  if (!budget) return null;
  let min = num(budget.min);
  let max = num(budget.max);
  if (min == null && max == null) return null;
  if (min != null && max != null && min > max) [min, max] = [max, min];
  const currency = CURRENCIES[budget.currency] ? budget.currency : 'divine';
  const rate = Number(budget.divineRate);
  const out = {};
  if (currency === 'divine' && Number.isFinite(rate) && rate > 0) {
    // no option = exalted orb equivalent, so every listing currency counts
    if (min != null) out.min = Math.ceil(min * rate);
    if (max != null) out.max = Math.floor(max * rate);
    return out;
  }
  if (min != null) out.min = min;
  if (max != null) out.max = max;
  if (currency !== 'exalted') out.option = currency; // exalted = equivalent already
  return out;
}

function applyBudget(body, budget) {
  const price = priceFilter(budget);
  if (!price) return body;
  body.query.filters = body.query.filters || {};
  body.query.filters.trade_filters = { filters: { price } };
  return body;
}

function budgetLabel(budget) {
  const price = priceFilter(budget);
  if (!price) return null;
  const name = { divine: 'div', exalted: 'ex', chaos: 'chaos' }[budget.currency] || 'div';
  let min = num(budget.min); let max = num(budget.max);
  if (min != null && max != null && min > max) [min, max] = [max, min];
  const range = min != null && max != null ? `${min}–${max} ${name}` : max != null ? `≤ ${max} ${name}` : `≥ ${min} ${name}`;
  return range + (price.option ? ` (${name} listings only)` : '');
}

function searchUrl(league) {
  return `${BASE}/api/trade2/search/poe2/${encodeURIComponent(league)}`;
}
function resultsUrl(league, id) {
  return `${BASE}/trade2/search/poe2/${encodeURIComponent(league)}/${encodeURIComponent(id)}`;
}
// Fallback if the POST fails: the site also accepts the query in the URL.
function prefilledUrl(league, body) {
  return `${BASE}/trade2/search/poe2/${encodeURIComponent(league)}?q=${encodeURIComponent(JSON.stringify(body))}`;
}

module.exports = {
  BASE, EQUIPMENT_FILTERS, CURRENCIES, priceFilter, applyBudget, budgetLabel, norm, buildStatIndex, matchStat, categoryFor, buildQuery, buildUpgradeQuery, buildSimilarQuery, buildCraftQuery, statSources, baseWithoutSockets, RELAX, STATUSES, statusOpt,
  searchUrl, resultsUrl, prefilledUrl,
};
