'use strict';

// Parses the text PoE2 puts on the clipboard when you hover an item and press
// Ctrl+C (or Ctrl+Alt+C for the advanced version with mod tiers).
//
// Output:
// {
//   itemClass, rarity, name, baseType, slot, twoHanded,
//   itemLevel, requiredLevel, corrupted, unidentified,
//   stats: { "<template>": number, ... },   // what gets scored
//   lines: [ { text, key, value, tag } ]    // for display
// }

const { slotForClass, isTwoHanded } = require('./slots');

const SEPARATOR = /^-{4,}\s*$/;
const NUM = /[+-]?\d+(?:\.\d+)?/g;
const TAG = /\s*\((implicit|rune|enchant|crafted|fractured|desecrated|augmented|unmet|veiled|mutated)\)\s*$/i;

const SKIP_LINE = [
  /^Requirements:?$/i, /^Requires\b/i, /^Level:/i, /^Str:/i, /^Dex:/i, /^Int:/i,
  /^Item Level:/i, /^Sockets:/i, /^Quality\b/i, /^Corrupted$/i, /^Unidentified$/i,
  /^Mirrored$/i, /^Note:/i, /^Rarity:/i, /^Item Class:/i, /^Stack Size:/i,
  /^Waystone Tier:/i, /^Unmodifiable$/i, /^Sanctified$/i, /^Twice Corrupted$/i,
];

// Base properties shown at the top of armour / weapon / shield items.
const PROPERTY_KEYS = {
  'armour': '[Base] Armour',
  'evasion rating': '[Base] Evasion Rating',
  'energy shield': '[Base] Energy Shield',
  'block chance': '[Base] Block Chance',
  'chance to block': '[Base] Block Chance',
  'spirit': '[Base] Spirit',
  'runic ward': '[Base] Runic Ward',
};

// Mods that really mean several stats at once. Expanded so you only have to
// weight e.g. Fire Resistance once and "all Elemental Resistances" counts too.
const RES = { fire: 'Fire', cold: 'Cold', lightning: 'Lightning', chaos: 'Chaos' };
const ATTR = { strength: 'Strength', dexterity: 'Dexterity', intelligence: 'Intelligence' };

function expand(key, value) {
  if (/^#% to all Elemental Resistances$/i.test(key)) {
    return ['Fire', 'Cold', 'Lightning'].map((e) => [`#% to ${e} Resistance`, value]);
  }
  let m = key.match(/^#% to (Fire|Cold|Lightning|Chaos) and (Fire|Cold|Lightning|Chaos) Resistances$/i);
  if (m) return [m[1], m[2]].map((e) => [`#% to ${RES[e.toLowerCase()]} Resistance`, value]);
  if (/^# to all Attributes$/i.test(key)) {
    return Object.values(ATTR).map((a) => [`# to ${a}`, value]);
  }
  m = key.match(/^# to (Strength|Dexterity|Intelligence) and (Strength|Dexterity|Intelligence)$/i);
  if (m) return [m[1], m[2]].map((a) => [`# to ${ATTR[a.toLowerCase()]}`, value]);
  return [[key, value]];
}

// Turn "+32% to Cold Resistance" into { key: "#% to Cold Resistance", value: 32 }.
function modToStat(text) {
  const nums = text.match(NUM);
  if (!nums) return null;
  let values = nums.map(Number);
  let key = text.replace(NUM, '#').replace(/\s+/g, ' ').trim();

  // "Adds 10 to 20 Fire Damage" -> average of the range
  let value;
  if (values.length === 2 && /# to #/.test(key)) value = (values[0] + values[1]) / 2;
  else value = values[0];

  // Normalise opposite wordings so they net against each other.
  if (/\breduced\b/i.test(key)) { key = key.replace(/\breduced\b/i, 'increased'); value = -Math.abs(value); }
  if (/\bless\b/i.test(key)) { key = key.replace(/\bless\b/i, 'more'); value = -Math.abs(value); }

  return { key, value };
}

function avgRanges(str) {
  // "20-38 (augmented), 5-9" -> sum of the averages of each range
  let total = 0;
  for (const m of str.matchAll(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/g)) {
    total += (Number(m[1]) + Number(m[2])) / 2;
  }
  return total;
}

function parseItem(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\r\n?/g, '\n').trim();
  if (!/^Item Class:/i.test(text)) return null;

  const blocks = [];
  let cur = [];
  for (const line of text.split('\n')) {
    if (SEPARATOR.test(line)) { blocks.push(cur); cur = []; }
    else if (line.trim()) cur.push(line.trim());
  }
  blocks.push(cur);

  const header = blocks[0] || [];
  const item = {
    itemClass: null, rarity: null, name: null, baseType: null,
    slot: null, twoHanded: false, itemLevel: null, requiredLevel: null,
    corrupted: false, unidentified: false, stats: {}, lines: [],
  };

  const names = [];
  for (const line of header) {
    let m;
    if ((m = line.match(/^Item Class:\s*(.+)$/i))) item.itemClass = m[1].trim();
    else if ((m = line.match(/^Rarity:\s*(.+)$/i))) item.rarity = m[1].trim();
    else names.push(line);
  }
  item.name = names[0] || null;
  item.baseType = names[1] || names[0] || null;
  item.slot = slotForClass(item.itemClass);
  item.twoHanded = isTwoHanded(item.itemClass);

  const add = (key, value) => {
    for (const [k, v] of expand(key, value)) {
      item.stats[k] = (item.stats[k] || 0) + v;
    }
  };

  // Advanced copy ({ Prefix Modifier ... } headers) tells us how many affixes
  // are used, so we can say how many are still open for crafting.
  let prefixes = 0; let suffixes = 0; let sawHeaders = false;

  // Weapon damage bits, collected from the property block.
  let phys = 0, ele = 0, chaos = 0, aps = 0, crit = 0;

  blocks.slice(1).forEach((block) => {
    block.forEach((line) => {
      // Advanced (Ctrl+Alt+C) descriptor lines like { Prefix Modifier "Hale" (Tier: 3) }
      if (line.startsWith('{')) {
        sawHeaders = true;
        if (/Prefix Modifier/i.test(line)) prefixes++;
        else if (/Suffix Modifier/i.test(line)) suffixes++;
        return;
      }
      // Advanced text puts mod ranges in brackets: +89(80-99) to maximum Life
      const clean = line.replace(/\((-?\d+(?:\.\d+)?)[-–](\d+(?:\.\d+)?)\)/g, '')
        .replace(/\s+[—–-]+\s*Unscalable Value\s*$/i, ''); // advanced-copy note

      let m;
      if ((m = clean.match(/^Item Level:\s*(\d+)/i))) { item.itemLevel = Number(m[1]); return; }
      if ((m = clean.match(/^Level:\s*(\d+)/i))) { item.requiredLevel = Number(m[1]); return; }
      if ((m = clean.match(/^Requires:?\s*Level\s*(\d+)/i))) { item.requiredLevel = Number(m[1]); return; }
      if (/^Corrupted$/i.test(clean)) { item.corrupted = true; return; }
      if (/^Unidentified$/i.test(clean)) { item.unidentified = true; return; }
      if (SKIP_LINE.some((r) => r.test(clean))) return;

      // "Key: value" property lines
      const prop = clean.match(/^([A-Za-z ]+):\s*(.+)$/);
      if (prop) {
        const pk = prop[1].trim().toLowerCase();
        const pv = prop[2].replace(TAG, '');
        if (PROPERTY_KEYS[pk]) {
          const n = pv.match(NUM);
          if (n) {
            const key = PROPERTY_KEYS[pk];
            add(key, Number(n[0]));
            item.lines.push({ text: line, key, value: Number(n[0]), tag: 'base' });
          }
          return;
        }
        if (pk === 'physical damage') { phys += avgRanges(pv); return; }
        if (pk === 'elemental damage' || /^(fire|cold|lightning) damage$/.test(pk)) { ele += avgRanges(pv); return; }
        if (pk === 'chaos damage') { chaos += avgRanges(pv); return; }
        if (pk === 'attacks per second') { aps = Number((pv.match(NUM) || [0])[0]); return; }
        if (pk === 'critical hit chance' || pk === 'critical strike chance') {
          crit = Number((pv.match(NUM) || [0])[0]); return;
        }
        // Other "X: Y" lines (Grants Skill, Reload Time, etc.) are shown but not scored.
        item.lines.push({ text: line, key: null, value: null, tag: 'info' });
        return;
      }

      const tagMatch = clean.match(TAG);
      const tag = tagMatch ? tagMatch[1].toLowerCase() : 'explicit';
      const modText = clean.replace(TAG, '').replace(TAG, '').trim();
      const stat = modToStat(modText);
      if (!stat) {
        // flavour text / keyword mods with no numbers - keep a flag stat for keyword mods
        if (block.length <= 6 && item.rarity !== 'Unique') {
          item.lines.push({ text: line, key: null, value: null, tag });
        }
        return;
      }
      add(stat.key, stat.value);
      item.lines.push({ text: line, key: stat.key, value: stat.value, tag });
    });
  });

  const rar = String(item.rarity || '').toLowerCase();
  if (sawHeaders && (rar === 'rare' || rar === 'magic')) {
    const max = rar === 'rare' ? 3 : 1;
    item.affixes = {
      known: true, prefixes, suffixes,
      openPrefix: item.corrupted ? 0 : Math.max(0, max - prefixes),
      openSuffix: item.corrupted ? 0 : Math.max(0, max - suffixes),
    };
  } else {
    item.affixes = { known: false };
  }

  if (aps > 0) {
    const r = (x) => Math.round(x * 10) / 10;
    item.stats['[Weapon] Physical DPS'] = r(phys * aps);
    item.stats['[Weapon] Elemental DPS'] = r(ele * aps);
    if (chaos) item.stats['[Weapon] Chaos DPS'] = r(chaos * aps);
    item.stats['[Weapon] Total DPS'] = r((phys + ele + chaos) * aps);
    if (crit) item.stats['[Weapon] Critical Hit Chance'] = crit;
    item.stats['[Weapon] Attacks per Second'] = aps;
  }

  return item;
}

module.exports = { parseItem, modToStat, expand };
