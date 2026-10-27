'use strict';

// The known issues from the October 2026 review, fixed: each test is one of them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseItem } = require('../src/core/parser');
const trade = require('../src/core/trade');
const pq = require('../src/core/pricequery');
const monster = require('../src/core/monstermods');
const ninja = require('../src/core/ninja');

test('trade stats: the site\'s bracket notes and "an additional" wordings still match the item', () => {
  const idx = trade.buildStatIndex({ result: [{ id: 'explicit', entries: [
    { id: 'explicit.stat_gold', text: '#% increased Gold found in Map (Gold Piles)', type: 'explicit' },
    { id: 'explicit.stat_chest', text: 'Map contains an additional Rare Chest', type: 'explicit' },
  ] }] });
  assert.strictEqual(trade.matchStat('#% increased Gold found in Map', idx).id, 'explicit.stat_gold');
  assert.strictEqual(trade.matchStat('Map contains # additional Rare Chests', idx).id, 'explicit.stat_chest');
});

test('tablet price: every mod, including gold, rare chests and mods without a number', () => {
  const idx = trade.buildStatIndex({ result: [{ id: 'explicit', entries: [
    { id: 'explicit.stat_gold', text: '#% increased Gold found in Map (Gold Piles)', type: 'explicit' },
    { id: 'explicit.stat_chest', text: 'Map contains an additional Rare Chest', type: 'explicit' },
    { id: 'explicit.stat_eff', text: 'Monsters have #% increased Effectiveness', type: 'explicit' },
    { id: 'explicit.stat_rmod', text: 'Unique Monsters have # additional Rare Modifier', type: 'explicit' },
  ] }] });
  const item = parseItem(`Item Class: Tablet
Rarity: Rare
Void Edict
Abyss Tablet
--------
Item Level: 80
--------
Adds Abysses to a Map (implicit)
--------
10 uses remaining
--------
30(25-35)% increased Gold found in Map
Map contains 3(2-3) additional Rare Chests
Monsters have 12(10-15)% increased Effectiveness
Unique Monsters have 1 additional Rare Modifier
--------
Can be used in a personal Map Device to add modifiers to a Map.`);
  const q = pq.buildMapPriceQuery(item, { game: 'poe2', statIndex: idx, level: 0 });
  assert.strictEqual(q.body.query.type, 'Abyss Tablet');
  const ids = q.body.query.stats.flatMap((g) => g.filters.map((f) => f.id));
  assert.deepStrictEqual(ids, ['pseudo.pseudo_number_of_uses_remaining', 'explicit.stat_gold', 'explicit.stat_chest', 'explicit.stat_eff', 'explicit.stat_rmod']);
  assert.ok(!q.unmatched, JSON.stringify(q.unmatched));
});

test('waystone: "Unscalable Value" notes and the help line are not mods', () => {
  const w = parseItem('Item Class: Waystones\nRarity: Rare\nX\nWaystone (Tier 15)\n--------\nWaystone Tier: 15\n--------\nItem Level: 80\n--------\nArea has patches of Shocked Ground — Unscalable Value\n--------\nCan be used in a Map Device, allowing you to enter a Map. Waystones can only be used once.');
  const mods = w.lines.filter((l) => l.kw);
  assert.deepStrictEqual(mods.map((l) => l.kw), ['Area has patches of Shocked Ground']);
});

test('uniques show their keyword mods, not their flavour text', () => {
  const g = parseItem('Item Class: Helmets\nRarity: Unique\nGoldrim\nLeather Hood\n--------\nEvasion Rating: 60\n--------\n+34% to all Elemental Resistances\nCannot be Ignited\n--------\nNo metal slips as easily through the fingers as gold.');
  assert.ok(g.lines.some((l) => l.text === 'Cannot be Ignited'));
  assert.ok(!g.lines.some((l) => /No metal/.test(l.text)));
});

test('map check: combined armour wordings and physical-only extra damage', () => {
  assert.deepStrictEqual(monster.parse('Monsters have 40% increased Armour, Evasion and Energy Shield').mods.map((m) => m.name), ['Armour', 'Evasion', 'EnergyShield']);
  assert.strictEqual(monster.parse('Monsters gain 20% of their Physical Damage as Extra Chaos').mods[0].name, 'PhysicalDamageGainAsChaos');
  assert.strictEqual(monster.parse('Monsters deal 15% of Damage as Extra Fire').mods[0].name, 'DamageGainAsFire');
});

test('gear search: no weapon-only (Local) stats on a ring', () => {
  const idx = trade.buildStatIndex({ result: [{ id: 'explicit', entries: [
    { id: 'explicit.stat_as', text: '#% increased Attack Speed', type: 'explicit' },
    { id: 'explicit.stat_asl', text: '#% increased Attack Speed (Local)', type: 'explicit' },
  ] }] });
  const w = [{ test: /^#% increased Attack Speed$/, w: 1, label: 'Attack speed', imp: 2, key: 'x' }];
  const ring = parseItem('Item Class: Rings\nRarity: Rare\nX\nRuby Ring\n--------\nItem Level: 80\n--------\n10% increased Attack Speed');
  assert.deepStrictEqual(trade.buildGearQuery(ring, { weights: w, statIndex: idx, itemClass: 'Rings' }).body.query.stats[0].filters.map((f) => f.id), ['explicit.stat_as']);
  const mace = parseItem('Item Class: One Hand Maces\nRarity: Rare\nX\nMace\n--------\nItem Level: 80\n--------\n10% increased Attack Speed');
  assert.ok(trade.buildGearQuery(mace, { weights: w, statIndex: idx, itemClass: 'One Hand Maces' }).body.query.stats[0].filters.some((f) => f.id === 'explicit.stat_asl'));
});

test('budget label says which listings a one-currency search covers', () => {
  assert.strictEqual(trade.budgetLabel({ max: 2, currency: 'divine', divineRate: 300 }, 'poe2'), '≤ 2 div (ex listings only)');
  assert.strictEqual(trade.budgetLabel({ max: 10, currency: 'divine', divineRate: 300 }, 'poe2'), '≤ 10 div (div listings only)');
});

test('the site Worker passes on every poe.ninja list the app asks for', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'worker', 'site-worker.js'), 'utf8');
  for (const g of ['poe1', 'poe2']) {
    for (const t of [...Object.values(ninja.UNIQUE_TYPES[g]), ...ninja.EXCHANGE_TYPES[g]]) assert.ok(src.includes(`'${t}'`), `${g} ${t}`);
  }
  for (const t of ['SkillGem', 'ImbuedGem', 'Map', 'BlightedMap', 'BlightRavagedMap', 'Incubator', 'Memory', 'Vial', 'Invitation', 'ScryingOrb', 'ForbiddenJewel', 'PrecursorTablets']) assert.ok(src.includes(`'${t}'`), t);
});

test('price check: what was left out of the search is said (for the log)', () => {
  const ring = parseItem('Item Class: Rings\nRarity: Rare\nX\nRuby Ring\n--------\nItem Level: 80\n--------\n+12 to maximum Life\n16.1 Life Regeneration per second');
  const { skipped } = pq.priceStats(ring, { statIndex: trade.buildStatIndex({ result: [] }) });
  assert.ok(skipped.some((x) => /Life Regeneration.*filler/.test(x)) && skipped.some((x) => /Total life 12/.test(x)), JSON.stringify(skipped));
});
