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
  assert.deepEqual(g.contributions.map((c) => c.key), ['[Weapon] Total DPS']);
});

test('gear score does not call weapon damage mods wasted', () => {
  const g = gearScore(parseItem(FAST_MACE), { build: 'life-res' });
  assert.deepEqual(g.wasted, []);
});
