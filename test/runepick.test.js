'use strict';

const test = require('node:test');
const assert = require('node:assert');
const RP = require('../src/core/runepick');

const before = { FullDPS: 100, TotalEHP: 1000 };
// a judge like PoB's verdict: the score is the % gain; "breaks" when life goes under 500
const judge = (a, b) => ({ score: ((b.FullDPS - a.FullDPS) / a.FullDPS) * 100 * 0.6 + ((b.TotalEHP - a.TotalEHP) / a.TotalEHP) * 100 * 0.4, verdict: 'x', breaks: b.TotalEHP < 500 ? ['too squishy'] : [], dps: { pct: (b.FullDPS - a.FullDPS) }, ehp: { pct: (b.TotalEHP - a.TotalEHP) / 10 } });
const check = {
  before,
  slots: [
    { slot: 'Helmet', item: 'Gale Halo', sockets: 2, current: ['Desert Rune', 'None'], results: [
      { socket: 1, rune: 'Iron Rune', type: 'Rune', after: { FullDPS: 100, TotalEHP: 1100 } },
      { socket: 1, rune: 'Glass Rune', type: 'Rune', after: { FullDPS: 150, TotalEHP: 400 } },
      { socket: 2, rune: 'Soul Core of Tacati', type: 'SoulCore', after: { FullDPS: 110, TotalEHP: 1000 } },
      { socket: 2, rune: 'Noise Rune', type: 'Rune', after: { FullDPS: 100.01, TotalEHP: 1000 } },
    ] },
    { slot: 'Boots', item: 'Oblivion Trail', sockets: 1, added: true, current: ['None'], results: [
      { socket: 1, rune: 'Bad Rune', after: { FullDPS: 90, TotalEHP: 990 } },
    ] },
  ],
};

test('runes: ranked per socket, nothing that breaks the build is picked, noise isn\'t a gain', () => {
  const r = RP.rank(check, judge);
  assert.strictEqual(r.length, 3);
  const [h1, h2, b1] = r;
  assert.strictEqual(h1.current, 'Desert Rune');
  assert.strictEqual(h1.best.rune, 'Iron Rune', 'Glass Rune scores more but breaks the build');
  assert.strictEqual(h1.options[0].rune, 'Iron Rune');
  assert.strictEqual(h2.best.rune, 'Soul Core of Tacati');
  assert.strictEqual(b1.best, null, 'a rune that only loses isn\'t picked');
  assert.ok(b1.added);
  assert.deepStrictEqual(RP.picks(r), [{ slot: 'Helmet', socket: 1, rune: 'Iron Rune' }, { slot: 'Helmet', socket: 2, rune: 'Soul Core of Tacati' }]);
});

test('runes: best value for money first, unknown prices last', () => {
  const r = RP.rank(check, judge);
  const shop = RP.shoppingList(r, (n) => (n === 'Iron Rune' ? { eachDiv: 0.01 } : n === 'Soul Core of Tacati' ? { eachDiv: 5 } : null));
  assert.deepStrictEqual(shop.map((x) => x.rune), ['Iron Rune', 'Soul Core of Tacati']);
  const shop2 = RP.shoppingList(r, (n) => (n === 'Soul Core of Tacati' ? { eachDiv: 1 } : null));
  assert.deepStrictEqual(shop2.map((x) => x.rune), ['Soul Core of Tacati', 'Iron Rune']);
});

test('runes: an unnamed rune is worked out from what it does, and what it gives is shown', () => {
  const bare = { FullDPS: 100, TotalEHP: 900 };
  const now = { FullDPS: 100, TotalEHP: 1000 };
  const c = { before: now, slots: [{ slot: 'Helmet', item: 'Gale Halo', sockets: 1, unknown: true, current: ['?'], bare, runeLines: ['20% increased Armour (rune)'], results: [
    { socket: 1, rune: 'Rabbit Idol', lines: ['12% increased Rarity of Items found'], after: { ...now } },
    { socket: 1, rune: 'Iron Rune', lines: ['20% increased Armour', 'Bonded: something else'], after: { FullDPS: 100, TotalEHP: 950 } },
    { socket: 1, rune: 'Better Rune', lines: ['+30 to maximum Life'], after: { FullDPS: 100, TotalEHP: 1200 } },
  ] }] };
  const [h] = RP.rank(c, judge);
  assert.ok(h.guessed && !h.unknown);
  assert.strictEqual(h.current, 'Iron Rune', 'named by its mod line, not by a rune that changes nothing PoB counts');
  assert.strictEqual(h.best.rune, 'Better Rune');
  assert.ok(h.yours && h.yours.ehpPct > 0, JSON.stringify(h.yours));
  assert.ok(!h.options.some((o) => o.rune === 'Iron Rune'), 'your own rune isn\'t offered as an upgrade');
});
