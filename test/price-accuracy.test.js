'use strict';

// The price check's accuracy: each test is a market shape the trade site really shows.
const test = require('node:test');
const assert = require('node:assert');
const { parseItem } = require('../src/core/parser');
const trade = require('../src/core/trade');
const comparables = require('../src/core/comparables');
const { priceStats } = require('../src/core/price');

const statIndex = trade.buildStatIndex({ result: [{ id: 'explicit', entries: [
  { id: 'explicit.stat_3032590688', text: 'Adds # to # Physical Damage to Attacks', type: 'explicit' },
  { id: 'explicit.stat_681332047', text: '#% increased Attack Speed', type: 'explicit' },
  { id: 'explicit.stat_3291658075', text: '#% increased Cold Damage', type: 'explicit' },
  { id: 'explicit.stat_3299347043', text: '# to maximum Life', type: 'explicit' },
] }] });
const NOW = Date.parse('2026-10-27T12:00:00Z');
const ring = (mods) => parseItem(`Item Class: Rings\nRarity: Rare\nX\nPrismatic Ring\n--------\nItem Level: 82\n--------\n+9% to all Elemental Resistances (implicit)\n--------\n${mods.join('\n')}`);
// Adam's Rapture Circle: 60 total res, 17 str, T1 added physical, and little else that sells
const RAPTURE = ring(['+12 to maximum Life', 'Adds 18 to 30 Physical Damage to Attacks', '+17 to Strength', '16.1 Life Regeneration per second', '+11% to all Elemental Resistances']);
let n = 0;
const L = (ex, item) => ({ id: 'l' + (++n), account: 'a' + n, price: { amount: ex, currency: 'exalted' }, priceEx: ex, indexed: '2026-10-26T12:00:00Z', item });

test('price: listings with more than your item are left out of its price', () => {
  const alike = [L(40, ring(['Adds 17 to 29 Physical Damage to Attacks', '+18 to Strength', '+12% to all Elemental Resistances'])),
    L(55, ring(['Adds 18 to 31 Physical Damage to Attacks', '+16 to Strength', '+10% to all Elemental Resistances', '+15 to maximum Life'])),
    L(70, ring(['Adds 19 to 30 Physical Damage to Attacks', '+17 to Strength', '+11% to all Elemental Resistances', '10 Life Regeneration per second']))];
  const better = Array.from({ length: 12 }, (_, i) => L(1400 + i * 250, ring(['Adds 18 to 30 Physical Damage to Attacks', '+17 to Strength', '+11% to all Elemental Resistances', '+85 to maximum Life', '14% increased Attack Speed'])));
  const all = [...alike, ...better];
  // without it the cheapest five sellers include two of the better rings
  assert.ok(priceStats(all, { now: NOW }).highEx > 1000);
  const g = comparables.pick(RAPTURE, all, { statIndex }, 3);
  assert.strictEqual(g.group, 'alike');
  assert.strictEqual(g.listings.length, 3);
  assert.ok(priceStats(g.listings, { now: NOW }).typicalEx < 100);
  assert.ok(better[0].diff.extra.some((x) => /life/i.test(x)), JSON.stringify(better[0].diff));
});

test('price: too few alike, then close, then everything (and it says so)', () => {
  const close = [L(100, ring(['Adds 18 to 30 Physical Damage to Attacks', '+17 to Strength', '+11% to all Elemental Resistances', '20% increased Cold Damage'])),
    L(120, ring(['Adds 18 to 30 Physical Damage to Attacks', '+17 to Strength', '+11% to all Elemental Resistances', '21% increased Cold Damage'])),
    L(150, ring(['Adds 18 to 30 Physical Damage to Attacks', '+17 to Strength', '+11% to all Elemental Resistances', '22% increased Cold Damage']))];
  assert.strictEqual(comparables.pick(RAPTURE, close, { statIndex }, 3).group, 'close');
  const far = close.map((x) => L(x.priceEx, ring(['Adds 18 to 30 Physical Damage to Attacks', '+17 to Strength', '+11% to all Elemental Resistances', '+90 to maximum Life', '22% increased Cold Damage'])));
  assert.strictEqual(comparables.pick(RAPTURE, far, { statIndex }, 3).group, 'all');
});

test('price: a stat well above yours counts as more; one well under as missing', () => {
  const big = L(500, ring(['Adds 30 to 50 Physical Damage to Attacks', '+17 to Strength', '+11% to all Elemental Resistances']));
  const small = L(20, ring(['Adds 5 to 9 Physical Damage to Attacks', '+17 to Strength', '+11% to all Elemental Resistances']));
  comparables.pick(RAPTURE, [big, small], { statIndex }, 3);
  assert.ok(big.diff.extra.length === 1 && !big.diff.missing.length, JSON.stringify(big.diff));
  assert.ok(small.diff.missing.length === 1 && !small.diff.extra.length, JSON.stringify(small.diff));
});
