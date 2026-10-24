'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/core/searchstr');
const { keyOf } = require('../src/core/mapcheck');

test('map avoid string: one short distinctive word per mod, within the limit', () => {
  const mods = ['Monsters reflect 18% of Elemental Damage', 'Players cannot Regenerate Life, Mana or Energy Shield', 'Rare Monsters have Elemental Thorns'];
  const r = S.mapAvoid(mods.map(keyOf));
  assert.equal(r.text, '"!reflect|regener|thorns"');
  assert.ok(r.length <= S.LIMIT);
});

test('strings never go over the limit; what is left is reported', () => {
  const many = ['reflect', 'regenerate', 'thorns', 'ailments', 'projectiles', 'temporal', 'vulnerability', 'enfeeble', 'blinded', 'hexproof', 'curses'].map((w) => `monsters have ${w}`);
  const r = S.mapAvoid(many);
  assert.ok(r.text.length <= S.LIMIT);
  assert.ok(r.left.length > 0);
});

test('vendor string', () => {
  assert.equal(S.vendor({ move: true, res: ['fire'] }).text, '"movement sp|fire res"');
  assert.equal(S.vendor({ links: true, game: 'poe2' }).text, ''); // no links in PoE2
  assert.ok(S.vendor({ links: true, game: 'poe1' }).text.includes('-\\w-.-'));
});
