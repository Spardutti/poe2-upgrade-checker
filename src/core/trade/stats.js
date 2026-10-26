'use strict';

// Matching our stat names to the trade site's stats, and items to its categories and equipment filters.

const BASE = 'https://www.pathofexile.com';
const ignoreLib = require('../ignore');

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
  '[Base] Ward': 'ward', // PoE1
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
  'bows': 'weapon.bow', 'crossbows': 'weapon.crossbow', 'talismans': 'weapon.talisman', 'quarterstaves': 'weapon.warstaff',
  'staves': 'weapon.staff', 'two hand swords': 'weapon.twosword', 'two hand axes': 'weapon.twoaxe', 'two hand maces': 'weapon.twomace',
  'one hand swords': 'weapon.onesword', 'spears': 'weapon.spear', 'flails': 'weapon.flail', 'one hand axes': 'weapon.oneaxe',
  'one hand maces': 'weapon.onemace', 'sceptres': 'weapon.sceptre', 'wands': 'weapon.wand', 'daggers': 'weapon.dagger', 'claws': 'weapon.claw',
  // PoE1
  'thrusting one hand swords': 'weapon.onesword', 'rune daggers': 'weapon.runedagger', 'warstaves': 'weapon.warstaff',
  'abyss jewels': 'jewel.abyss', 'hybrid flasks': 'flask', 'utility flasks': 'flask', 'fishing rods': 'weapon.rod',
};
// the sites name some categories differently from the item class: "One-Handed Sword", "Base Dagger"
const catText = (t) => String(t || '').toLowerCase().replace(/-handed\b/g, ' hand').replace(/^(base|thrusting) /, '').replace(/\s+/g, ' ').trim();

const { norm } = require('../statnorm');
const COND = /\b(if you've|if you have|while|when|recently)\b|\bper (?!second)/i; // same as gearscore.COND

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

// Which "(Local)" stats really are local depends on the item: on weapons the attack stats
// (accuracy, attack speed, crit, added damage, culling strike) apply to the weapon itself; on
// armour pieces, shields and foci the defence stats (armour, evasion, ES, ward, block) do. On
// anything else (gloves accuracy/attack speed, quivers, jewellery) the mod is global.
const ARMOUR_CLASSES = ['helmets', 'body armours', 'gloves', 'boots', 'shields', 'foci', 'bucklers'];
const WEAPON_CLASS = /\b(mace|sword|axe|bow|crossbow|quarterstaff|quarterstaves|staff|staves|warstaff|warstaves|wand|sceptre|spear|flail|dagger|claw|talisman)s?\b/i;
const WEAPON_LOCAL = /Accuracy Rating|Attack Speed|Critical (Hit|Strike) Chance|Culling Strike|^Adds # to # \w+ Damage$|Physical Damage$|Reload Time/i;
const DEFENCE_LOCAL = /Armour|Evasion|Energy Shield|Runic Ward|\bWard\b|Block/i;
function itemKind(itemClass) {
  const c = String(itemClass || '').toLowerCase().trim();
  if (!c) return null;
  if (ARMOUR_CLASSES.includes(c)) return 'armour';
  if (c === 'quivers') return 'other';
  if (WEAPON_CLASS.test(c)) return 'weapon';
  return 'other';
}
// opts.preferLocal (the caller's "this is an armour/weapon piece") refined by the item class
function localFor(key, itemClass, preferLocal) {
  if (!preferLocal) return false;
  const kind = itemKind(itemClass);
  if (!kind) return true; // class unknown: keep the caller's choice
  if (kind === 'weapon') return WEAPON_LOCAL.test(key);
  if (kind === 'armour') return DEFENCE_LOCAL.test(key) && !/Recharge|Allies|Minion/i.test(key);
  return false;
}

// Stats where a smaller (or negative) value is the better one.
const LOWER_BETTER = /Attribute Requirements|Mana Cost|Life Cost|Cost of Skills|Charges? (used|consumed)|Reservation(?! Efficiency)|Reload Time/i;

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
  const cls = String(itemClass || '').toLowerCase();
  // PoE1 classes with no category of their own: abyss jewels have one, hybrid/utility flasks don't
  const special = { 'abyss jewels': 'jewel.abyss', 'rune daggers': 'weapon.runedagger', 'warstaves': 'weapon.warstaff' }[cls];
  for (const group of (filtersData && filtersData.result) || []) {
    for (const f of group.filters || []) {
      if (f.id !== 'category') continue;
      const opts = (f.option && f.option.options) || [];
      if (special && opts.some((o) => o.id === special)) return special;
      const hit = opts.find((o) => o.id && String(o.text || '').toLowerCase() === want)
        || opts.find((o) => o.id && catText(o.text) === catText(want));
      if (hit) return hit.id;
      if (/flasks$/.test(cls) && opts.some((o) => o.id === 'flask')) return 'flask';
    }
  }
  return CATEGORY_FALLBACK[cls] || null;
}

module.exports = { BASE, STATUSES, statusOpt, EQUIPMENT_FILTERS, COND, buildStatIndex, matchStat, localFor, LOWER_BETTER, addExcludeGroup, categoryFor };
