'use strict';

// Map, waystone and tablet mods that make monsters stronger, as Path of Building enemy mods, so the
// map check can say what each does to YOU: how much harder they hit, how long you last, and what it
// does to your damage (tougher monsters). Path of Building models the enemy's hit with its own
// numbers (Configuration → enemy damage); these mods scale that enemy.
//
// parse(text) -> { mods: [{ name, type, value }], pen: { Fire, Cold, Lightning, Chaos }, kind } or null
// kind: 'hit' (hits harder or more often), 'tough' (harder to kill), 'other'

const ELS = ['Fire', 'Cold', 'Lightning', 'Chaos'];
const el = (w) => ({ fire: 'Fire', cold: 'Cold', lightning: 'Lightning', chaos: 'Chaos' })[String(w).toLowerCase()];
const num = (s) => Number(String(s).replace(/[^\d.-]/g, ''));

// each rule: a pattern for the mod text (PoE2 wording first, PoE1 where it differs) -> what it adds
const RULES = [
  // extra damage of a type ("Monsters deal 30% of Damage as Extra Fire")
  [/^Monsters (?:deal|gain) (\d+)% of (?:their )?(?:Physical )?Damage as Extra (Fire|Cold|Lightning|Chaos)/i, (m) => ({ kind: 'hit', mods: [{ name: `DamageGainAs${el(m[2])}`, type: 'BASE', value: num(m[1]) }] })],
  [/^Monsters deal (\d+)% extra Physical Damage as (Fire|Cold|Lightning|Chaos)/i, (m) => ({ kind: 'hit', mods: [{ name: `PhysicalDamageGainAs${el(m[2])}`, type: 'BASE', value: num(m[1]) }] })],
  // more damage
  [/^(\d+)% (increased|more) Monster Damage/i, (m) => ({ kind: 'hit', mods: [{ name: 'Damage', type: /more/i.test(m[2]) ? 'MORE' : 'INC', value: num(m[1]) }] })],
  [/^Monsters deal (\d+)% (increased|more) Damage/i, (m) => ({ kind: 'hit', mods: [{ name: 'Damage', type: /more/i.test(m[2]) ? 'MORE' : 'INC', value: num(m[1]) }] })],
  [/^(?:Monsters deal )?(\d+)% (increased|more) Monster (Fire|Cold|Lightning|Chaos|Physical|Elemental) Damage/i, (m) => ({ kind: 'hit', mods: [{ name: `${m[3][0].toUpperCase()}${m[3].slice(1).toLowerCase()}Damage`, type: /more/i.test(m[2]) ? 'MORE' : 'INC', value: num(m[1]) }] })],
  // penetration ("Monster Damage Penetrates 15% Elemental Resistances", "Monsters Penetrate 10% of Cold Resistance")
  [/^Monsters?(?: Damage)? Penetrates? (\d+)%(?: of)? (Elemental|Fire|Cold|Lightning|Chaos) Resistances?/i, (m) => {
    const v = num(m[1]); const pen = {};
    for (const e of /elemental/i.test(m[2]) ? ['Fire', 'Cold', 'Lightning'] : [el(m[2])]) pen[e] = v;
    return { kind: 'hit', mods: [], pen };
  }],
  // critical hits
  [/^Monsters have (\d+)% increased Critical (?:Hit|Strike) Chance/i, (m) => ({ kind: 'hit', mods: [{ name: 'CritChance', type: 'INC', value: num(m[1]) }] })],
  [/^(\d+)% increased Monster Critical (?:Hit|Strike) Chance/i, (m) => ({ kind: 'hit', mods: [{ name: 'CritChance', type: 'INC', value: num(m[1]) }] })],
  [/^\+?(\d+)% to Monster Critical (?:Damage Bonus|Strike Multiplier)/i, (m) => ({ kind: 'hit', mods: [{ name: 'CritMultiplier', type: 'BASE', value: num(m[1]) }] })],
  [/^Monsters have (\d+)% increased Critical Damage Bonus/i, (m) => ({ kind: 'hit', mods: [{ name: 'CritMultiplier', type: 'INC', value: num(m[1]) }] })],
  [/^Monsters have \+?(\d+)% Critical Damage Bonus/i, (m) => ({ kind: 'hit', mods: [{ name: 'CritMultiplier', type: 'BASE', value: num(m[1]) }] })],
  // speed: more hits in the same time
  [/^(\d+)% increased Monster (?:Attack|Cast|Attack and Cast) Speed/i, (m) => ({ kind: 'hit', mods: [{ name: 'Speed', type: 'INC', value: num(m[1]) }] })],
  [/^Monsters have (\d+)% increased (?:Attack|Cast)(?:,| and)? (?:Cast )?(?:and Movement )?Speed/i, (m) => ({ kind: 'hit', mods: [{ name: 'Speed', type: 'INC', value: num(m[1]) }] })],
  // accuracy: you evade less
  [/^(?:Monsters have )?(\d+)% increased (?:Monster )?Accuracy Rating/i, (m) => ({ kind: 'hit', mods: [{ name: 'Accuracy', type: 'INC', value: num(m[1]) }] })],
  // tougher monsters: your damage against them
  [/^\+?(\d+)% (?:to )?Monster Elemental Resistances?/i, (m) => ({ kind: 'tough', mods: [{ name: 'ElementalResist', type: 'BASE', value: num(m[1]) }] })],
  [/^Monsters have \+?(\d+)% to all Elemental Resistances/i, (m) => ({ kind: 'tough', mods: [{ name: 'ElementalResist', type: 'BASE', value: num(m[1]) }] })],
  [/^\+?(\d+)% (?:to )?Monster Chaos Resistance/i, (m) => ({ kind: 'tough', mods: [{ name: 'ChaosResist', type: 'BASE', value: num(m[1]) }] })],
  [/^\+?(\d+)% Monster Physical Damage Reduction/i, (m) => ({ kind: 'tough', mods: [{ name: 'PhysicalDamageReduction', type: 'BASE', value: num(m[1]) }] })],
  [/^Monsters have (\d+)% increased Armour/i, (m) => ({ kind: 'tough', mods: [{ name: 'Armour', type: 'INC', value: num(m[1]) }] })],
  [/^Monsters have (\d+)% increased Evasion/i, (m) => ({ kind: 'tough', mods: [{ name: 'Evasion', type: 'INC', value: num(m[1]) }] })],
  [/^Monsters have (\d+)% increased Armour, Evasion and Energy Shield/i, (m) => ({ kind: 'tough', mods: [{ name: 'Armour', type: 'INC', value: num(m[1]) }, { name: 'Evasion', type: 'INC', value: num(m[1]) }] })],
  // your crits do less to them
  [/^Monsters take (\d+)% reduced Extra Damage from Critical Hits/i, (m) => ({ kind: 'tough', mods: [{ name: 'SelfCritMultiplier', type: 'INC', value: -num(m[1]) }] })],
  // energy shield on top of life: more to chew through, like more life
  [/^Monsters gain (\d+)% of (?:their )?maximum Life as Extra maximum Energy Shield/i, (m) => ({ kind: 'tough', life: num(m[1]), mods: [] })],
  [/^Monsters are (Armoured|Evasive)/i, () => ({ kind: 'tough', mods: [] })],
  [/^Monsters have (\d+)% increased (Stun Threshold|Ailment Threshold)/i, () => ({ kind: 'tough', mods: [] })],
  // dangers Path of Building can't put a number on: still "monsters hit harder"
  [/^Monsters (?:fire \d+ additional Projectiles|have \d+% increased Area of Effect|Break Armour|have \d+% chance to (?:Poison|inflict Bleeding|steal)|inflict |have \d+% increased (?:Freeze Buildup|Shock Chance|Stun Buildup|Movement Speed))/i, () => ({ kind: 'hit', mods: [] })],
  [/^(\d+)% increased Monster Movement Speed/i, () => ({ kind: 'hit', mods: [] })],
  [/^Monsters? have (\d+)% increased Elemental Ailment Application/i, () => ({ kind: 'hit', mods: [] })],
  // more life: Path of Building doesn't count it, the app does (time to kill)
  [/^(\d+)% (more|increased) Monster Life/i, (m) => ({ kind: 'tough', life: num(m[1]) * (/more/i.test(m[2]) ? 1 : 1), mods: [] })],
  [/^Monsters have (\d+)% (more|increased) (?:maximum )?Life/i, (m) => ({ kind: 'tough', life: num(m[1]), mods: [] })],
];

// a tablet's (and some maps') wording: "… in Map", "… in your Maps", "… in Area" at the end or in the
// middle; the rules read the waystone wording
const plainWording = (text) => String(text || '').replace(/\s+in (?:your |affected |this )?(?:Maps?|Area)\b/gi, '').replace(/\s+/g, ' ').trim();
function parse(text) {
  const t = plainWording(text);
  if (!/monster/i.test(t)) return null;
  for (const [re, fn] of RULES) {
    const m = t.match(re);
    if (m) { const r = fn(m); return { kind: r.kind, mods: r.mods || [], pen: r.pen || {}, life: r.life || 0 }; }
  }
  return null;
}

// for the engine: [{ text, mods, pen }] for the mods it can put on the enemy
function enemyList(mods) {
  const out = [];
  for (const text of mods || []) {
    const p = parse(text);
    if (p && (p.mods.length || Object.keys(p.pen).length)) out.push({ text, mods: p.mods, pen: p.pen });
  }
  return out;
}

// total extra monster life on a map (for "takes X% longer to kill")
const extraLife = (mods) => (mods || []).reduce((s, t) => { const p = parse(t); return s + (p ? p.life : 0); }, 0);

module.exports = { parse, enemyList, extraLife, plainWording, ELS };
