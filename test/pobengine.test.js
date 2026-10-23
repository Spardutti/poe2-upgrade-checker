'use strict';

// Path of Building engines for both games, through pob/server.lua. Needs the vendored PoBs
// (node tools/get-pob.js) and a host for this OS; skipped when they aren't there.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createEngine } = require('../src/pobengine');

const ROOT = path.join(__dirname, '..');
const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const mk = (game) => createEngine({ log: () => {}, appPath: ROOT, packaged: false, game });
const e1 = mk('poe1'); const e2 = mk('poe2');
const skip1 = !e1.available() && 'Path of Building (PoE1) or its host is not installed here';
const skip2 = !e2.available() && 'Path of Building (PoE2) or its host is not installed here';
test.after(() => { e1.kill(); e2.kill(); });

const RING = 'Item Class: Rings\nRarity: Rare\nGale Loop\nTwo-Stone Ring\n--------\nRequirements:\nLevel: 66\n--------\nItem Level: 84\n--------\n+16% to Fire and Cold Resistances (implicit)\n--------\n+68 to maximum Life\n+42% to Fire Resistance\n+38% to Lightning Resistance\n+31% to Cold Resistance\n+25% to Chaos Resistance\n';
const JEWEL = 'Item Class: Jewels\nRarity: Rare\nStorm Spark\nCrimson Jewel\n--------\nItem Level: 84\n--------\n7% increased maximum Life\n+15% to Fire Resistance\n14% increased Global Physical Damage\n';

test('PoB1: loads a PoE1 build', { skip: skip1, timeout: 120000 }, async () => {
  const r = await e1.loadBuild(fx('pob1/berserker-3_29.xml'));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.game, 'poe1');
  assert.strictEqual(r.ascendancy, 'Berserker');
  assert.strictEqual(r.treeVersion, '3_29');
  assert.ok(r.stats.Life > 1000, 'life ' + r.stats.Life);
  assert.ok(r.stats.CombinedDPS > 0, 'dps ' + r.stats.CombinedDPS);
  assert.strictEqual(r.stats.Spirit, undefined); // no Spirit in PoE1
  assert.ok(r.stats.ManaUnreserved != null || r.stats.LifeUnreserved != null);
  assert.ok(r.gear['Body Armour'] && r.gear['Ring 1']);
});

test('PoB1: judges a ring and a jewel', { skip: skip1, timeout: 120000 }, async () => {
  const [ring, jewel] = await e1.evalItems([{ slot: 'Ring 1', text: RING }, { slot: 'Jewel', text: JEWEL }]);
  assert.strictEqual(ring.ok, true, ring.error);
  assert.ok(ring.after.FireResist != null && ring.before.Life > 0);
  assert.strictEqual(jewel.ok, true, jewel.error);
  assert.ok(jewel.multi.length >= 5, 'sockets ' + jewel.multi.length);
  assert.ok(jewel.multi.some((m) => m.replacingCluster), 'cluster sockets are marked');
});

test('PoB1: weighted trade search targets the PoE1 trade site', { skip: skip1, timeout: 120000 }, async () => {
  const q = await e1.makeQuery({ slot: 'Ring 1', weights: [{ stat: 'CombinedDPS', weightMult: 0.6 }, { stat: 'TotalEHP', weightMult: 0.4 }] });
  assert.strictEqual(q.ok, true, q.error);
  const s = JSON.stringify(q.query);
  assert.ok(/explicit\.stat_\d+/.test(s), 'has stat ids');
  assert.ok(q.modWeights.length > 3);
});

test('PoB1: a build on an old passive tree moves to the newest one', { skip: skip1, timeout: 120000 }, async () => {
  const r = await e1.loadBuild(fx('pob1/occultist-3_13.xml'));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.ascendancy, 'Occultist');
  assert.strictEqual(r.treeVersion, '3_29');
  assert.deepStrictEqual(r.treeConverted, { from: '3_13', to: '3_29' });
});

test('PoB1 refuses a PoE2 build, PoB2 a PoE1 build', { skip: skip1 || skip2, timeout: 120000 }, async () => {
  await assert.rejects(e1.loadBuild(fx('pob2-minimal.xml')), /Path of Building 2 build/);
  await assert.rejects(e2.loadBuild(fx('pob1/berserker-3_29.xml')), /Path of Exile 1/);
});

test('PoB2 still works next to PoB1', { skip: skip2, timeout: 120000 }, async () => {
  const r = await e2.loadBuild(fx('pob2-minimal.xml'));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.game, 'poe2');
});

test('PoB1: links per slot, bows drop a shield, newer trees and timeless jewels', { skip: skip1, timeout: 180000 }, async () => {
  const xml = fx('pob1/berserker-3_29.xml');
  let r = await e1.loadBuild(xml);
  assert.ok(r.slotGems && r.slotGems['Body Armour'] && r.slotGems['Body Armour'].gems >= 4, JSON.stringify(r.slotGems));
  assert.ok(r.gearTypes && r.gearTypes['Weapon 1'] && r.gearTypes['Weapon 1'].type, JSON.stringify(r.gearTypes));
  const BOW = 'Item Class: Bows\nRarity: Rare\nX\nThicket Bow\n--------\nItem Level: 80\n--------\n+40 to maximum Life\n';
  const [b] = await e1.evalItems([{ slot: 'Weapon 1', text: BOW }]);
  assert.strictEqual(b.ok, true, b.error);
  if (b.before.BlockChance > 0) assert.ok(!(b.after.BlockChance > 0), 'the shield should come off for a bow');
  // a build from a newer Path of Building
  r = await e1.loadBuild(xml.replace(/treeVersion="3_29"/g, 'treeVersion="3_99"'));
  assert.strictEqual(r.ok, true, r.error);
  assert.ok(r.treeConverted && r.treeConverted.newer, JSON.stringify(r.treeConverted));
  // a timeless jewel in a socket: left out, the build still loads
  const GV = 'Rarity: UNIQUE\nGlorious Vanity\nTimeless Jewel\nLimited to: 1 Historic\nRadius: Large\nImplicits: 0\nBathed in the blood of 1234 sacrificed in the name of Doryani\nPassives in radius are Conquered by the Vaal\nHistoric';
  const sock = (xml.match(/<Socket nodeId="(\d+)" itemId="0"\/>/) || [])[1];
  if (sock) {
    const withGv = xml.replace('</Items>', `<Item id="9999">\n${GV}\n</Item>\n</Items>`).replace(`<Socket nodeId="${sock}" itemId="0"/>`, `<Socket nodeId="${sock}" itemId="9999"/>`);
    r = await e1.loadBuild(withGv);
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.timelessRemoved, 1);
  }
});
