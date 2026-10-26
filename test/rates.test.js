'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { divineInExalts, ninjaUrls } = require('../src/core/rates');

test('documented shape, primary = exalted', () => {
  const data = {
    core: { primary: 'exalted', secondary: 'divine', rates: { divine: 0.0066 }, items: [{ id: 'divine', name: 'Divine Orb' }, { id: 'exalted', name: 'Exalted Orb' }] },
    lines: [{ id: 'divine', primaryValue: 152.3 }, { id: 'chaos', primaryValue: 8 }],
  };
  assert.equal(divineInExalts(data), 152.3);
});

test('documented shape using only rates', () => {
  const data = { core: { primary: 'exalted', rates: { divine: 0.005 } }, lines: [] };
  assert.equal(divineInExalts(data), 200);
});

test('older shape, primary = chaos', () => {
  const data = {
    core: { version: 1 },
    items: [{ id: 'divine', name: 'Divine Orb' }, { id: 'exalted', name: 'Exalted Orb' }],
    lines: [{ id: 'divine', primaryValue: 30 }, { id: 'exalted', primaryValue: 0.2 }],
  };
  assert.equal(divineInExalts(data), 150);
});

test('ids found by item name', () => {
  const data = {
    core: { primary: 'ex', items: [{ id: 'div2', name: 'Divine Orb' }, { id: 'ex', name: 'Exalted Orb' }] },
    lines: [{ id: 'div2', primaryValue: 99 }],
  };
  assert.equal(divineInExalts(data), 99);
});

test('garbage in, null out', () => {
  assert.equal(divineInExalts(null), null);
  assert.equal(divineInExalts({ lines: [] }), null);
  assert.equal(divineInExalts({ core: { primary: 'exalted' }, lines: [{ id: 'divine', primaryValue: 0.5 }] }), null);
  assert.match(ninjaUrls('Rise of the Abyssal')[0], /league=Rise%20of%20the%20Abyssal&type=Currency$/);
});

test('chaos orbs are found by name too, for prices in chaos', () => {
  const R = require('../src/core/rates');
  const out = R.currencyRatesInExalts({ core: { primary: 'exalted', items: [{ id: 'chaos-orb', name: 'Chaos Orb' }, { id: 'divine', name: 'Divine Orb' }] }, lines: [{ id: 'chaos-orb', primaryValue: 15 }, { id: 'divine', primaryValue: 700 }] });
  assert.strictEqual(out.chaos, 15);
  assert.strictEqual(out.divine, 700);
});
