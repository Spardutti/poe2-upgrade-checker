'use strict';

const test = require('node:test');
const assert = require('node:assert');
const T = require('../src/core/trade');

// Shaped like /api/trade2/data/stats
const STATS = { result: [
  { id: 'pseudo', label: 'Pseudo', entries: [
    { id: 'pseudo.pseudo_total_life', text: '+# total maximum Life', type: 'pseudo' },
    { id: 'pseudo.pseudo_total_fire_resistance', text: '+#% total to Fire Resistance', type: 'pseudo' },
  ] },
  { id: 'explicit', label: 'Explicit', entries: [
    { id: 'explicit.stat_life', text: '+# to maximum Life', type: 'explicit' },
    { id: 'explicit.stat_fire', text: '+#% to Fire Resistance', type: 'explicit' },
    { id: 'explicit.stat_armour_local', text: '#% increased Armour (Local)', type: 'explicit' },
    { id: 'explicit.stat_armour', text: '#% increased Armour', type: 'explicit' },
    { id: 'explicit.stat_ms', text: '#% increased Movement Speed', type: 'explicit' },
  ] },
] };

const FILTERS = { result: [{ id: 'type_filters', filters: [{ id: 'category', option: { options: [
  { id: null, text: 'Any' }, { id: 'armour.helmet', text: 'Helmet' }, { id: 'weapon.twomace', text: 'Two Hand Mace' },
  { id: 'weapon.warstaff', text: 'Quarterstaff' },
] } }] }] };

const idx = T.buildStatIndex(STATS);

test('prefers pseudo stats for life and res', () => {
  assert.equal(T.matchStat('# to maximum Life', idx).id, 'pseudo.pseudo_total_life');
  assert.equal(T.matchStat('#% to Fire Resistance', idx).id, 'pseudo.pseudo_total_fire_resistance');
  assert.equal(T.matchStat('#% increased Movement Speed', idx).id, 'explicit.stat_ms');
  assert.equal(T.matchStat('nonsense #', idx), null);
});

test('local vs global mods', () => {
  assert.equal(T.matchStat('#% increased Armour', idx, { preferLocal: true }).id, 'explicit.stat_armour_local');
  assert.equal(T.matchStat('#% increased Armour', idx, { preferLocal: false }).id, 'explicit.stat_armour');
});

test('categories from filters data and fallback', () => {
  assert.equal(T.categoryFor('Helmets', FILTERS), 'armour.helmet');
  assert.equal(T.categoryFor('Two Hand Maces', FILTERS), 'weapon.twomace');
  assert.equal(T.categoryFor('Quarterstaves', FILTERS), 'weapon.warstaff');
  assert.equal(T.categoryFor('Boots', null), 'armour.boots');
});

test('buildUpgradeQuery uses weighted sum above current item', () => {
  const item = { itemClass: 'Helmets', stats: { '# to maximum Life': 50, '#% to Fire Resistance': 20, '[Base] Armour': 300 } };
  const weights = { '# to maximum Life': 1, '#% to Fire Resistance': 1.5, '[Base] Armour': 0.05, 'unknown stat #': 2 };
  const { body, currentScore, groupMin } = T.buildUpgradeQuery(item, weights, { statIndex: idx, filtersData: FILTERS });
  assert.equal(currentScore, 80);
  assert.equal(groupMin, 81);
  const g = body.query.stats[0];
  assert.equal(g.type, 'weight');
  assert.deepEqual(g.value, { min: 81 });
  assert.deepEqual(g.filters.map((f) => [f.id, f.value.weight]), [
    ['pseudo.pseudo_total_life', 1], ['pseudo.pseudo_total_fire_resistance', 1.5]]);
  assert.equal(body.query.filters.equipment_filters, undefined);
  const w = T.buildUpgradeQuery({ itemClass: 'Two Hand Maces', stats: { '[Weapon] Total DPS': 176.4 } },
    { '[Weapon] Total DPS': 1 }, { statIndex: idx, filtersData: FILTERS });
  assert.deepEqual(w.body.query.filters.equipment_filters.filters.dps, { min: 176 });
});

test('buildQuery', () => {
  const { body, unmatched } = T.buildQuery([
    { key: '# to maximum Life', min: 80 },
    { key: '[Base] Armour', min: 300 },
    { key: 'made up #', min: 1 },
  ], { itemClass: 'Helmets', statIndex: idx, filtersData: FILTERS });
  assert.deepEqual(unmatched, ['made up #']);
  assert.equal(body.query.status.option, 'available');
  assert.deepEqual(body.query.stats[0].filters[0], { id: 'pseudo.pseudo_total_life', value: { min: 80 }, disabled: false });
  assert.deepEqual(body.query.filters.equipment_filters.filters.ar, { min: 300 });
  assert.equal(body.query.filters.type_filters.filters.category.option, 'armour.helmet');
  const base = T.buildQuery([], { itemClass: 'Helmets', baseType: 'Expert Visored Helm', matchBase: true, statIndex: idx });
  assert.equal(base.body.query.type, 'Expert Visored Helm');
  assert.equal(base.body.query.filters.type_filters, undefined);
  assert.match(T.resultsUrl('Rise of the Abyssal', 'abc'), /trade2\/search\/poe2\/Rise%20of%20the%20Abyssal\/abc$/);
});

test('budget price filter', () => {
  assert.deepEqual(T.priceFilter({ max: 20, currency: 'divine' }), { max: 20, option: 'divine' });
  // never the site's own "exalted equivalent" for divines: its divine rate is far off the market
  assert.deepEqual(T.priceFilter({ max: 20, currency: 'divine', divineRate: 150 }), { max: 20, option: 'divine' });
  assert.deepEqual(T.priceFilter({ max: 1.5, currency: 'divine', divineRate: 700 }), { max: 1050, option: 'exalted' });
  assert.deepEqual(T.priceFilter({ max: 500, currency: 'exalted' }), { max: 500, option: 'exalted' });
  assert.equal(T.priceFilter({ max: '', currency: 'divine' }), null);
  assert.equal(T.priceFilter(null), null);
  const { body } = T.buildQuery([], { itemClass: 'Helmets', statIndex: idx, filtersData: FILTERS });
  T.applyBudget(body, { max: 20, currency: 'divine' });
  assert.deepEqual(body.query.filters.trade_filters.filters.price, { max: 20, option: 'divine' });
  assert.equal(body.query.filters.type_filters.filters.category.option, 'armour.helmet');
  assert.equal(T.budgetLabel({ max: 20, currency: 'divine', divineRate: 150 }), '≤ 20 div');
});

test('budget with a minimum price', () => {
  assert.deepEqual(T.priceFilter({ min: 5, max: 20, currency: 'divine', divineRate: 150 }), { min: 5, max: 20, option: 'divine' });
  assert.deepEqual(T.priceFilter({ min: 10, currency: 'divine', divineRate: 694 }), { min: 10, option: 'divine' });
  assert.deepEqual(T.priceFilter({ min: 5, currency: 'divine' }), { min: 5, option: 'divine' });
  assert.deepEqual(T.priceFilter({ min: 50, max: '', currency: 'exalted' }), { min: 50, option: 'exalted' });
  assert.deepEqual(T.priceFilter({ min: 30, max: 10, currency: 'chaos' }), { min: 10, max: 30, option: 'chaos' });
  assert.equal(T.budgetLabel({ min: 5, max: 20, currency: 'divine', divineRate: 150 }), '5–20 div');
  assert.equal(T.budgetLabel({ min: 5, currency: 'divine', divineRate: 150 }), '≥ 5 div');
  assert.equal(T.budgetLabel({ min: '', max: '', currency: 'divine' }), null);
});

test('similar-or-better query uses every stat with a count group', () => {
  const item = { itemClass: 'Helmets', stats: { '# to maximum Life': 50, '#% to Fire Resistance': 20, '#% increased Movement Speed': 10, '#% increased Armour': 40, '[Base] Armour': 300, 'mystery #': 3 } };
  const q = T.buildSimilarQuery(item, { statIndex: idx, filtersData: FILTERS, preferLocal: true });
  const g = q.body.query.stats[0];
  assert.equal(g.type, 'count');
  assert.equal(g.filters.length, 4);
  assert.deepEqual(g.value, { min: 3 });
  assert.deepEqual(g.filters.find((f) => f.id === 'pseudo.pseudo_total_life').value, { min: 50 });
  assert.equal(g.filters.find((f) => f.id === 'explicit.stat_armour_local').value.min, 40);
  assert.deepEqual(q.body.query.filters.equipment_filters.filters.ar, { min: 270 });
  assert.deepEqual(q.unmatched, ['mystery #']);
  assert.deepEqual(q.body.sort, { price: 'asc' });
  const small = T.buildSimilarQuery({ itemClass: 'Helmets', stats: { '# to maximum Life': 50 } }, { statIndex: idx });
  assert.deepEqual(small.body.query.stats[0].value, { min: 1 });
});

test('rune mods are kept apart from item mods', () => {
  const { parseItem } = require('../src/core/parser');
  const it = parseItem(`Item Class: Helmets
Rarity: Rare
A
B
--------
Armour: 300
--------
+12% to Fire Resistance (rune)
--------
+50 to maximum Life
+20% to Fire Resistance
10% increased Armour (rune)
20% increased Armour`);
  const src = T.statSources(it);
  const get = (k, s) => (src.find((x) => x.key === k && x.source === s) || {}).value;
  assert.equal(get('#% increased Armour', 'mod'), 20);
  assert.equal(get('#% increased Armour', 'socket'), 10);
  assert.equal(get('#% to Fire Resistance', 'mod'), 20);
  const q = T.buildSimilarQuery(it, { statIndex: idx, preferLocal: true });
  const f = q.body.query.stats[0].filters;
  assert.equal(f.find((x) => x.id === 'explicit.stat_armour_local').value.min, 20);
  assert.equal(f.find((x) => x.id === 'pseudo.pseudo_total_fire_resistance').value.min, 20);
  assert.deepEqual(q.skipped, ['#% to Fire Resistance', '#% increased Armour']);
});

test('similar: rune bonus removed from base ES, relax levels, uniques', () => {
  const { parseItem } = require('../src/core/parser');
  const gloves = parseItem(`Item Class: Gloves
Rarity: Rare
Doom Vise
Sorcerer Gloves
--------
Energy Shield: 280 (augmented)
--------
18% increased Armour, Evasion and Energy Shield (rune)
--------
113% increased Energy Shield
+33 to maximum Life
+39% to Lightning Resistance
+45% to Cold Resistance`);
  const q0 = T.buildSimilarQuery(gloves, { statIndex: idx, preferLocal: true });
  // 280 * (100+113)/(100+113+18) = 258.18 -> 90% = 232
  assert.deepEqual(q0.body.query.filters.equipment_filters.filters.es, { min: 232 });
  assert.equal(q0.body.query.status.option, 'available');
  const life0 = q0.body.query.stats[0].filters.find((f) => f.id === 'pseudo.pseudo_total_life');
  assert.deepEqual(life0.value, { min: 33 });
  const q2 = T.buildSimilarQuery(gloves, { statIndex: idx, preferLocal: true, level: 2 });
  assert.deepEqual(q2.body.query.stats[0].filters.find((f) => f.id === 'pseudo.pseudo_total_life').value, { min: 26 });
  assert.ok(q2.need < q0.need || q2.need === 1);
  assert.equal(q2.levelLabel, '80% of your values');

  const belt = parseItem(`Item Class: Belts
Rarity: Unique
Mageblood
Heavy Belt
--------
+50 to maximum Life`);
  const u = T.buildSimilarQuery(belt, { statIndex: idx });
  assert.equal(u.body.query.name, 'Mageblood');
  assert.equal(u.body.query.type, 'Heavy Belt');
  assert.equal(u.body.query.filters.type_filters, undefined);
  const uLast = T.buildSimilarQuery(belt, { statIndex: idx, level: T.RELAX.length - 1 });
  assert.deepEqual(uLast.body.query.stats, []);
  // +1 level stats never round to 0
  const tiny = T.buildSimilarQuery({ itemClass: 'Helmets', stats: { '# to maximum Life': 1 } }, { statIndex: idx, level: 3 });
  assert.equal(tiny.body.query.stats[0].filters[0].value.min, 1);
});

test('ignored / excluded stats', () => {
  const ign = require('../src/core/ignore');
  const { compare } = require('../src/core/scorer');
  const item = { itemClass: 'Helmets', slot: 'Helmet', name: 'N', stats: { '# to maximum Life': 50, '#% to Fire Resistance': 30, '#% to Cold Resistance': 20, 'Allies in your Presence have #% to all Elemental Resistances': 10 } };
  const rules = [{ id: 'res', mode: 'ignore' }];
  assert.equal(ign.isIgnored(rules, '#% to Fire Resistance'), true);
  assert.equal(ign.isIgnored(rules, 'Allies in your Presence have #% to all Elemental Resistances'), false);
  assert.equal(ign.isIgnored(rules, '# to maximum Life'), false);
  const q = T.buildSimilarQuery(item, { statIndex: idx, ignoreRules: rules });
  assert.deepEqual(q.ignored.sort(), ['#% to Cold Resistance', '#% to Fire Resistance']);
  assert.ok(!q.body.query.stats[0].filters.some((f) => /resistance/.test(f.id)));
  assert.equal(q.body.query.stats.length, 1); // no "not" group for plain ignore
  const ex = T.buildSimilarQuery(item, { statIndex: idx, ignoreRules: [{ id: 'res', mode: 'exclude' }] });
  const not = ex.body.query.stats.find((g) => g.type === 'not');
  assert.deepEqual(not.filters.map((f) => f.id), ['pseudo.pseudo_total_fire_resistance']); // only fire exists in the test stat list
  const w = T.buildUpgradeQuery(item, { '# to maximum Life': 1, '#% to Fire Resistance': 2 }, { statIndex: idx, ignoreRules: rules });
  assert.deepEqual(w.body.query.stats[0].filters.map((f) => f.id), ['pseudo.pseudo_total_life']);
  assert.equal(w.currentScore, 50);
  // popup score ignores it too
  const eq = { Helmet: { name: 'Old', itemClass: 'Helmets', stats: { '# to maximum Life': 40, '#% to Fire Resistance': 0 } } };
  const r = compare(item, eq, { '# to maximum Life': 1, '#% to Fire Resistance': 2 }, { ignore: (k) => ign.isIgnored(rules, k) });
  assert.equal(r.delta, 10);
  assert.ok(!r.rows.some((x) => /Resistance$/.test(x.key) && !/Allies/.test(x.key)));
  assert.deepEqual(ign.describe([{ id: 'res', mode: 'exclude' }, { key: '# to Strength' }]), ['All resistances (excluded)', '# to Strength']);
  const cq = T.buildQuery([{ key: '# to maximum Life', min: 10 }], { itemClass: 'Helmets', statIndex: idx, ignoreRules: [{ id: 'res', mode: 'exclude' }] });
  assert.equal(cq.body.query.stats[1].type, 'not');
});

test('stat catalog merges kinds and counts what you have seen per class', () => {
  const { buildCatalog, itemKeyFromText } = require('../src/core/catalog');
  const cat = buildCatalog(idx, { Gloves: { '# to maximum Life': 3 }, Helmets: { '# to maximum Life': 1, '#% to Fire Resistance': 2 } });
  const life = cat.entries.find((e) => e.n === T.norm('+# to maximum Life'));
  assert.equal(life.text, '+# to maximum Life');
  assert.deepEqual(Object.keys(life.kinds).sort(), ['explicit', 'pseudo']);
  assert.deepEqual(life.seen, { Gloves: 3, Helmets: 1 });
  assert.deepEqual(cat.classes, ['Gloves', 'Helmets']);
  assert.equal(itemKeyFromText('+#% to Fire Resistance'), '#% to Fire Resistance');
  assert.equal(itemKeyFromText('# to maximum Energy Shield (Local)'), '# to maximum Energy Shield');
  const ign = require('../src/core/ignore');
  assert.equal(ign.isIgnored([{ key: '+# total maximum Life' }], '# to maximum Life'), true);
  const q = T.buildQuery([{ key: 'whatever', id: 'explicit.stat_ms', min: 5 }], { itemClass: 'Boots', statIndex: idx });
  assert.deepEqual(q.body.query.stats[0].filters[0], { id: 'explicit.stat_ms', value: { min: 5 }, disabled: false });
});

test('craftable bases query', () => {
  const stats = { result: [{ id: 'pseudo', entries: [
    { id: 'pseudo.pseudo_number_of_empty_prefix_mods', text: '# Empty Prefix Modifiers', type: 'pseudo' },
    { id: 'pseudo.pseudo_number_of_empty_suffix_mods', text: '# Empty Suffix Modifiers', type: 'pseudo' },
    { id: 'pseudo.pseudo_total_life', text: '+# total maximum Life', type: 'pseudo' },
  ] }, { id: 'explicit', entries: [{ id: 'explicit.stat_ms', text: '#% increased Movement Speed', type: 'explicit' }] }] };
  const ix = T.buildStatIndex(stats);
  const boots = { itemClass: 'Boots', slot: 'Boots', stats: { '[Base] Energy Shield': 400 }, lines: [] };
  const q = T.buildCraftQuery(boots, { statIndex: ix, top: [{ key: '#% increased Movement Speed', cap: 35, label: 'Movement speed' }, { key: '# to maximum Life', cap: 100, label: 'Life' }] });
  const b = q.body.query;
  assert.deepEqual(b.filters.type_filters.filters.rarity, { option: 'rare' });
  assert.equal(b.filters.type_filters.filters.category.option, 'armour.boots');
  assert.deepEqual(b.filters.misc_filters.filters.corrupted, { option: 'false' });
  assert.deepEqual(b.stats[0].filters.map((f) => [f.id, f.value.min]), [['explicit.stat_ms', 19], ['pseudo.pseudo_total_life', 55]]);
  assert.equal(b.stats[1].type, 'count');
  assert.equal(b.stats[1].filters.length, 2);
  assert.deepEqual(b.filters.equipment_filters.filters.es, { min: 360 });
});

test('"Better for my build": weighted by gear score, implicit and explicit both count, base ES as a minimum', () => {
  const { parseItem } = require('../src/core/parser');
  const gear = require('../src/core/gearscore');
  const stats = { result: [
    { id: 'explicit', entries: [
      { id: 'explicit.minion_dmg', text: 'Minions deal #% increased Damage', type: 'explicit' },
      { id: 'explicit.minion_crit', text: 'Minions have #% increased Critical Hit Chance', type: 'explicit' },
      { id: 'explicit.ally_crit', text: 'Allies in your Presence have #% increased Critical Hit Chance', type: 'explicit' },
      { id: 'explicit.mana', text: '+# to maximum Mana', type: 'explicit' },
      { id: 'explicit.int', text: '+# to Intelligence', type: 'explicit' },
      { id: 'explicit.phys', text: 'Adds # to # Physical Damage to Attacks', type: 'explicit' },
    ] },
    { id: 'implicit', entries: [{ id: 'implicit.mana', text: '+# to maximum Mana', type: 'implicit' }] },
    { id: 'pseudo', entries: [{ id: 'pseudo.pseudo_total_mana', text: '+# total maximum Mana', type: 'pseudo' }] },
  ] };
  const ix = T.buildStatIndex(stats);
  const ring = parseItem('Item Class: Rings\nRarity: Rare\nPlague Circle\nIron Ring\n--------\nItem Level: 80\n--------\n+175 to maximum Mana\nMinions deal 27% increased Damage\nMinions have 44% increased Critical Hit Chance\n+20 to Intelligence');
  const weights = gear.searchWeights('Ring', { build: 'djinn-varashta' });
  const q = T.buildGearQuery(ring, { weights, statIndex: ix, status: 'available' });
  const g = q.body.query.stats[0];
  assert.strictEqual(g.type, 'weight');
  const ids = g.filters.map((f) => f.id);
  for (const id of ['explicit.minion_dmg', 'explicit.minion_crit', 'explicit.ally_crit', 'explicit.mana', 'implicit.mana', 'explicit.int']) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes('pseudo.pseudo_total_mana'), 'pseudo would double count');
  assert.ok(!ids.includes('explicit.phys'), 'useless stats left out');
  // current = sum of value * weight; min is a bit above it
  assert.ok(g.value.min > q.current && g.value.min <= Math.ceil(q.current * 1.03));
  const close = T.buildGearQuery(ring, { weights, statIndex: ix, share: 0.9 });
  assert.ok(close.body.query.stats[0].value.min < q.current);

  const gloves = parseItem('Item Class: Gloves\nRarity: Rare\nDoom Vise\nSirenscale Gloves\n--------\nEnergy Shield: 280\n--------\nItem Level: 80\n--------\n+33 to maximum Life');
  const q2 = T.buildGearQuery(gloves, { weights: gear.searchWeights('Gloves', { build: 'djinn-varashta' }), statIndex: ix, baseShare: 0.85 });
  assert.strictEqual(q2.body.query.filters.equipment_filters.filters.es.min, Math.floor(280 * 0.85));
});

test('If you equip it: resistances against the cap, Spirit and overall score', () => {
  const { parseItem } = require('../src/core/parser');
  const { changeIfEquipped } = require('../src/core/character');
  const eq = {
    'Ring 1': parseItem('Item Class: Rings\nRarity: Rare\nA\nIron Ring\n--------\n+40% to Cold Resistance\n+50 to maximum Mana'),
    Amulet: parseItem('Item Class: Amulets\nRarity: Rare\nB\nSolar Amulet\n--------\n+12 to Spirit (implicit)\n--------\n+30% to Fire Resistance'),
  };
  const ring = parseItem('Item Class: Rings\nRarity: Rare\nC\nIron Ring\n--------\n+10% to Cold Resistance\n+90 to maximum Mana\n+20% to Fire Resistance');
  const ch = changeIfEquipped(eq, ring, ['Ring 1'], { resists: { fire: 70, cold: 80, lightning: 75, chaos: 0, cap: 75 }, gearScore: (it) => (it === ring ? 60 : 40) });
  const cold = ch.res.find((r) => r.el === 'cold');
  assert.deepStrictEqual([cold.from, cold.to, cold.under], [80, 50, true]);
  const fire = ch.res.find((r) => r.el === 'fire');
  assert.deepStrictEqual([fire.from, fire.to, fire.under], [70, 90, false]);
  assert.ok(ch.warnings.some((w) => /Cold res drops below the cap/.test(w)));
  assert.deepStrictEqual(ch.lines.find((l) => l.label === 'Mana'), { label: 'Mana', from: 50, to: 90, delta: 40 });
  assert.deepStrictEqual(ch.overall, { from: 40, to: 50, delta: 10 });
});

test('"Better for my build" needs 2 of the slot\'s key stats, so one big minor roll can\'t carry junk', () => {
  const { parseItem } = require('../src/core/parser');
  const gear = require('../src/core/gearscore');
  const stats = { result: [{ id: 'explicit', entries: [
    { id: 'explicit.es_pct', text: '#% increased maximum Energy Shield', type: 'explicit' },
    { id: 'explicit.minion_dmg', text: 'Minions deal #% increased Damage', type: 'explicit' },
    { id: 'explicit.minion_dmg_hit', text: "Minions deal #% increased Damage if you've Hit Recently", type: 'explicit' },
    { id: 'explicit.minion_speed', text: 'Minions have #% increased Attack Speed', type: 'explicit' },
    { id: 'explicit.int', text: '+# to Intelligence', type: 'explicit' },
  ] }] };
  const ix = T.buildStatIndex(stats);
  const jewel = parseItem('Item Class: Jewels\nRarity: Rare\nHonour Stone\nSapphire\n--------\nItem Level: 80\n--------\n12% increased maximum Energy Shield\nMinions deal 14% increased Damage\n+8 to Intelligence');
  const q = T.buildGearQuery(jewel, { weights: gear.searchWeights('Jewel', { build: 'djinn-varashta' }), statIndex: ix });
  const count = q.body.query.stats.find((g) => g.type === 'count');
  assert.ok(count, 'count group');
  assert.strictEqual(count.value.min, 2);
  assert.ok(count.filters.some((f) => f.id === 'explicit.es_pct') && count.filters.some((f) => f.id === 'explicit.minion_dmg'));
  assert.ok(!count.filters.some((f) => f.id === 'explicit.minion_dmg_hit'), 'conditional versions are not key stats');
  const w = q.body.query.stats[0].filters;
  assert.ok(w.find((f) => f.id === 'explicit.minion_dmg_hit').value.weight < w.find((f) => f.id === 'explicit.minion_dmg').value.weight, 'conditional weighs less');
  assert.deepStrictEqual(q.body.sort, { 'statgroup.0': 'desc' });
});

test('resistances follow gear swaps and flag thin margins', () => {
  const R = require('../src/core/resists');
  const ch = require('../src/core/character');
  const g = (o) => ({ stats: o });
  const eq = { Gloves: g({ '#% to Cold Resistance': 45, '#% to Lightning Resistance': 39 }), Boots: g({ '#% to Cold Resistance': 37 }) };
  const rec = R.snapshot({ fire: 78, cold: 112, lightning: 122, chaos: 11 }, eq, 'pob');
  assert.strictEqual(R.live(rec, eq).lightning, 122);
  const after = { ...eq, Gloves: g({ '#% to Cold Resistance': 29 }) };
  const L = R.live(rec, after);
  assert.strictEqual(L.lightning, 83); assert.strictEqual(L.cold, 96);
  const r = ch.changeIfEquipped(eq, g({ '#% to Cold Resistance': 29 }), ['Gloves'], { resists: R.live(rec, eq) });
  assert.ok(r.warnings.some((w) => /Lightning res would be only 8% over/.test(w)));
  assert.ok(!r.warnings.some((w) => /Cold/.test(w)));
});

test('gear query can shrink for the trade site filter limit', () => {
  const { parseItem } = require('../src/core/parser');
  const gear = require('../src/core/gearscore');
  const stats = { result: [{ id: 'explicit', entries: [
    { id: 'explicit.es_pct', text: '#% increased maximum Energy Shield', type: 'explicit' },
    { id: 'implicit.es_pct', text: '#% increased maximum Energy Shield', type: 'implicit' },
    { id: 'explicit.minion_dmg', text: 'Minions deal #% increased Damage', type: 'explicit' },
    { id: 'explicit.minion_dmg_hit', text: "Minions deal #% increased Damage if you've Hit Recently", type: 'explicit' },
    { id: 'explicit.minion_speed', text: 'Minions have #% increased Attack Speed', type: 'explicit' },
    { id: 'explicit.int', text: '+# to Intelligence', type: 'explicit' },
  ] }] };
  const ix = T.buildStatIndex(stats);
  const jewel = parseItem('Item Class: Jewels\nRarity: Rare\nHonour Stone\nSapphire\n--------\nItem Level: 80\n--------\n12% increased maximum Energy Shield\nMinions deal 14% increased Damage\n+8 to Intelligence');
  const w = gear.searchWeights('Jewel', { build: 'djinn-varashta' });
  const n = (q) => q.body.query.stats.reduce((t, g) => t + g.filters.length, 0);
  const big = T.buildGearQuery(jewel, { weights: w, statIndex: ix });
  const mid = T.buildGearQuery(jewel, { weights: w, statIndex: ix, explicitOnly: true, maxFilters: 3, coreShare: 0 });
  const small = T.buildGearQuery(jewel, { weights: w, statIndex: ix, countOnly: true, explicitOnly: true });
  assert.ok(n(mid) <= 3 && n(mid) < n(big), `${n(mid)} vs ${n(big)}`);
  assert.ok(!mid.body.query.stats[0].filters.some((f) => f.id.startsWith('implicit.')));
  assert.strictEqual(small.body.query.stats.length, 1);
  assert.strictEqual(small.body.query.stats[0].type, 'count');
  assert.ok(small.countOnly && n(small) <= 5);
  assert.deepStrictEqual(small.body.sort, { price: 'asc' });
});

// --- review fixes ---
const LSTATS = { result: [{ id: 'explicit', label: 'Explicit', entries: [
  { id: 'explicit.acc', text: '+# to Accuracy Rating', type: 'explicit' },
  { id: 'explicit.acc_local', text: '+# to Accuracy Rating (Local)', type: 'explicit' },
  { id: 'explicit.as', text: '#% increased Attack Speed', type: 'explicit' },
  { id: 'explicit.as_local', text: '#% increased Attack Speed (Local)', type: 'explicit' },
  { id: 'explicit.ar', text: '#% increased Armour', type: 'explicit' },
  { id: 'explicit.ar_local', text: '#% increased Armour (Local)', type: 'explicit' },
  { id: 'explicit.chaos', text: '+#% to Chaos Resistance', type: 'explicit' },
  { id: 'explicit.life', text: '+# to maximum Life', type: 'explicit' },
  { id: 'explicit.attr', text: '#% increased Attribute Requirements', type: 'explicit' },
] }] };
const lidx = T.buildStatIndex(LSTATS);
const { parseItem: parseI } = require('../src/core/parser');

test('(Local) stats only where they are local for the item', () => {
  const ids = (cls, stats) => {
    const it = parseI(['Item Class: ' + cls, 'Rarity: Rare', 'A', 'B', '--------', ...stats].join('\n'));
    return T.buildSimilarQuery(it, { statIndex: lidx, preferLocal: true }).body.query.stats[0].filters.map((f) => f.id).sort();
  };
  assert.deepEqual(ids('Gloves', ['+150 to Accuracy Rating', '12% increased Attack Speed', '30% increased Armour']), ['explicit.acc', 'explicit.ar_local', 'explicit.as']);
  assert.deepEqual(ids('Quivers', ['+150 to Accuracy Rating', '12% increased Attack Speed']), ['explicit.acc', 'explicit.as']);
  assert.deepEqual(ids('Bows', ['+150 to Accuracy Rating', '12% increased Attack Speed']), ['explicit.acc_local', 'explicit.as_local']);
  assert.deepEqual(ids('Helmets', ['+150 to Accuracy Rating', '30% increased Armour']), ['explicit.acc', 'explicit.ar_local']);
  // buildQuery uses the item class it is given
  const q = T.buildQuery([{ key: '# to Accuracy Rating', min: 100 }], { itemClass: 'Gloves', statIndex: lidx, preferLocal: true });
  assert.equal(q.body.query.stats[0].filters[0].id, 'explicit.acc');
  assert.equal(T.localFor('# to Accuracy Rating', null, true), true); // unknown class: caller decides
});

test('"same stats or better" leaves out downsides', () => {
  const it = parseI(['Item Class: Body Armours', 'Rarity: Rare', 'A', 'B', '--------', '+80 to maximum Life', '-10% to Chaos Resistance', '10% increased Attribute Requirements'].join('\n'));
  const f = T.buildSimilarQuery(it, { statIndex: lidx }).body.query.stats[0].filters;
  assert.deepEqual(f.map((x) => x.id).sort(), ['explicit.life']);
  const it2 = parseI(['Item Class: Body Armours', 'Rarity: Rare', 'A', 'B', '--------', '+80 to maximum Life', '15% reduced Attribute Requirements'].join('\n'));
  const f2 = T.buildSimilarQuery(it2, { statIndex: lidx }).body.query.stats[0].filters;
  assert.deepEqual(f2.find((x) => x.id === 'explicit.attr').value, { max: -15 });
});

test('small divine budgets in exalts keep min <= max and max >= 1', () => {
  assert.deepEqual(T.priceFilter({ min: 1, max: 1, currency: 'divine', divineRate: 312.7 }), { min: 313, max: 313, option: 'exalted' });
  assert.deepEqual(T.priceFilter({ min: 0.5, max: 0.5, currency: 'divine', divineRate: 300.5 }), { min: 150, max: 150, option: 'exalted' });
  assert.deepEqual(T.priceFilter({ max: 0.001, currency: 'divine', divineRate: 300 }), { max: 1, option: 'exalted' });
});

test('"same base type" without a base name falls back to the item class', () => {
  const q = T.buildQuery([], { itemClass: 'Helmets', baseType: null, matchBase: true, statIndex: idx, filtersData: FILTERS }).body.query;
  assert.equal(q.type, undefined);
  assert.equal(q.filters.type_filters.filters.category.option, 'armour.helmet');
});

test('Mageblood Legacies are in statSources', () => {
  const mb = parseI(['Item Class: Belts', 'Rarity: Unique', 'Mageblood', 'Rawhide Belt', '--------', 'Has 3 Charm Slots (implicit)', '--------', 'Legacy of Ruby', 'Legacy of Topaz'].join('\n'));
  const src = T.statSources(mb);
  assert.equal(src.find((x) => x.key === '#% to Fire Resistance').value, 60);
  assert.equal(src.find((x) => x.key === '#% to Lightning Resistance').source, 'mod');
  assert.equal(src.find((x) => x.key === 'Has # Charm Slots').source, 'implicit');
});
