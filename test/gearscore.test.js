'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseItem } = require('../src/core/parser');
const { gearScore } = require('../src/core/gearscore');

const FAST_MACE = `Item Class: Two Hand Maces
Rarity: Rare
Brute Knell
Forge Maul
--------
Physical Damage: 100-160 (augmented)
Fire Damage: 20-40 (augmented)
Attacks per Second: 1.32 (augmented)
--------
Item Level: 70
--------
120% increased Physical Damage
Adds 20 to 40 Fire Damage
20% increased Attack Speed`;

test('gear score counts weapon attack speed only through the weapon DPS', () => {
  const g = gearScore(parseItem(FAST_MACE), { build: 'life-res' });
  assert.deepStrictEqual(g.contributions.map((c) => c.key), ['[Weapon] Total DPS']);
});

test('gear score still counts attack speed on gloves', () => {
  const gloves = parseItem('Item Class: Gloves\nRarity: Rare\nX\nY\n--------\nArmour: 100\n--------\n10% increased Attack Speed');
  const g = gearScore(gloves, { build: 'life-res' });
  assert.deepStrictEqual(g.contributions.map((c) => [c.key, c.points]), [['[Base] Armour', 1.8], ['#% increased Attack Speed', 1.5]]);
});

test('gear score calls weapon damage mods wasted for a build that does not use weapon DPS', () => {
  const g = gearScore(parseItem(FAST_MACE), { build: 'es-caster' });
  assert.deepStrictEqual(g.wasted, ['#% increased Physical Damage', 'Adds # to # Fire Damage', '#% increased Attack Speed']);
});

test('gear score counts weapon attack speed when weapon DPS is tweaked off', () => {
  const g = gearScore(parseItem(FAST_MACE), { build: 'life-res', tweaks: { 'Weapon DPS': 0 } });
  assert.deepStrictEqual(g.contributions.map((c) => c.key), ['#% increased Attack Speed']);
});

test('gear score counts weapon attack speed when weapon DPS is ignored', () => {
  const g = gearScore(parseItem(FAST_MACE), { build: 'life-res', ignore: (k) => k === '[Weapon] Total DPS' });
  assert.deepStrictEqual(g.contributions.map((c) => c.key), ['#% increased Attack Speed']);
});

test('gear score calls global attack mods on a weapon wasted', () => {
  const mace = FAST_MACE.replace(/120%[^]*$/, 'Allies in your Presence have 10% increased Attack Speed\n12% increased Attack Speed with Quarterstaves\nAdds 2 to 4 Physical Damage to Attacks');
  const g = gearScore(parseItem(mace), { build: 'life-res' });
  assert.deepStrictEqual(g.wasted, ['Allies in your Presence have #% increased Attack Speed', '#% increased Attack Speed with Quarterstaves', 'Adds # to # Physical Damage to Attacks']);
});

test('gear score does not call weapon damage mods wasted', () => {
  const g = gearScore(parseItem(FAST_MACE), { build: 'life-res' });
  assert.deepStrictEqual(g.wasted, []);
});
