#!/usr/bin/env node
'use strict';
// Starts the bundled Path of Building engine, loads a minimal build and judges one item.
// Run by the release build on Windows (after get-pob.js) so a broken engine never ships.
const path = require('path');
const { createEngine } = require('../src/pobengine');

const eng = createEngine({ log: (m) => console.log(m), appPath: path.join(__dirname, '..'), packaged: false });
const XML = '<?xml version="1.0" encoding="UTF-8"?><PathOfBuilding2><Build level="90" className="Sorceress" ascendClassName="None" mainSocketGroup="1"/></PathOfBuilding2>';
const ITEM = 'Item Class: Gloves\nRarity: Rare\nSmoke Test\nVaal Gloves\n--------\nItem Level: 80\n--------\n+40 to maximum Life\n+30% to Cold Resistance';

(async () => {
  if (!eng.available()) throw new Error('engine files missing (run node tools/get-pob.js first)');
  const t0 = Date.now();
  const info = await eng.loadBuild(XML);
  if (!info || !info.ok) throw new Error('build did not load');
  const [r] = await eng.evalItems([{ slot: 'Gloves', text: ITEM }]);
  if (!r || !r.ok || !(r.after.ColdResistTotal > r.before.ColdResistTotal)) throw new Error('item was not judged: ' + JSON.stringify(r).slice(0, 300));
  const sh = await eng.sheet();
  if (!sh || !sh.ok || !sh.player || !Array.isArray(sh.res) || !sh.tree) throw new Error('character sheet missing parts: ' + JSON.stringify(sh).slice(0, 300));
  console.log(`Path of Building engine OK (${Date.now() - t0} ms): cold res ${r.before.ColdResistTotal} -> ${r.after.ColdResistTotal}`);
  eng.kill();
  process.exit(0);
})().catch((err) => { console.error('Path of Building engine FAILED: ' + err.message); eng.kill(); process.exit(1); });
