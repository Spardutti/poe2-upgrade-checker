'use strict';
const test = require('node:test');
const assert = require('node:assert');
const K = require('../src/core/keepsell');

const base = (over) => ({ ok: true, unit: 'ex', ui: { divineRate: 300 }, item: { rarity: 'Rare', name: 'Doom Grip', itemClass: 'Gloves' }, verdict: 'downgrade', ...over });

test('keepsell: upgrades are kept', () => {
  assert.strictEqual(K.advise(base({ verdict: 'upgrade' })).action, 'keep');
  assert.strictEqual(K.advise(base({ verdict: 'risky' })).action, 'keep');
  assert.strictEqual(K.advise(base({ verdict: 'upgrade', isEquipped: true })), null);
});
test('keepsell: not an upgrade: sell or vendor by price', () => {
  assert.strictEqual(K.advise(base({ worthEx: 40 })).action, 'sell');
  assert.strictEqual(K.advise(base({ worthEx: 2 })).action, 'vendor');
  assert.match(K.advise(base({ worthEx: 600 })).text, /2 div/);
  assert.strictEqual(K.advise(base({})).action, 'check');
  assert.strictEqual(K.advise(base({ item: { rarity: 'Magic' } })).action, 'vendor');
  assert.strictEqual(K.advise(base({ pobPending: true })), null);
  assert.strictEqual(K.advise(base({ verdict: 'unjudged' })), null);
});
test('keepsell: poe.ninja prices, and PoE1 chaos without a divine rate', () => {
  const u = { rarity: 'Unique', name: 'Headhunter', itemClass: 'Belts' };
  assert.strictEqual(K.advise(base({ item: u, ninja: { eachDiv: 0.5, unit: 'ex' } })).action, 'sell');
  assert.strictEqual(K.advise(base({ item: u, unit: 'chaos', ui: {}, ninja: { each: 1, unit: 'chaos' } })).action, 'vendor');
  assert.strictEqual(K.advise(base({ item: u, unit: 'chaos', ui: {}, ninja: { each: 7, unit: 'chaos' } })).action, 'sell');
  assert.strictEqual(K.advise(base({ item: u })).action, 'check');
  // currency gets no advice
  assert.strictEqual(K.advise({ ok: true, kind: 'price', unit: 'ex', item: { itemClass: 'Stackable Currency' }, ninja: { each: 1, unit: 'ex' } }), null);
});

test('keepsell: a stack is valued whole; unjudged PoE1 flasks get no advice', () => {
  const card = { ok: true, kind: 'price', unit: 'chaos', ui: {}, item: { rarity: 'Normal', itemClass: 'Divination Cards', name: 'Rain of Chaos' }, ninja: { each: 1, unit: 'chaos', stack: 10 } };
  assert.strictEqual(K.advise(card).action, 'sell');
  assert.strictEqual(K.advise({ ...card, ninja: { each: 1, unit: 'chaos', stack: 2 } }).action, 'vendor');
  assert.strictEqual(K.advise(base({ verdict: 'new', item: { rarity: 'Magic', slot: 'Flask' } })), null);
  assert.strictEqual(K.advise(base({ verdict: 'upgrade', item: { rarity: 'Magic', slot: 'Flask' }, pob: {} })).action, 'keep');
});

test('a gem better than the one in your build is a keep', () => {
  const ks = require('../src/core/keepsell.js');
  const r = { ok: true, kind: 'price', item: { name: 'Perforate', itemClass: 'Skill Gems', rarity: 'Gem' }, ninja: { each: 1, unit: 'chaos' },
    gem: { hits: [{ group: 'Perforate', level: 20, quality: 20, newLevel: 21, newQuality: 20, verdict: 'upgrade' }] } };
  assert.equal(ks.advise(r).action, 'keep');
  r.gem.hits[0].verdict = 'same';
  assert.notEqual((ks.advise(r) || {}).action, 'keep');
});

test('sell note: a little under poe.ninja, divines when worth one', () => {
  const n = require('../src/core/ninja.js');
  assert.equal(n.sellNote({ total: 900, totalDiv: 4.3, unit: 'chaos', stack: 1 }).note, '~price 4 divine');
  assert.equal(n.sellNote({ total: 150, totalDiv: 0.8, unit: 'chaos', stack: 1 }).note, '~price 143 chaos');
  assert.equal(n.sellNote({ total: 12, totalDiv: 0.05, unit: 'ex', stack: 20 }).note, '~price 11 exalted');
  assert.equal(n.sellNote({ total: 0.4, totalDiv: 0.001, unit: 'ex', stack: 1 }), null);
});
