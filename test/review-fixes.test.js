'use strict';

// Fixes from the October 2026 code review: each test is one bug that mattered.
const test = require('node:test');
const assert = require('node:assert');
const trade = require('../src/core/trade');
const pq = require('../src/core/pricequery');
const resists = require('../src/core/resists');
const ninja = require('../src/core/ninja');
const pob = require('../src/core/pob');
const { suggestWeights } = require('../src/core/autoweights');
const { parseItem } = require('../src/core/parser');

// a few trade-site stats, as /data/stats gives them
const statIndex = trade.buildStatIndex({ result: [{ id: 'explicit', entries: [
  { id: 'explicit.stat_freeze', text: '#% reduced Freeze Duration on you', type: 'explicit' },
  { id: 'explicit.stat_manacost', text: '#% reduced Mana Cost of Skills', type: 'explicit' },
  { id: 'explicit.stat_life', text: '# to maximum Life', type: 'explicit' },
  { id: 'explicit.stat_spellcrit', text: '#% increased Critical Hit Chance for Spells', type: 'explicit' },
  { id: 'explicit.stat_cast', text: '#% increased Cast Speed', type: 'explicit' },
] }] });

test('a "reduced" mod matches the trade site\'s "reduced" stat, the right way round', () => {
  const m = trade.matchStat('#% increased Freeze Duration on you', statIndex);
  assert.strictEqual(m.id, 'explicit.stat_freeze');
  assert.strictEqual(m.invert, true);
  // "at least -40" (our way) is "at most 40% reduced" (the site's)
  const q = trade.buildQuery([{ key: '#% increased Freeze Duration on you', min: -40 }], { statIndex, itemClass: 'Boots' });
  assert.deepStrictEqual(q.body.query.stats[0].filters[0].value, { max: 40 });
  // a search for items like this one wants at least the same reduction
  const boots = parseItem('Item Class: Boots\nRarity: Rare\nX\nSandsworn Sandals\n--------\nItem Level: 81\n--------\n+80 to maximum Life\n40% reduced Freeze Duration on you');
  const s = trade.buildSimilarQuery(boots, { statIndex, preferLocal: true });
  const f = s.body.query.stats[0].filters.find((x) => x.id === 'explicit.stat_freeze');
  assert.ok(f && f.value.min > 0, JSON.stringify(s.body.query.stats));
});

test('a price check keeps "reduced Mana Cost" and global mods on weapons', () => {
  const amu = parseItem('Item Class: Amulets\nRarity: Rare\nX\nJade Amulet\n--------\nItem Level: 81\n--------\n15% reduced Mana Cost of Skills\n+80 to maximum Life');
  assert.ok(pq.priceStats(amu, { statIndex }).stats.some((x) => x.id === 'explicit.stat_manacost' && x.value === 15));
  const wand = parseItem('Item Class: Wands\nRarity: Rare\nX\nWithered Wand\n--------\nItem Level: 81\n--------\n65% increased Critical Hit Chance for Spells\n24% increased Cast Speed');
  assert.ok(pq.priceStats(wand, { statIndex, preferLocal: true }).stats.some((x) => x.id === 'explicit.stat_spellcrit'));
  assert.strictEqual(trade.localFor('#% increased Critical Hit Chance for Spells', 'Wands', true), false);
  assert.strictEqual(trade.localFor('#% increased Attack Speed', 'One Hand Maces', true), true);
  assert.strictEqual(trade.localFor('#% of Armour also applies to Elemental Damage', 'Body Armours', true), false);
  assert.strictEqual(trade.localFor('#% increased Armour', 'Body Armours', true), true);
});

test('PoE1 maximum resistances raise the caps', () => {
  const sh = parseItem('Item Class: Shields\nRarity: Unique\nRise of the Phoenix\nMirrored Spiked Shield\n--------\nItem Level: 80\n--------\n+5% to maximum Fire Resistance\n+1% to all maximum Resistances');
  assert.deepStrictEqual(resists.gearMax({ Offhand: sh }), { fire: 6, cold: 1, lightning: 1, chaos: 1 });
});

test('suggested weights keep crit mods (only the weapon\'s own crit is left out)', () => {
  const ring = parseItem('Item Class: Rings\nRarity: Rare\nX\nRuby Ring\n--------\nItem Level: 80\n--------\n30% increased Critical Hit Chance');
  assert.ok(suggestWeights({ 'Ring 1': ring }).some((w) => w.key === '#% increased Critical Hit Chance'));
});

test('a PoE1 magic map finds its poe.ninja price', () => {
  const map = parseItem('Item Class: Maps\nRarity: Magic\nFecund Strand Map of Toughness\n--------\nMap Tier: 5\n--------\nItem Level: 73\n--------\nMonsters have 20% increased Area of Effect');
  assert.strictEqual((ninja.pickLine([{ name: 'Shore Map' }, { name: 'Strand Map' }], map, 'poe1') || {}).name, 'Strand Map');
});

test('a build on weapon set II imports that set as your weapon and offhand', () => {
  const it = (n, b) => `Rarity: RARE\n${n}\n${b}\nItem Level: 80\n+10 to maximum Life`;
  const xml = (sw) => `<PathOfBuilding2><Build level="90" className="Warrior"/><Items activeItemSet="1"><Item id="1">${it('First', 'Smithing Hammer')}</Item><Item id="2">${it('Second', 'Felled Greatclub')}</Item><ItemSet id="1" useSecondWeaponSet="${sw}"><Slot name="Weapon 1" itemId="1"/><Slot name="Weapon 1 Swap" itemId="2"/></ItemSet></Items></PathOfBuilding2>`;
  assert.match(pob.parsePob(xml('false')).items.Weapon, /First/);
  assert.match(pob.parsePob(xml('true')).items.Weapon, /Second/);
  assert.match(pob.parsePob(xml('true')).items['Weapon 2'], /First/);
});
