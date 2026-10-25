'use strict';

const test = require('node:test');
const assert = require('node:assert');
const BP = require('../src/core/buildplanner');
const D = require('../src/core/buildplanner-data.json');

// real ids from the data: a few passives, a skill and its supports, a unique
const ids = Object.keys(D.passives);
const gem = Object.entries(D.gems).find(([, g]) => !g.support && g.attr === 'int')[0];
const sup = Object.entries(D.gems).filter(([, g]) => g.support).slice(0, 2).map(([k]) => k);
const unique = Object.keys(D.uniques).find((n) => /Amulet/.test(D.uniques[n].split('\n')[1]));
const attrHash = D.attributeNodes[0];
const attrId = Object.keys(D.passives).find((k) => D.passives[k] === attrHash);

const LEVELLING = {
  name: 'Test guide', author: 'Someone', ascendancy: 'Sorceress3',
  passives: [ids[0], ids[1], { id: ids[2], level_interval: [1, 30] }, { id: ids[3], level_interval: [31, 100] }, { id: ids[4], weapon_set: 2 }, attrId, 'not_a_passive'],
  skills: [{ id: gem, support_skills: sup }, { id: 'Metadata/Items/Gems/NotAGem' }],
  inventory_slots: [{ inventory_id: 'Amulet1', unique_name: unique }, { inventory_id: 'Gloves1', additional_text: '<b>{Rare Gloves}</b>\nVaal Gloves\n1. +80 to maximum Life\n2. +40% to Fire Resistance' }, { inventory_id: 'Boots1', unique_name: 'Not A Unique' }],
};

test('.build: recognised, parsed, bad files refused', () => {
  assert.ok(BP.isBuildFile(JSON.stringify(LEVELLING)));
  assert.ok(!BP.isBuildFile('<PathOfBuilding2>'));
  assert.ok(!BP.isBuildFile('eNrtXd'));
  assert.throws(() => BP.parse('{nope'), /isn't valid JSON/);
  assert.throws(() => BP.parse('{"name":"x"}'), /no passives or skills/);
});

test('.build: levelling stages from the level intervals', () => {
  const st = BP.stages(LEVELLING);
  assert.deepStrictEqual(st.map((x) => [x.from, x.to]), [[1, 30], [31, 100]]);
  assert.deepStrictEqual(st.map((x) => x.label), ['Levels 1–30', 'Level 31+']);
  assert.deepStrictEqual(BP.stages({ passives: ['a'] }).map((x) => x.label), ['The build']);
});

test('.build -> Path of Building: the stage\'s passives, weapon sets, skills, guide gear and a report', () => {
  const early = BP.toPob(BP.parse(JSON.stringify(LEVELLING)), { level: 20 });
  const late = BP.toPob(BP.parse(JSON.stringify(LEVELLING)), { level: 90 });
  const nodes = (x) => x.xml.match(/ nodes="([^"]*)"/)[1].split(',').map(Number);
  assert.ok(nodes(early).includes(D.passives[ids[2]]) && !nodes(early).includes(D.passives[ids[3]]));
  assert.ok(nodes(late).includes(D.passives[ids[3]]) && !nodes(late).includes(D.passives[ids[2]]));
  assert.match(late.xml, new RegExp(`<WeaponSet2 nodes="${D.passives[ids[4]]}"/>`));
  assert.match(late.xml, /classInternalId="7" ascendancyInternalId="Sorceress3"/);
  assert.match(late.xml, /ascendClassName="Disciple of Varashta"/);
  assert.match(late.xml, new RegExp(`targetVersion="${D.targetVersion}"`));
  // skills: top level at the end, lower early; supports at 1
  assert.match(late.xml, new RegExp(`gemId="${gem}"[^>]*level="${D.gems[gem].max}"`));
  assert.match(early.xml, new RegExp(`gemId="${gem}"[^>]*level="6"`)); // levels 1-30: about level 6
  assert.strictEqual(late.report.gems.skills, 1);
  // attribute passives follow the gems' colours (an int skill: Intelligence)
  assert.match(late.xml, new RegExp(`intNodes="[^"]*${attrHash}`));
  assert.ok(late.report.notes.some((n) => /any attribute/.test(n)));
  // gear: the unique by name (newest variant), the guide's rare from its text, the unknown unique reported
  assert.match(late.xml, new RegExp(`Rarity: UNIQUE\\n${unique.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(late.xml, /Rarity: RARE\nGuide Vaal Gloves\nVaal Gloves\n\+80 to maximum Life\n\+40% to Fire Resistance/);
  assert.ok(late.report.missing.some((m) => /Not A Unique/.test(m)) && late.report.missing.some((m) => /1 passive/.test(m)) && late.report.missing.some((m) => /1 gem/.test(m)));
  assert.match(BP.summary(late.report), /passives, 1 skill with 2 supports, the guide's Amulet, Gloves/);
});

test('.build: your own copied items keep their slots', () => {
  const r = BP.toPob(BP.parse(JSON.stringify(LEVELLING)), { level: 90, have: { Gloves: true, Amulet: true } });
  assert.ok(!/Vaal Gloves/.test(r.xml) && !/Rarity: UNIQUE/.test(r.xml));
  assert.deepStrictEqual(r.report.gear, []);
});

test('.build: ascendancy by name, class alone, unknown refused', () => {
  const base = { passives: [ids[0]], skills: [] };
  assert.match(BP.toPob({ ...base, ascendancy: 'Infernalist' }).xml, /ascendancyInternalId="Witch1"/);
  assert.match(BP.toPob({ ...base, ascendancy: 'Monk' }).xml, /className="Monk" ascendClassName="None"/);
  assert.throws(() => BP.toPob({ ...base, ascendancy: 'Plumber' }), /Unknown ascendancy/);
});

test('.build: a guide rare from text, not from a sentence', () => {
  assert.deepStrictEqual(BP.rareFromText('Sapphire Ring\n- +40% to Cold Resistance\n• +60 to maximum Life'), { base: 'Sapphire Ring', mods: ['+40% to Cold Resistance', '+60 to maximum Life'] });
  assert.strictEqual(BP.rareFromText('Get a ring with resistances, life is nice too'), null);
});
