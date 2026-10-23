'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('../src/core/games');
const { Store } = require('../src/core/store');

const POE1_ARMOUR = `Item Class: Body Armours
Rarity: Rare
Carrion Shell
Astral Plate
--------
Quality: +20% (augmented)
Armour: 1214 (augmented)
--------
Requirements:
Level: 62
Str: 180
--------
Sockets: R-R-R-G-B-B
--------
Item Level: 84
--------
+12% to all Elemental Resistances (implicit)
--------
+101 to maximum Life
+40% to Fire Resistance
--------
Shaper Item`;
const POE2_ARMOUR = `Item Class: Body Armours
Rarity: Rare
Doom Shell
Vile Robe
--------
Energy Shield: 312 (augmented)
--------
Requires: Level 65, 121 Int
--------
Sockets: S S
--------
Item Level: 81
--------
+80 to maximum Energy Shield
+30% to Lightning Resistance
+12% increased Energy Shield (rune)`;
const RING = `Item Class: Rings
Rarity: Rare
Storm Loop
Ruby Ring
--------
Item Level: 80
--------
+30% to Fire Resistance (implicit)
--------
+60 to maximum Life`;

test('games: the window title decides, exactly', () => {
  assert.strictEqual(G.gameFromWindow('fg=PathOfExileSteam;over=PathOfExileSteam;title=Path of Exile 2'), 'poe2');
  assert.strictEqual(G.gameFromWindow('fg=PathOfExile_x64;over=PathOfExile_x64;title=Path of Exile'), 'poe1');
  assert.strictEqual(G.gameFromWindow('fg=PathOfExile;over=PathOfExile;nudged;game=poe1'), 'poe1');
  assert.strictEqual(G.gameFromWindow('fg=Discord;over=Discord'), null);
  assert.strictEqual(G.gameFromWindow(true), null);
  assert.strictEqual(G.gameFromTitle('Path of Exile 2 - something'), null);
});

test('games: item text tells the game when the window can\'t', () => {
  assert.strictEqual(G.gameFromItemText(POE1_ARMOUR), 'poe1');
  assert.strictEqual(G.gameFromItemText(POE2_ARMOUR), 'poe2');
  assert.strictEqual(G.gameFromItemText(RING), null); // a ring looks the same in both
  assert.strictEqual(G.gameFromItemText('Item Class: Charms\nRarity: Magic\nX'), 'poe2');
  assert.strictEqual(G.gameFromItemText('Item Class: Claws\nRarity: Rare\nX'), 'poe1');
  assert.strictEqual(G.gameFromItemText('Item Class: Rings\nRarity: Rare\nX\n--------\nEater of Worlds Item'), 'poe1');
});

test('games: window beats item text, then the last game', () => {
  assert.strictEqual(G.detectGame({ sent: 'fg=PathOfExile;over=PathOfExile;title=Path of Exile 2', text: POE1_ARMOUR }), 'poe2');
  assert.strictEqual(G.detectGame({ sent: 'fg=?;over=?', text: POE1_ARMOUR }), 'poe1');
  assert.strictEqual(G.detectGame({ text: RING, last: 'poe1' }), 'poe1');
  assert.strictEqual(G.detectGame({ text: RING }), null);
});

test('games: a PoB export says which game', () => {
  assert.strictEqual(G.gameFromPobXml('<?xml version="1.0"?>\n<PathOfBuilding2>\n</PathOfBuilding2>'), 'poe2');
  assert.strictEqual(G.gameFromPobXml('<PathOfBuilding>\n<Build/></PathOfBuilding>'), 'poe1');
  assert.strictEqual(G.gameFromPobXml('hello'), null);
});

test('store: characters get a game, one active character per game', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pucg-'));
  // a settings file from before PoE1 support
  fs.writeFileSync(path.join(dir, 'poe2-upgrade-checker.json'), JSON.stringify({ profiles: { main: { name: 'Djinn' }, alt: { name: 'Monk' } }, activeProfile: 'main', settings: {}, equipped: {}, weights: {} }));
  const s = new Store(dir);
  assert.deepStrictEqual(s.listProfiles().map((p) => p.game), ['poe2', 'poe2']);
  assert.strictEqual(s.activeGame(), 'poe2');
  assert.strictEqual(s.profileForGame('poe1'), null);
  const p1 = s.createProfile('Marauder', false, 'poe1');
  assert.strictEqual(s.activeGame(), 'poe1');
  s.switchProfile('alt');
  assert.strictEqual(s.profileForGame('poe2'), 'alt'); // the PoE2 character you used last
  assert.strictEqual(s.profileForGame('poe1'), p1);
  s.switchProfile(s.profileForGame('poe1'));
  assert.strictEqual(s.data.activeProfile, p1);
  // deleting the active PoE1 character falls back to... any character (no other PoE1 one)
  s.deleteProfile(p1);
  assert.strictEqual(s.profileForGame('poe1'), null);
  assert.strictEqual(s.activeGame(), 'poe2');
  // reload keeps it all
  const s2 = new Store(dir);
  assert.strictEqual(s2.profileForGame('poe2'), s2.data.activeProfile);
  // a character moved to the other game by its PoB import
  s2.setProfileGame('main', 'poe1');
  assert.strictEqual(s2.profileForGame('poe1'), 'main');
});

test('store: each game keeps its own league, prices and search sizes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pucg-'));
  const s = new Store(dir);
  s.setSetting('league', 'Rise of the Abyssal'); s.setSetting('divineRate', 700); s.setSetting('hotkey', 'F3');
  const p1 = s.createProfile('Marauder', false, 'poe1');
  assert.strictEqual(s.settings.league, undefined);
  assert.strictEqual(s.settings.hotkey, 'F3'); // shared
  s.setSetting('league', 'Allflame'); s.setSetting('divineRate', 180);
  s.switchProfile(s.profileForGame('poe2'));
  assert.strictEqual(s.settings.league, 'Rise of the Abyssal');
  assert.strictEqual(s.settings.divineRate, 700);
  const s2 = new Store(dir); // survives a restart
  assert.strictEqual(s2.settings.league, 'Rise of the Abyssal');
  s2.switchProfile(p1);
  assert.strictEqual(s2.settings.league, 'Allflame');
  assert.strictEqual(s2.settings.divineRate, 180);
});

test('trade: PoE1 URLs and filter groups', () => {
  const t = require('../src/core/trade');
  assert.strictEqual(t.searchUrl('Allflame', 'poe1'), 'https://www.pathofexile.com/api/trade/search/Allflame');
  assert.strictEqual(t.searchUrl('Dawn', 'poe2'), 'https://www.pathofexile.com/api/trade2/search/poe2/Dawn');
  assert.ok(!/realm/.test(t.fetchUrl(['a'], 'q', 'poe1')) && /realm=poe2/.test(t.fetchUrl(['a'], 'q', 'poe2')));
  assert.strictEqual(t.resultsUrl('Allflame', 'X', 'poe1'), 'https://www.pathofexile.com/trade/search/Allflame/X');
  const b = t.adaptQuery({ query: { filters: { equipment_filters: { filters: { es: { min: 5 }, pdps: { min: 100 }, spirit: { min: 30 } } } } } }, 'poe1');
  assert.deepStrictEqual(b.query.filters, { armour_filters: { filters: { es: { min: 5 } } }, weapon_filters: { filters: { pdps: { min: 100 } } } });
  const b2 = t.adaptQuery({ query: { filters: { equipment_filters: { filters: { es: { min: 5 } } } } } }, 'poe2');
  assert.ok(b2.query.filters.equipment_filters); // PoE2 unchanged
  // PoE1: chaos equivalent (no currency named), so divine- and chaos-priced listings both count
  assert.deepStrictEqual(t.priceFilter({ max: 1, currency: 'divine', divineRate: 180 }, 'poe1'), { max: 180 });
  assert.deepStrictEqual(t.priceFilter({ min: 2, max: 10, currency: 'divine', divineRate: 180 }, 'poe1'), { min: 360, max: 1800 });
  assert.deepStrictEqual(t.priceFilter({ max: 300, currency: 'chaos' }, 'poe1'), { max: 300 });
  assert.deepStrictEqual(t.priceFilter({ max: 10, currency: 'divine' }, 'poe1'), { max: 10, option: 'divine' }); // no rate yet
  assert.strictEqual(t.budgetLabel({ max: 300, currency: 'chaos' }, 'poe1'), '≤ 300 chaos');
  assert.strictEqual(t.priceFilter({ max: 10, currency: 'divine', divineRate: 300 }, 'poe2').option, 'divine'); // PoE2 unchanged
  assert.ok(t.isTradePage('https://www.pathofexile.com/trade/search/Allflame/X') && t.isTradePage('https://www.pathofexile.com/trade2/search/poe2/D/X') && !t.isTradePage('https://evil.example/trade/'));
});

test('rates: PoE1 counts in chaos', () => {
  const r = require('../src/core/rates');
  assert.strictEqual(r.divineInExalts({ core: { primary: 'chaos' }, lines: [{ id: 'divine', primaryValue: 175 }] }, 'chaos'), 175);
  assert.strictEqual(r.divineInExalts({ lines: [{ currencyTypeName: 'Divine Orb', chaosEquivalent: 180 }] }, 'chaos'), 180);
  assert.ok(r.ninjaUrls('Allflame', 'poe1')[0].startsWith('https://poe2upgrade.com/ninja/poe1/') && r.ninjaUrls('Allflame', 'poe1')[1].startsWith('https://poe.ninja/poe1/'));
  const L = require('../src/core/listing');
  assert.strictEqual(L.priceInEx({ amount: 40, currency: 'chaos' }, {}, 'chaos'), 40);
  assert.strictEqual(L.priceInEx({ amount: 40, currency: 'chaos' }, {}), null); // PoE2 without a chaos rate
});

test('store: a damaged file never stops the app, and each game keeps its own priorities', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  fs.writeFileSync(path.join(dir, 'poe2-upgrade-checker.json'), JSON.stringify({ settings: { league: 'Dawn' }, gameSettings: 'oops', activeByGame: [1], profiles: { main: { name: 'A' }, bad: 'x' }, activeProfile: 'main' }));
  const s = new Store(dir);
  assert.strictEqual(s.activeGame(), 'poe2');
  assert.ok(!s.data.profiles.bad);
  s.setSetting('priorities', { chaos: false });
  const p1 = s.createProfile('My PoE1 character', false, 'poe1');
  assert.strictEqual(s.settings.build, 'off'); // the gear score is for PoE2
  assert.strictEqual(s.settings.priorities, undefined); // PoE1 starts from its own defaults
  assert.strictEqual(s.settings.autoRate, true);
  s.setSetting('priorities', { chaos: true });
  s.switchProfile('main');
  assert.deepStrictEqual(s.settings.priorities, { chaos: false });
  assert.strictEqual(s.settings.league, 'Dawn');
  // a new PoE2 character made while on PoE1 doesn't inherit 'off'
  s.switchProfile(p1);
  s.createProfile('Second PoE2', false, 'poe2');
  assert.notStrictEqual(s.settings.build, 'off');
});

test('store: an untouched character can become the other game\'s', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
  const s = new Store(dir);
  assert.strictEqual(s.isUntouched('main'), true);
  s.setEquipped('Ring 1', { name: 'X', stats: {} });
  assert.strictEqual(s.isUntouched('main'), false);
});

test('trade: PoE1 price checks match links, influence and fractured; bench crafts are left out', () => {
  const t = require('../src/core/trade');
  const { parseItem } = require('../src/core/parser');
  const text = 'Item Class: Body Armours\nRarity: Rare\nDoom Shell\nAstral Plate\n--------\nArmour: 800\n--------\nSockets: R-R-R-R-R-B\n--------\nItem Level: 86\n--------\n+90 to maximum Life\n+40% to Fire Resistance\n+30% to Cold Resistance (crafted)\n--------\nHunter Item\nFractured Item';
  const it = parseItem(text);
  assert.ok(it, 'parsed');
  const idx = t.buildStatIndex({ result: [{ entries: [
    { id: 'explicit.stat_3299347043', text: '+# to maximum Life', type: 'explicit' },
    { id: 'explicit.stat_3372524247', text: '+#% to Fire Resistance', type: 'explicit' },
    { id: 'explicit.stat_4220027924', text: '+#% to Cold Resistance', type: 'explicit' },
    { id: 'crafted.stat_4220027924', text: '+#% to Cold Resistance', type: 'crafted' },
  ] }] });
  const q = t.buildSimilarQuery(it, { statIndex: idx, forPrice: true, game: 'poe1', level: 0 });
  const f = q.body.query.filters;
  assert.deepStrictEqual(f.socket_filters, { filters: { links: { min: 6 } } });
  assert.deepStrictEqual(f.misc_filters.filters.hunter_item, { option: 'true' });
  assert.deepStrictEqual(f.misc_filters.filters.fractured_item, { option: 'true' });
  const ids = (q.body.query.stats[0] || { filters: [] }).filters.map((x) => x.id);
  assert.ok(!ids.includes('explicit.stat_4220027924'), 'the crafted cold res is not asked for as an explicit: ' + ids);
  // PoE2: no PoE1 filters
  const q2 = t.buildSimilarQuery(it, { statIndex: idx, forPrice: true, game: 'poe2', level: 0 });
  assert.ok(!q2.body.query.filters.socket_filters);
});

test('trade: PoE1 item classes find their categories', () => {
  const t = require('../src/core/trade');
  const fd = { result: [{ filters: [{ id: 'category', option: { options: [
    { id: 'weapon.onesword', text: 'One-Handed Sword' }, { id: 'weapon.runedagger', text: 'Rune Dagger' }, { id: 'weapon.dagger', text: 'Base Dagger' },
    { id: 'jewel.base', text: 'Base Jewel' }, { id: 'jewel.abyss', text: 'Abyss Jewel' }, { id: 'flask', text: 'Flask' }, { id: 'weapon.twoaxe', text: 'Two-Handed Axe' },
  ] } }] }] };
  assert.strictEqual(t.categoryFor('Thrusting One Hand Swords', fd), 'weapon.onesword');
  assert.strictEqual(t.categoryFor('Rune Daggers', fd), 'weapon.runedagger');
  assert.strictEqual(t.categoryFor('Daggers', fd), 'weapon.dagger');
  assert.strictEqual(t.categoryFor('Abyss Jewels', fd), 'jewel.abyss');
  assert.strictEqual(t.categoryFor('Jewels', fd), 'jewel.base');
  assert.strictEqual(t.categoryFor('Utility Flasks', fd), 'flask');
  assert.strictEqual(t.categoryFor('Two Hand Axes', fd), 'weapon.twoaxe');
  assert.strictEqual(t.categoryFor('Rune Daggers', null), 'weapon.runedagger');
});

test('rates: PoE1 currencies by trade id, and the base found from the rates', () => {
  const r = require('../src/core/rates');
  assert.deepStrictEqual(r.currencyRatesInExalts({ core: { primary: 'divine', rates: { chaos: 200 } }, lines: [{ id: 'divine', primaryValue: 1 }, { id: 'alch', primaryValue: 0.001 }] }, 'chaos'), { chaos: 1, divine: 200, alch: 0.2 });
  assert.strictEqual(r.currencyRatesInExalts({ lines: [] }, 'chaos'), null);
  const old = { lines: [{ currencyTypeName: 'Orb of Fusing', chaosEquivalent: 0.5 }, { currencyTypeName: 'Divine Orb', chaosEquivalent: 180 }], currencyDetails: [{ name: 'Orb of Fusing', tradeId: 'fusing' }, { name: 'Divine Orb', tradeId: 'divine' }] };
  assert.deepStrictEqual(r.currencyRatesInExalts(old, 'chaos'), { chaos: 1, fusing: 0.5, divine: 180 });
  assert.strictEqual(r.divineInExalts(old, 'chaos'), 180);
});

test('verdict: PoE1 reservation counts like Spirit', () => {
  const v = require('../src/core/pobverdict');
  const before = { Life: 4000, TotalEHP: 10000, CombinedDPS: 1e6, ManaUnreserved: 20 };
  const j = v.judge(before, { ...before, TotalEHP: 11000, ManaUnreserved: -30 });
  assert.ok(j.breaks.some((b) => /mana to reserve/.test(b)), j.breaks.join());
  assert.notStrictEqual(j.verdict, 'upgrade');
});
