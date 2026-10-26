'use strict';

const test = require('node:test');
const assert = require('node:assert');
const MM = require('../src/core/monstermods');
const MC = require('../src/core/mapcheck');
const { parseItem } = require('../src/core/parser');

test('monster mods: what they add to Path of Building\'s enemy', () => {
  assert.deepStrictEqual(MM.parse('Monsters deal 30% of Damage as Extra Fire').mods, [{ name: 'DamageGainAsFire', type: 'BASE', value: 30 }]);
  assert.deepStrictEqual(MM.parse('40% increased Monster Damage').mods, [{ name: 'Damage', type: 'INC', value: 40 }]);
  assert.deepStrictEqual(MM.parse('Monster Damage Penetrates 15% Elemental Resistances').pen, { Fire: 15, Cold: 15, Lightning: 15 });
  assert.deepStrictEqual(MM.parse('Monsters have 30% increased Critical Hit Chance').mods[0], { name: 'CritChance', type: 'INC', value: 30 });
  assert.strictEqual(MM.parse('+25% to Monster Elemental Resistances').kind, 'tough');
  assert.strictEqual(MM.parse('30% more Monster Life').life, 30);
  assert.strictEqual(MM.parse('Players have 10% reduced Maximum Life'), null, 'player mods are worked out as player mods');
  assert.strictEqual(MM.parse('Area contains 2 additional Strongboxes'), null);
  const list = MM.enemyList(['Monsters deal 30% of Damage as Extra Fire', '30% more Monster Life', 'Players are Cursed with Enfeeble']);
  assert.deepStrictEqual(list.map((x) => x.text), ['Monsters deal 30% of Damage as Extra Fire'], 'life alone isn\'t sent: Path of Building doesn\'t use it');
});

test('map check: monster mods judged on max hit and how long you last; waystone and tablet groups', () => {
  const before = { TotalEHP: 10000, FireMaximumHitTaken: 4000, ColdMaximumHitTaken: 5000, PhysicalMaximumHitTaken: 3000, LightningMaximumHitTaken: 4500, EHPSurvivalTime: 10, FullDPS: 1000 };
  const after = { ...before, FireMaximumHitTaken: 2500, PhysicalMaximumHitTaken: 2000, EHPSurvivalTime: 6 };
  const e = MC.pobEffect(before, after);
  assert.match(e.text, /biggest hit you survive -33.3%/);
  assert.match(e.text, /you last 40% less long/);
  assert.strictEqual(e.level, 'danger');
  const way = parseItem('Item Class: Waystones\nRarity: Rare\nDark Ascent\nWaystone (Tier 15)\n--------\nWaystone Tier: 15\n--------\nItem Level: 80\n--------\nPlayers have 10% reduced Maximum Life\nMonsters deal 30% of Damage as Extra Fire\n30% more Monster Life\n25% increased Rarity of Items found in this Area');
  const pob = { before, results: [{ text: 'Monsters deal 30% of Damage as Extra Fire', monster: true, after }] };
  const c = MC.check(way, pob, {});
  assert.deepStrictEqual(c.groups.map((g) => g.cat), ['you', 'danger', 'tough', 'loot']);
  const fire = c.rows.find((r) => /Extra Fire/.test(r.text));
  assert.ok(fire.calculated && fire.level === 'danger' && /biggest hit/.test(fire.note), JSON.stringify(fire));
  assert.match(c.rows.find((r) => /Monster Life/.test(r.text)).note, /30% longer to kill/);
  assert.strictEqual(c.extraLife, 30);
  const tab = parseItem('Item Class: Tablet\nRarity: Magic\nChallenger\'s Expedition Tablet of Knowledge\n--------\nItem Level: 65\n--------\nAdds a Kalguuran Expedition to a Map (implicit)\n10 uses remaining (implicit)\n--------\n24% increased Quantity of Expedition Logbooks dropped by Runic Monsters in Map\nMonsters have 14% increased Effectiveness');
  assert.ok(MC.isMap(tab) && MC.isTablet(tab));
  const t = MC.check(tab, null, {});
  assert.strictEqual(t.uses, 10);
  assert.ok(!t.rows.some((r) => /uses remaining/.test(r.text)));
  assert.deepStrictEqual(t.groups.map((g) => g.cat), ['tough', 'loot', 'content']);
});

// wordings from the trade site's own stat list (GGG), numbers filled in
test('real waystone and tablet wordings land in the right group', () => {
  const want = {
    'Monster Damage penetrates 12% of Cold Resistance': 'danger',
    'Monsters have 30% Critical Damage Bonus': 'danger',
    'Monsters fire 2 additional Projectiles': 'danger',
    'Monsters take 20% reduced Extra Damage from Critical Hits': 'tough',
    'Monsters gain 20% of maximum Life as Extra maximum Energy Shield': 'tough',
    '20% less effect of Curses on Monsters': 'tough',
    'Map has 20% increased number of Rare Monsters': 'monsters',
    'Area contains 2 additional packs of Vaal Monsters': 'monsters',
    'Map Bosses have 1 additional Modifier': 'boss',
    '20% increased Rarity of Items found in Map': 'loot',
    '20% increased Quantity of Breach Splinters dropped by Breach Monsters in Map': 'loot',
    'Breaches in Map open and close 20% faster': 'content',
    'Delirium Fog in Map applies 20% increased Deliriousness to Players': 'you',
    'Players are periodically Cursed with Enfeeble': 'you',
  };
  for (const [t, c] of Object.entries(want)) assert.strictEqual(MC.category(t), c, t);
  assert.deepStrictEqual(MM.parse('Monster Damage penetrates 12% of Cold Resistance').pen, { Cold: 12 });
  assert.deepStrictEqual(MM.parse('Monsters take 20% reduced Extra Damage from Critical Hits').mods, [{ name: 'SelfCritMultiplier', type: 'INC', value: -20 }]);
  assert.strictEqual(MM.parse('Monsters gain 20% of maximum Life as Extra maximum Energy Shield').life, 20);
  const tab = parseItem('Item Class: Tablet\nRarity: Magic\nBreach Tablet of the Hive\n--------\nItem Level: 70\n--------\nAdds an Otherworldy Breach to a Map (implicit)\n8 uses remaining (implicit)\n--------\nBreaches in Map spawn 20% increased Magic Monsters\n20% increased Quantity of Breach Splinters dropped by Breach Monsters in Map');
  const c = MC.check(tab, null, {});
  assert.strictEqual(c.summary.adds, 'Otherworldy Breach');
  assert.match(c.summary.text, /1 for more loot/);
});
