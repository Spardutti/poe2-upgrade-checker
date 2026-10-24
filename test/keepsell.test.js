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
