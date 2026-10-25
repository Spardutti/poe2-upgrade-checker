'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { priceStats } = require('../src/core/price');
const trade = require('../src/core/trade');

const NOW = Date.parse('2026-10-20T12:00:00Z');
let n = 0;
const L = (ex, extra = {}) => ({ id: 'l' + (++n), account: 'acc' + n, price: { amount: ex, currency: 'exalted' }, priceEx: ex, indexed: '2026-10-19T12:00:00Z', ...extra });
const market = (from, k, step = 20) => Array.from({ length: k }, (_, i) => L(from + i * step));

test('price: plain market gives the median of the cheapest 5 sellers', () => {
  const s = priceStats(market(300, 20), { now: NOW });
  assert.strictEqual(s.cheapestEx, 300);
  assert.strictEqual(s.typicalEx, 340); // median of 300..380
  assert.strictEqual(s.lowEx, 300);
  assert.strictEqual(s.highEx, 380);
  assert.ok(!s.few && !s.unreliable && !s.baits);
});

test('price: price-fixing baits at 1 ex are left out', () => {
  const s = priceStats([L(1), L(1), L(1), ...market(300, 20)], { now: NOW });
  assert.strictEqual(s.baits, 3);
  assert.strictEqual(s.cheapestEx, 300);
  assert.ok(s.typicalEx >= 300);
});

test('price: five baits among twenty are still left out (far under the market)', () => {
  const s = priceStats([L(1), L(1), L(1), L(1), L(1), ...market(300, 15)], { now: NOW });
  assert.strictEqual(s.cheapestEx, 300);
});

test('price: never drops more than a third', () => {
  const s = priceStats([L(1), L(1), L(1), L(1), L(400), L(410)], { now: NOW });
  assert.ok(s.baits <= 2);
});

test('price: one seller with many cheap copies counts once', () => {
  const copies = Array.from({ length: 7 }, () => L(150, { account: 'flipper' }));
  const s = priceStats([...copies, ...market(400, 12)], { now: NOW });
  assert.strictEqual(s.sellers, 13);
  assert.ok(s.typicalEx >= 400, `typical ${s.typicalEx}`);
});

test('price: stale listings are left out when enough fresh ones remain', () => {
  const old = [L(50, { indexed: '2025-01-01T00:00:00Z' }), L(60, { indexed: '2025-02-01T00:00:00Z' })];
  const s = priceStats([...old, ...market(300, 6)], { now: NOW });
  assert.strictEqual(s.stale, 2);
  assert.strictEqual(s.cheapestEx, 300);
});

test('price: fewer than 3 is "not enough to judge"', () => {
  const s = priceStats([L(2), L(400)], { now: NOW });
  assert.ok(s.few);
});

test('price: listings without a rate make it unreliable', () => {
  const div = Array.from({ length: 12 }, () => L(0, { price: { amount: 1, currency: 'divine' }, priceEx: null }));
  const s = priceStats([...div, ...market(600, 8)], { now: NOW });
  assert.strictEqual(s.unconvertible, 12);
  assert.strictEqual(s.unreliable, 'rate');
});

test('price: unpriced listings are counted, not priced', () => {
  const s = priceStats([L(0, { price: null, priceEx: null }), ...market(100, 5)], { now: NOW });
  assert.strictEqual(s.noPrice, 1);
  assert.strictEqual(s.count, 5);
});

test('price: wide spread is flagged', () => {
  const s = priceStats([L(100), L(150), L(200), L(400), L(600), L(900)], { now: NOW });
  assert.ok(s.spread);
});

test('price query: same rarity, same corruption, available, every stat at first', () => {
  const index = { all: [], byText: new Map() };
  const item = { name: 'Doom Grip', baseType: 'Sirenscale Gloves', itemClass: 'Gloves', rarity: 'Rare', corrupted: true, stats: {}, lines: [] };
  const q0 = trade.buildSimilarQuery(item, { statIndex: index, forPrice: true, status: 'any', level: 0 }).body.query;
  assert.strictEqual(q0.status.option, 'available');
  assert.strictEqual(q0.filters.type_filters.filters.rarity.option, 'rare');
  assert.strictEqual(q0.filters.misc_filters.filters.corrupted.option, 'true');
});

test('price confidence: plenty of close prices is solid; few, spread or loosened is not', () => {
  const { confidence } = require('../src/core/price');
  const solid = priceStats(market(300, 12, 10), { now: NOW });
  assert.strictEqual(confidence(solid, 0).grade, 'solid');
  assert.strictEqual(confidence(solid, 1).grade, 'rough');
  assert.strictEqual(confidence(solid, 2).grade, 'guess');
  const spread = priceStats([L(100), L(150), L(200), L(300), L(450), L(600), L(800), L(900)], { now: NOW });
  assert.strictEqual(confidence(spread, 0).grade, 'rough');
  assert.match(confidence(spread, 0).why, /spread/);
  const few = priceStats([L(100), L(110), L(120)], { now: NOW });
  assert.strictEqual(confidence(few, 0).grade, 'guess');
  assert.match(confidence(few, 0).why, /only 3 sellers/);
});
