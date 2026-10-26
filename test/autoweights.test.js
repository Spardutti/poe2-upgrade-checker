'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseItem } = require('../src/core/parser');
const { suggestWeights } = require('../src/core/autoweights');

const mace = (mods) => parseItem(`Item Class: Two Hand Maces
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
${mods}`);
const keys = (equipped) => suggestWeights(equipped).map((w) => w.key).sort();

test('suggested weights leave out a weapon\'s own damage and attack speed mods', () => {
  const equipped = { Weapon: mace('120% increased Physical Damage\nAdds 20 to 40 Fire Damage\n20% increased Attack Speed') };
  assert.deepStrictEqual(keys(equipped), ['[Weapon] Total DPS']);
});

test('suggested weights keep global attack mods on a weapon', () => {
  const equipped = { Weapon: mace('Allies in your Presence have 10% increased Attack Speed\n12% increased Attack Speed with Quarterstaves\nAdds 2 to 4 Physical Damage to Attacks') };
  assert.deepStrictEqual(keys(equipped), ['#% increased Attack Speed with Quarterstaves', 'Adds # to # Physical Damage to Attacks', 'Allies in your Presence have #% increased Attack Speed', '[Weapon] Total DPS']);
});

test('suggested weights keep attack speed from gloves', () => {
  const gloves = parseItem('Item Class: Gloves\nRarity: Rare\nX\nY\n--------\nArmour: 100\n--------\n10% increased Attack Speed');
  const s = suggestWeights({ Gloves: gloves, Weapon: mace('20% increased Attack Speed') });
  assert.deepStrictEqual(s.find((w) => w.key === '#% increased Attack Speed'), { key: '#% increased Attack Speed', weight: 3, slots: 1, avg: 10 });
});
