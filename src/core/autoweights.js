'use strict';

// Suggests stat weights from the gear you have equipped: the stats your
// build already stacks are the ones you care about. A typical roll of each
// stat is worth ~30 points, more if several of your items have it.

const { statSources } = require('./trade');

// a weapon's or shield's own numbers (not mods: "#% increased Critical Hit Chance" is a real stat to weigh)
const SKIP = /^\[(Base|Weapon)\] (Attacks per Second|Critical Hit Chance|Runic Ward|Block Chance|Physical DPS|Elemental DPS|Chaos DPS)$/;

function roundSig(x) {
  if (!x) return 0;
  return Number(Number(x).toPrecision(2));
}

// On armour/weapons these mods only raise the item's own base value, which
// [Base] Armour/Evasion/ES/Spirit already counts - weighting both would double up.
const LOCAL_DEFENCE = /^#% increased (Armour|Evasion Rating|Evasion|Energy Shield|Armour and Evasion|Armour and Energy Shield|Evasion and Energy Shield|Armour, Evasion and Energy Shield)$|^# to (maximum Energy Shield|Armour|Evasion Rating)$/;
// and a weapon's own damage and attack speed are already in [Weapon] Total DPS
const LOCAL_DPS = /^#% increased (Attack Speed|Physical Damage)$|Adds # to # \w+ Damage$/;

function suggestWeights(equipped, isIgnored) {
  const per = new Map(); // key -> { values: [], slots: Set }
  for (const [slot, item] of Object.entries(equipped || {})) {
    if (!item || /unique/i.test(item.rarity || '')) continue; // uniques' fixed mods say little about your build
    const seen = new Set();
    const st = item.stats || {};
    const hasBaseDef = st['[Base] Armour'] || st['[Base] Evasion Rating'] || st['[Base] Energy Shield'];
    for (const x of statSources(item)) {
      if (x.source === 'socket' || SKIP.test(x.key) || (isIgnored && isIgnored(x.key))) continue;
      if (hasBaseDef && LOCAL_DEFENCE.test(x.key)) continue;
      if (st['[Weapon] Total DPS'] && !(isIgnored && isIgnored('[Weapon] Total DPS')) && LOCAL_DPS.test(x.key)) continue;
      if (st['[Base] Spirit'] && x.key === '#% increased Spirit') continue;
      if (!(x.value > 0)) continue;
      const e = per.get(x.key) || { values: [], slots: new Set() };
      if (!seen.has(x.key)) { e.values.push(x.value); seen.add(x.key); } else e.values[e.values.length - 1] += x.value;
      e.slots.add(slot);
      per.set(x.key, e);
    }
  }
  const out = [];
  for (const [key, e] of per) {
    const avg = e.values.reduce((a, b) => a + b, 0) / e.values.length;
    const n = e.slots.size;
    let target = 30 * (1 + 0.5 * (n - 1)); // more slots = more important to your build
    if (key.startsWith('[Base]')) target = 40;
    if (key === '[Weapon] Total DPS') target = 60;
    if (key === '#% increased Movement Speed') target = 90; // boots' main stat
    target = Math.min(target, 90);
    out.push({ key, weight: roundSig(target / avg), slots: n, avg: Math.round(avg * 10) / 10 });
  }
  out.sort((a, b) => b.slots - a.slots || a.key.localeCompare(b.key));
  return out;
}

module.exports = { suggestWeights };
