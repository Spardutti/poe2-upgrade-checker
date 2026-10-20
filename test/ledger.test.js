'use strict';
const test = require('node:test');
const assert = require('node:assert');
const prices = require('../src/stash/prices');
const ledger = require('../src/stash/ledger');

const exchange = {
  core: { items: [{ id: 'divine', name: 'Divine Orb' }, { id: 'exalted', name: 'Exalted Orb' }], rates: { exalted: 300, chaos: 2 }, primary: 'divine' },
  lines: [{ id: 'exalted', primaryValue: 1 / 300 }, { id: 'chaos', primaryValue: 0.5 }, { id: 'mirror', primaryValue: 900 }],
  items: [{ id: 'exalted', name: 'Exalted Orb' }, { id: 'chaos', name: 'Chaos Orb' }, { id: 'mirror', name: 'Mirror of Kalandra' }],
};
const uniques = { core: { primary: 'divine', rates: {} }, lines: [
  { name: 'Headhunter', baseType: 'Heavy Belt', primaryValue: 40, listingCount: 30, corrupted: false },
  { name: 'Headhunter', baseType: 'Heavy Belt', primaryValue: 25, listingCount: 50, corrupted: true },
  { name: 'Rare Thing', primaryValue: 9000, listingCount: 1 },
] };

function idx() {
  return { league: 'Test', fetched: 1, byName: prices.buildIndex([...prices.parseExchange(exchange, 'Currency'), ...prices.parseUniques(uniques, 'UniqueAccessories')]) };
}

test('poe.ninja exchange data -> divine prices, incl. the primary currency itself', () => {
  const i = idx();
  assert.strictEqual(prices.lookup(i, 'Divine Orb').div, 1);
  assert.ok(Math.abs(prices.lookup(i, 'exalted orb').div - 1 / 300) < 1e-9);
  assert.strictEqual(prices.lookup(i, 'Mirror of Kalandra').div, 900);
});

test('non-divine primary currency is converted', () => {
  const d = { core: { primary: 'exalted', rates: { divine: 1 / 300 }, items: [{ id: 'exalted', name: 'Exalted Orb' }] }, lines: [{ id: 'chaos', primaryValue: 150 }], items: [{ id: 'chaos', name: 'Chaos Orb' }] };
  const out = prices.parseExchange(d, 'Currency');
  assert.ok(Math.abs(out.find((x) => x.name === 'Chaos Orb').div - 0.5) < 1e-9);
});

test('uniques: uncorrupted copy wins; thin markets flagged', () => {
  const i = idx();
  assert.strictEqual(prices.lookup(i, 'Headhunter').div, 40);
  assert.strictEqual(prices.confidence(prices.lookup(i, 'Rare Thing')), 'low');
});

test('scan, rescan, changes, unreadable cells keep their old count', () => {
  const s = ledger.emptyState(); const i = idx();
  let ch = ledger.applyScan(s, 'currency', { 'Divine Orb': 10, 'Exalted Orb': 300, 'Chaos Orb': 4 }, [], i, 1000);
  assert.strictEqual(ch.length, 0); // first sighting is the baseline
  let v = ledger.valuate(s, i, 1000);
  assert.ok(Math.abs(v.total - 13) < 1e-9); // 10 + 1 + 2
  ch = ledger.applyScan(s, 'currency', { 'Divine Orb': 12, 'Exalted Orb': 300 }, ['Chaos Orb'], i, 2000);
  assert.deepStrictEqual(ch.map((c) => [c.name, c.delta, c.div]), [['Divine Orb', 2, 2]]);
  assert.strictEqual(s.tabs.currency.counts['Chaos Orb'], 4);
  v = ledger.valuate(s, i, 2000);
  assert.ok(Math.abs(v.total - 15) < 1e-9);
  assert.strictEqual(s.feed[0].name, 'Divine Orb');
});

test('unpriced items are listed, not guessed', () => {
  const s = ledger.emptyState();
  ledger.applyScan(s, 'essence', { 'Essence of Nothing': 3 }, [], idx());
  const v = ledger.valuate(s, idx());
  assert.strictEqual(v.total, 0); assert.strictEqual(v.unpriced, 1);
});

test('listings: market price for stacks and uniques, asking price otherwise, no double counting', () => {
  const s = ledger.emptyState(); const i = idx();
  ledger.applyScan(s, 'currency', { 'Divine Orb': 5 }, [], i);
  s.listings = { items: [
    { name: 'Divine Orb', isStack: true, stackSize: 5, priceDiv: 5 },       // same stack as the scanned tab: skipped
    { name: 'Chaos Orb', isStack: true, stackSize: 10, priceDiv: 3 },       // market: 10 * 0.5
    { name: 'Headhunter', rarity: 'Unique', priceDiv: 100 },                // market: 40
    { name: 'Doom Grip', rarity: 'Rare', priceDiv: 7 },                     // asking: 7
  ] };
  const v = ledger.valuate(s, i);
  assert.strictEqual(v.listings.skipped, 1);
  assert.ok(Math.abs(v.listings.value - (5 + 40 + 7)) < 1e-9);
  assert.ok(Math.abs(v.total - (5 + 52)) < 1e-9);
});

test('added items: ninja-priced follow the market, manual keep their price; hidden tabs excluded', () => {
  const s = ledger.emptyState(); const i = idx();
  s.items.push({ id: 'a', name: 'Headhunter', qty: 1, priceFrom: 'ninja', div: 10 }, { id: 'b', name: 'My rare', qty: 2, priceFrom: 'manual', div: 3 });
  ledger.applyScan(s, 'currency', { 'Divine Orb': 5 }, [], i);
  assert.ok(Math.abs(ledger.valuate(s, i).total - (40 + 6 + 5)) < 1e-9);
  s.hidden = { currency: true };
  assert.ok(Math.abs(ledger.valuate(s, i).total - 46) < 1e-9);
});

test('history, session profit per hour and 24h change', () => {
  const s = ledger.emptyState(); const H = 3600000;
  ledger.recordHistory(s, 100, 0);
  ledger.recordHistory(s, 100, 60000); // unchanged, too soon: no point
  ledger.recordHistory(s, 130, 2 * H);
  assert.strictEqual(s.history.length, 2);
  const st = ledger.sessionStats(s, 130, 2 * H);
  assert.strictEqual(st.gained, 30); assert.strictEqual(st.perHour, 15);
  ledger.recordHistory(s, 150, 30 * H);
  assert.strictEqual(ledger.changeSince(s, 150, 24 * H, 30 * H), 20);
});

test('first scans and hand edits are not profit; real changes are', () => {
  const s = ledger.emptyState(); const i = idx();
  ledger.recordHistory(s, 0, 0);
  // first scan of a tab: 10 div, booked as an adjustment by the caller
  ledger.applyScan(s, 'currency', { 'Divine Orb': 10 }, [], i, 1000);
  ledger.adjust(s, 10); ledger.recordHistory(s, 10, 1000);
  assert.strictEqual(ledger.sessionStats(s, 10, 1000).gained, 0);
  // farmed 3 more
  ledger.applyScan(s, 'currency', { 'Divine Orb': 13 }, [], i, 2000);
  ledger.recordHistory(s, 13, 2000);
  assert.strictEqual(ledger.sessionStats(s, 13, 2000).gained, 3);
  assert.strictEqual(ledger.changeSince(s, 13, 3600000, 2000), 3);
});
