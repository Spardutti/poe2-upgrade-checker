'use strict';

// "What's it worth?" for rare and magic gear: a trade search for items that would sell like this one.
//
// The old search asked for every stat at your value or higher. Only items at least as good on every
// line match that, so the few listings it found were the dearest end of the market (an item priced
// at hundreds of divines when it sells for 20). This one searches the way players price an item, and
// the way PoE Overlay does:
//   - what buyers search for: total elemental resistance, chaos resistance, life, mana, attributes and
//     movement speed as the trade site's own totals; the item's Armour / Evasion / Energy Shield /
//     Spirit, or a weapon's physical and elemental DPS, instead of the mods that make them; then the
//     item's other mods, minus the filler nobody pays for (light radius, stun threshold, thorns...)
//   - a range around each value (90% to 140% at first), so much better items don't set the price
//   - recent listings only (up to 3 days, then a week, then 2 weeks), from sellers who are online:
//     items that have sat unsold for weeks are what didn't sell, not what things sell for
//   - looser in steps until there are enough listings to judge

const trade = require('./trade');

// three steps, each a search: how close the values must be, how many stats may be missing, and how
// recent the listings must be
const LEVELS = [
  { lo: 0.9, hi: 1.4, miss: (n) => (n >= 5 ? 1 : 0), indexed: '3days', label: 'similar values, listed in the last 3 days' },
  { lo: 0.8, hi: 1.8, miss: (n) => (n >= 2 ? 1 : 0), indexed: '1week', label: 'close values, listed in the last week' },
  { lo: 0.75, hi: 2.5, miss: (n) => (n >= 6 ? 2 : n >= 2 ? 1 : 0), indexed: '2weeks', label: 'the main stats, listed in the last 2 weeks' },
];
// the closest search with at least MIN listings is used; a looser one only when the closer ones have
// fewer (looser matches are different, usually cheaper, items). Under ENOUGH sellers the price says so.
const ENOUGH = 5;
const MIN = 3;

// totals the trade site adds up itself (mods and implicits together)
const PSEUDO = [
  { re: /^#% to (Fire|Cold|Lightning) Resistance$/i, id: 'pseudo.pseudo_total_elemental_resistance', label: 'Total elemental resistance' },
  { re: /^#% to Chaos Resistance$/i, id: 'pseudo.pseudo_total_chaos_resistance', label: 'Total chaos resistance' },
  { re: /^# to maximum Life$/i, id: 'pseudo.pseudo_total_life', label: 'Total life' },
  { re: /^# to maximum Mana$/i, id: 'pseudo.pseudo_total_mana', label: 'Total mana' },
  { re: /^# to Strength$/i, id: 'pseudo.pseudo_total_strength', label: 'Total strength' },
  { re: /^# to Dexterity$/i, id: 'pseudo.pseudo_total_dexterity', label: 'Total dexterity' },
  { re: /^# to Intelligence$/i, id: 'pseudo.pseudo_total_intelligence', label: 'Total intelligence' },
  { re: /^#% increased Movement Speed$/i, id: 'pseudo.pseudo_increased_movement_speed', label: 'Movement speed' },
];
// flat Energy Shield off armour (rings, amulets, belts, foci count it in the item's ES on armour)
const PSEUDO_ES = { id: 'pseudo.pseudo_total_energy_shield', label: 'Total energy shield' };
// small totals nobody prices on (a stray +8 strength)
const PSEUDO_MIN = {
  'pseudo.pseudo_total_elemental_resistance': 15, 'pseudo.pseudo_total_chaos_resistance': 7, 'pseudo.pseudo_total_life': 25, 'pseudo.pseudo_total_mana': 25,
  'pseudo.pseudo_total_strength': 15, 'pseudo.pseudo_total_dexterity': 15, 'pseudo.pseudo_total_intelligence': 15, 'pseudo.pseudo_total_energy_shield': 15,
};

// mods that rarely move a price: left out so they don't narrow the search
const FILLER = new RegExp([
  'Light Radius', 'Stun Threshold', 'Stun Recovery', 'Block Recovery', 'Thorns', 'Attribute Requirements', 'Accuracy Rating',
  'Life Regeneration', 'Mana Regeneration', 'Life per second', 'Mana per second', 'Life on Kill', 'Mana on Kill', 'gained on Kill',
  'when you Block', 'Ailment Threshold', 'Freeze Threshold', 'Duration of (Bleeding|Ignite|Poison|Chill|Freeze|Shock)',
  '(Bleeding|Poison|Ignite|Chill|Freeze|Shock) Duration on You', 'Critical (Hit|Strike) Chance against you', '\\bPin\\b', 'Knockback',
  'Charm Charges', 'Flask Charges', 'Flask Effect Duration', 'Rarity of Items', 'Gold', 'reflected',
].join('|'), 'i');

// stats that decide what kind of item it is: never the one a looser search leaves out
// (boots without movement speed, or an amulet without its +skill levels, are different items)
const KEY = /Movement Speed|Level of all .*Skills|Level of all .*Gems|\bSpirit\b|Physical DPS|Elemental DPS|Allies in your Presence deal/i;

const isUnique = (item) => /unique/i.test(item.rarity || '');

// the stats this item is priced on: [{ id, value, label, kind }]
function priceStats(item, opts = {}) {
  const sources = trade.statSources(item);
  const armourOrWeapon = !!opts.preferLocal;
  const totals = new Map();
  const mods = [];
  const add = (id, label, v) => { const t = totals.get(id) || { id, label, value: 0 }; t.value += v; totals.set(id, t); };
  const base = {};
  for (const s of sources) {
    if (s.source === 'base') { base[s.key] = s.value; continue; }
    if (s.source === 'socket') continue; // runes and soul cores: anyone can add them
    const local = trade.localFor(s.key, item.itemClass, armourOrWeapon);
    const p = PSEUDO.find((x) => x.re.test(s.key));
    if (p) { add(p.id, p.label, s.value); continue; }
    if (/^# to maximum Energy Shield$/i.test(s.key) && !local) { add(PSEUDO_ES.id, PSEUDO_ES.label, s.value); continue; }
    if (local) continue; // in the item's defences or DPS, searched as those
    if (s.source === 'implicit') continue; // comes with the base
    if (FILLER.test(s.key) || trade.LOWER_BETTER.test(s.key) || !(s.value > 0)) continue;
    mods.push(s);
  }
  const stats = [];
  for (const t of totals.values()) if (t.value >= (PSEUDO_MIN[t.id] || 1)) stats.push({ id: t.id, value: t.value, label: t.label, kind: 'pseudo' });
  for (const s of mods) {
    const m = trade.matchStat(s.key, opts.statIndex, { preferLocal: false, type: 'explicit' }) || trade.matchStat(s.key, opts.statIndex, {});
    if (!m || m.kind !== 'stat') continue;
    if (stats.some((x) => x.id === m.id)) continue;
    stats.push({ id: m.id, value: s.value, label: s.key, kind: 'mod' });
  }
  // the item's own numbers: defences on armour, DPS on weapons
  const equip = [];
  const defences = [['[Base] Armour', 'ar'], ['[Base] Evasion Rating', 'ev'], ['[Base] Energy Shield', 'es'], ['[Base] Spirit', 'spirit']];
  for (const [k, f] of defences) {
    const v = base[k] != null ? trade.baseWithoutSockets(k, base[k], sources) : 0;
    if (v > 0) equip.push({ f, value: v });
  }
  const pd = base['[Weapon] Physical DPS'] || 0; const ed = base['[Weapon] Elemental DPS'] || 0;
  if (pd + ed > 0) {
    if (pd >= 0.2 * (pd + ed)) equip.push({ f: 'pdps', value: pd });
    if (ed >= 0.2 * (pd + ed)) equip.push({ f: 'edps', value: ed });
  }
  return { stats, equip };
}

const round = (x) => (x >= 10 ? Math.floor(x) : Math.round(x * 10) / 10);

// the search at one level (0..2): { body, need, total, labels, level, levelLabel }
function buildPriceQuery(item, opts = {}) {
  const lv = Math.max(0, Math.min(LEVELS.length - 1, opts.level || 0));
  const L = LEVELS[lv];
  const { stats, equip } = priceStats(item, opts);
  const filters = stats.map((s) => {
    const value = { min: round(s.value * L.lo) };
    if (L.hi) value.max = Math.ceil(s.value * L.hi);
    if (s.value >= 1 && value.min < 1) value.min = 1;
    return { id: s.id, value, disabled: false };
  });
  // key stats must all be there; the rest go in a group where a few may be missing
  const keyF = filters.filter((f, i) => KEY.test(stats[i].label));
  const restF = filters.filter((f, i) => !KEY.test(stats[i].label));
  const n = filters.length;
  const r = restF.length;
  const restNeed = r ? Math.max(keyF.length ? 0 : 1, r - L.miss(n)) : 0;
  const need = keyF.length + restNeed;
  const qf = {};
  const cat = trade.categoryFor(item.itemClass, opts.filtersData);
  qf.type_filters = { filters: {} };
  if (cat) qf.type_filters.filters.category = { option: cat };
  const rar = String(item.rarity || '').toLowerCase();
  if (['rare', 'magic', 'normal'].includes(rar)) qf.type_filters.filters.rarity = { option: rar };
  if (equip.length) {
    const eq = {};
    // the item's defences / DPS decide most of an armour piece's or weapon's price: a range too
    for (const e of equip) { eq[e.f] = { min: Math.floor(e.value * Math.max(L.lo, 0.85)) }; if (L.hi) eq[e.f].max = Math.ceil(e.value * L.hi); }
    qf.equipment_filters = { filters: eq };
  }
  qf.misc_filters = { filters: { corrupted: { option: item.corrupted ? 'true' : 'false' } } };
  if (opts.game === 'poe1') {
    if (item.links >= 5) qf.socket_filters = { filters: { links: { min: item.links } } };
    for (const inf of item.influences || []) {
      const id = `${String(inf).toLowerCase()}_item`;
      if (/^(shaper|elder|crusader|redeemer|hunter|warlord)_item$/.test(id)) qf.misc_filters.filters[id] = { option: 'true' };
    }
    if (item.fractured) qf.misc_filters.filters.fractured_item = { option: 'true' };
    if (item.synthesised) qf.misc_filters.filters.synthesised_item = { option: 'true' };
  }
  qf.trade_filters = { filters: { indexed: { option: L.indexed } } };
  const groups = [];
  if (keyF.length) groups.push({ type: 'and', filters: keyF });
  if (r && restNeed > 0) groups.push({ type: 'count', value: { min: restNeed }, filters: restF });
  const query = { status: { option: 'available' }, stats: groups, filters: qf };
  return {
    body: { query, sort: { price: 'asc' } }, need, total: n, level: lv, levels: LEVELS.length, levelLabel: L.label,
    labels: stats.map((s) => s.label).concat(equip.map((e) => ({ ar: 'Armour', ev: 'Evasion', es: 'Energy Shield', spirit: 'Spirit', pdps: 'Physical DPS', edps: 'Elemental DPS' })[e.f])),
  };
}

// rare / magic gear and jewels get this search; uniques, gems, maps and the rest keep the old one
const usesPriceQuery = (item) => !!item && !isUnique(item) && /^(rare|magic)$/i.test(item.rarity || '');

// ---------- maps, waystones and precursor tablets ----------
// A waystone or map sells on its tier and its numbers (item rarity, pack size, waystone drop chance...),
// not on its monster mods; a tablet on its kind (Expedition, Delirium...), its uses left and its mods.
const MAP_LEVELS = [
  { lo: 0.85, hi: 1.3, indexed: '3days', props: true, label: 'the same tier and similar numbers, listed in the last 3 days' },
  { lo: 0.7, hi: null, indexed: '1week', props: true, label: 'the same tier and close numbers, listed in the last week' },
  { lo: 0, hi: null, indexed: '2weeks', props: false, label: 'the same tier, listed in the last 2 weeks' },
];
// item text property -> trade map filter (PoE2 waystones, PoE1 maps)
const MAP_PROPS = {
  poe2: [[/^Item Rarity:\s*\+?(\d+)%/i, 'map_iir'], [/^(?:Monster )?Pack Size:\s*\+?(\d+)%/i, 'map_packsize'], [/^Waystone Drop Chance:\s*\+?(\d+)%/i, 'map_bonus'],
    [/^Monster Rarity:\s*\+?(\d+)%/i, 'map_rare_monsters'], [/^Monster Effectiveness:\s*\+?(\d+)%/i, 'map_magic_monsters']],
  poe1: [[/^Item Quantity:\s*\+?(\d+)%/i, 'map_iiq'], [/^Item Rarity:\s*\+?(\d+)%/i, 'map_iir'], [/^Monster Pack Size:\s*\+?(\d+)%/i, 'map_packsize']],
};
const isTablet = (item) => !!item && /tablet/i.test(String(item.itemClass || ''));
const isMapLike = (item) => !!item && /^(maps|waystones)$/i.test(String(item.itemClass || '').trim());
const usesMapPriceQuery = (item) => isMapLike(item) || isTablet(item);

function mapTier(item) {
  const raw = String(item.raw || '');
  const m = raw.match(/^(?:Map|Waystone) Tier:\s*(\d+)/im) || String(item.baseType || item.name || '').match(/\(Tier (\d+)\)/i);
  return m ? Number(m[1]) : null;
}
// "Challenger's Expedition Tablet of Knowledge" -> "Expedition Tablet"
const tabletBase = (item) => { const m = `${item.baseType || ''} ${item.name || ''}`.match(/\b([A-Z][a-z]+) Tablet\b/); return m ? `${m[1]} Tablet` : null; };

function buildMapPriceQuery(item, opts = {}) {
  const lv = Math.max(0, Math.min(MAP_LEVELS.length - 1, opts.level || 0));
  const L = MAP_LEVELS[lv];
  const game = opts.game === 'poe1' ? 'poe1' : 'poe2';
  const rar = String(item.rarity || '').toLowerCase();
  const unique = rar === 'unique';
  const qf = { type_filters: { filters: {} }, misc_filters: { filters: { corrupted: { option: item.corrupted ? 'true' : 'false' } } }, trade_filters: { filters: { indexed: { option: L.indexed } } } };
  const cat = isTablet(item) ? 'map.tablet' : game === 'poe2' ? 'map.waystone' : 'map';
  qf.type_filters.filters.category = { option: cat };
  if (['rare', 'magic', 'normal'].includes(rar)) qf.type_filters.filters.rarity = { option: rar };
  const query = { status: { option: 'available' }, stats: [], filters: qf };
  const labels = [];
  if (unique && item.name) { query.name = item.name; if (item.baseType && item.baseType !== item.name) query.type = item.baseType; }
  if (isTablet(item)) {
    const base = tabletBase(item);
    if (base && !unique) { query.type = base; labels.push(base); }
    const raw = String(item.raw || '');
    const uses = (raw.match(/(\d+) uses? remaining/i) || [])[1];
    const filters = [];
    if (uses) filters.push({ id: 'pseudo.pseudo_number_of_uses_remaining', value: { min: Number(uses) }, disabled: false });
    if (L.props && !unique) {
      // its mods, within a range, all of them at first and then most
      const mods = (item.lines || []).filter((l) => l.tag === 'explicit' && l.key && l.value > 0);
      const mf = [];
      for (const l of mods) {
        const m = trade.matchStat(l.key, opts.statIndex, { type: 'explicit' }) || trade.matchStat(l.key, opts.statIndex, {});
        if (!m || m.kind !== 'stat' || mf.some((x) => x.id === m.id)) continue;
        const value = { min: round(l.value * L.lo) || 1 };
        if (L.hi) value.max = Math.ceil(l.value * L.hi);
        mf.push({ id: m.id, value, disabled: false });
        labels.push(l.key);
      }
      if (mf.length) query.stats.push({ type: 'count', value: { min: Math.max(1, mf.length - (lv === 0 ? 0 : Math.ceil(mf.length / 3))) }, filters: mf });
    }
    if (filters.length) { query.stats.unshift({ type: 'and', filters }); labels.push(`${uses} uses`); }
  } else {
    const tier = mapTier(item);
    const mfl = {};
    if (tier) { mfl.map_tier = { min: tier, max: tier }; labels.push(`tier ${tier}`); }
    if (L.props && !unique) {
      const lines = String(item.raw || '').split(/\r?\n/).map((x) => x.trim());
      for (const [re, id] of MAP_PROPS[game]) {
        const line = lines.find((x) => re.test(x));
        const v = line ? Number(line.match(re)[1]) : 0;
        if (!(v > 0)) continue;
        mfl[id] = { min: Math.floor(v * L.lo) };
        if (L.hi) mfl[id].max = Math.ceil(v * L.hi);
        labels.push(line.replace(/\s*\(augmented\)/i, ''));
      }
    }
    if (Object.keys(mfl).length) qf.map_filters = { filters: mfl };
  }
  return { body: { query, sort: { price: 'asc' } }, need: labels.length, total: labels.length, level: lv, levels: MAP_LEVELS.length, levelLabel: L.label, labels };
}

module.exports = { buildPriceQuery, buildMapPriceQuery, priceStats, usesPriceQuery, usesMapPriceQuery, isTablet, LEVELS, MAP_LEVELS, ENOUGH, MIN, FILLER };
