'use strict';
const test = require('node:test');
const assert = require('node:assert');
const V = require('../src/core/pobverdict');

const base = {
  FullDPS: 0, MinionDPS: 100000, TotalEHP: 50000, EnergyShield: 13000, SpiritUnreserved: 50,
  FireResist: 75, FireResistTotal: 78, FireResistOverCap: 3, FireResistMax: 75,
  ColdResist: 75, ColdResistTotal: 96, ColdResistOverCap: 21, ColdResistMax: 75,
  LightningResist: 75, LightningResistTotal: 83, LightningResistOverCap: 8, LightningResistMax: 75,
  ChaosResist: 0, ChaosResistTotal: 0, Int: 300, ReqInt: 160, Str: 77, ReqStr: 75,
};

test('minion builds are judged on minion DPS and effective HP', () => {
  const j = V.judge(base, { ...base, MinionDPS: 105000, TotalEHP: 51000 });
  assert.strictEqual(j.dpsKey, 'MinionDPS');
  assert.strictEqual(j.dps.pct, 5);
  assert.strictEqual(j.ehp.pct, 2);
  assert.strictEqual(j.score, 3.8); // 0.6 * 5 + 0.4 * 2
  assert.strictEqual(j.verdict, 'upgrade');
});

test('a resistance falling off the cap is never a clean upgrade', () => {
  const after = { ...base, MinionDPS: 110000, LightningResist: 38, LightningResistTotal: 38, LightningResistOverCap: 0, LightningResistMax: undefined };
  const j = V.judge(base, after);
  // its own verdict, whatever the damage, and last when sorting
  assert.strictEqual(j.verdict, 'resloss');
  assert.strictEqual(j.resRank, -1);
  assert.ok(j.score < 0, 'losing 37 res outweighs +10% damage with resistances first');
  assert.ok(j.breaks.some((b) => /Lightning res drops off the cap/.test(b)));
  assert.strictEqual(V.judge(base, after, { priorities: { resFirst: false } }).verdict, 'resloss');
  // capping one ranks first
  const short = { ...base, LightningResist: 38, LightningResistTotal: 38, LightningResistOverCap: 0, LightningResistMax: undefined };
  const capj = V.judge(short, base);
  assert.strictEqual(capj.resRank, 2);
  assert.deepStrictEqual(capj.resCapped, ['Lightning']);
});

test('Spirit and attribute shortfalls break the build', () => {
  assert.ok(V.judge(base, { ...base, MinionDPS: 120000, SpiritUnreserved: -10 }).breaks.some((b) => /Spirit/.test(b)));
  const j = V.judge(base, { ...base, MinionDPS: 120000, Str: 60 });
  assert.ok(j.breaks.some((b) => /Strength/.test(b)) && j.verdict === 'risky');
  assert.strictEqual(V.judge(base, { ...base, MinionDPS: 90000 }).verdict, 'dmgloss');
  assert.strictEqual(V.judge(base, { ...base, MinionDPS: 96000 }).verdict, 'downgrade');
});

test('small changes are sidegrades; best() prefers no breaks', () => {
  assert.strictEqual(V.judge(base, { ...base, MinionDPS: 100500 }).verdict, 'same');
  const a = V.judge(base, { ...base, MinionDPS: 130000, SpiritUnreserved: -5 });
  const b = V.judge(base, { ...base, MinionDPS: 104000 });
  assert.strictEqual(V.best([a, b]), b);
});

test('any build: Full DPS when PoB adds skills up, else the main skill', () => {
  assert.strictEqual(V.dpsKey({ FullDPS: 5000, MinionDPS: 0, CombinedDPS: 4000 }), 'FullDPS');
  assert.strictEqual(V.dpsKey({ FullDPS: 0, MinionDPS: 0, CombinedDPS: 4000 }), 'CombinedDPS');
  const j = V.judge({ FullDPS: 0, CombinedDPS: 4000, TotalEHP: 9000 }, { FullDPS: 0, CombinedDPS: 4400, TotalEHP: 9000 });
  assert.strictEqual(j.dpsKey, 'CombinedDPS');
  assert.strictEqual(j.dps.pct, 10);
  assert.strictEqual(j.verdict, 'upgrade');
});

test('priorities: capping resistances first, and switching checks off', () => {
  const short = { ...base, LightningResist: 38, LightningResistTotal: 38, LightningResistOverCap: 0, LightningResistMax: undefined };
  // +37 lightning to the cap, a little less minion DPS
  const fill = { ...short, LightningResist: 75, LightningResistTotal: 77, LightningResistOverCap: 2, LightningResistMax: 75, MinionDPS: 98000 };
  const dps = { ...short, MinionDPS: 110000 };
  const a = V.judge(short, fill); const b = V.judge(short, dps);
  assert.strictEqual(a.resGain, 37);
  assert.ok(a.score > b.score, `${a.score} vs ${b.score}`);
  const off = { priorities: { resFirst: false } };
  assert.ok(V.judge(short, fill, off).score < V.judge(short, dps, off).score);
  // Spirit check off: not a break any more
  assert.strictEqual(V.judge(base, { ...base, MinionDPS: 120000, SpiritUnreserved: -10 }, { priorities: { spirit: false } }).breaks.length, 0);
  // chaos only counts when asked
  const ch = { ...base, ChaosResist: 20, ChaosResistTotal: 20 };
  assert.strictEqual(V.judge(base, ch).resGain, 0);
  assert.strictEqual(V.judge(base, ch, { priorities: { chaos: true } }).resGain, 20);
});

test('Chaos Inoculation: chaos resistance is ignored completely', () => {
  const ci = { ...base, Life: 1, ChaosResist: 75, ChaosResistTotal: 80 };
  assert.ok(V.hasCI(ci) && !V.hasCI(base));
  const after = { ...ci, ChaosResist: 0, ChaosResistTotal: 0, MinionDPS: 110000 };
  const j = V.judge(ci, after, { ignoreChaos: true, priorities: { chaos: true } });
  assert.strictEqual(j.verdict, 'upgrade');
  assert.strictEqual(j.res.length, 0);
  assert.strictEqual(V.judge(ci, after).verdict, 'resloss'); // without CI it would count (it was capped)
});

test('an item that costs a big part of your minion damage is LOSES DAMAGE, even if it caps a resistance', () => {
  const base = { MinionDPS: 96800, TotalEHP: 53000, FireResist: 78, ColdResist: 75, LightningResist: 38, ChaosResist: 0, Life: 1 };
  const after = { ...base, MinionDPS: 77340, TotalEHP: 67700, LightningResist: 75 };
  const j = V.judge(base, after, { ignoreChaos: true });
  assert.strictEqual(j.verdict, 'dmgloss');
  assert.strictEqual(j.resRank, -1);
  assert.ok(j.dmgLoss && j.dmgLoss.minion && j.dmgLoss.pct < -19);
  // a small damage dip is still judged on the score
  assert.notStrictEqual(V.judge(base, { ...after, MinionDPS: 95000 }, { ignoreChaos: true }).verdict, 'dmgloss');
  // switched off: back to the old score-based verdict
  assert.notStrictEqual(V.judge(base, after, { ignoreChaos: true, priorities: { keepDmg: false } }).verdict, 'dmgloss');
});

test('pob verdict: no damage now, the new item adds minion damage: counts it, same number both sides', () => {
  const V = require('../src/core/pobverdict');
  const j = V.judge({ FullDPS: 0, MinionDPS: 0, TotalDPS: 0, TotalEHP: 1000 }, { FullDPS: 0, MinionDPS: 5000, TotalDPS: 0, TotalEHP: 1000 });
  assert.strictEqual(j.dpsKey, 'MinionDPS');
  assert.ok(j.score > 0);
  assert.strictEqual(j.noDamage, false);
});

test('pob verdict: a main skill with no damage on both sides is flagged', () => {
  const V = require('../src/core/pobverdict');
  const j = V.judge({ TotalDPS: 0, TotalEHP: 1000 }, { TotalDPS: 0, TotalEHP: 1100 });
  assert.strictEqual(j.noDamage, true);
});
