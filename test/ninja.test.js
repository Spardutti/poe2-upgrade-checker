'use strict';

// poe.ninja prices for things that aren't judged as gear
const test = require('node:test');
const assert = require('node:assert');
const N = require('../src/core/ninja');
const { parseItem } = require('../src/core/parser');

const EX2 = { core: { primary: 'divine', secondary: 'chaos', rates: { exalted: 400, chaos: 30 }, items: [{ id: 'divine', name: 'Divine Orb' }] },
  items: [{ id: 'gcp', name: "Gemcutter's Prism", category: 'Currency' }, { id: 'exalted', name: 'Exalted Orb', category: 'Currency' }],
  lines: [{ id: 'divine', primaryValue: 1, sparkline: { totalChange: 3.2 } }, { id: 'gcp', primaryValue: 0.0025, sparkline: { totalChange: -12.5 } }, { id: 'exalted', primaryValue: 0.0025 }] };

test('ninja: the proxy comes first, then poe.ninja', () => {
  const u = N.exchangeUrls('Rise of the Abyssal', 'Currency', 'poe2');
  assert.strictEqual(u[0], 'https://poe2upgrade.com/ninja/poe2/exchange/current/overview?league=Rise%20of%20the%20Abyssal&type=Currency');
  assert.strictEqual(u[1], 'https://poe.ninja/poe2/api/economy/exchange/current/overview?league=Rise%20of%20the%20Abyssal&type=Currency');
  assert.ok(N.itemUrls('Allflame', 'SkillGem', 'poe1')[1].startsWith('https://poe.ninja/poe1/api/economy/stash/current/item/overview?league=Allflame&type=SkillGem'));
});

test('ninja: a stack of PoE2 currency, in exalts and divines', () => {
  const it = parseItem("Item Class: Stackable Currency\nRarity: Currency\nGemcutter's Prism\n--------\nStack Size: 12/20\n--------\nImproves the quality of a gem");
  assert.deepStrictEqual(N.typesFor(it, 'poe2'), { exchange: true, items: [] });
  const p = N.priceOf(it, { exchange: [EX2] }, 'poe2');
  assert.strictEqual(p.each, 1); // 0.0025 div * 400 ex
  assert.strictEqual(p.total, 12);
  assert.strictEqual(p.unit, 'ex');
  assert.strictEqual(p.change, -12.5);
  assert.strictEqual(N.priceOf(parseItem('Item Class: Stackable Currency\nRarity: Currency\nDivine Orb\n--------\nStack Size: 2/20'), { exchange: [EX2] }, 'poe2').totalDiv, 2);
});

test('ninja: PoE1 gems by level, quality and corruption; maps by tier; uniques by links', () => {
  const gems = { lines: [
    { name: 'Fireball', gemLevel: 20, gemQuality: 20, corrupted: false, chaosValue: 5, divineValue: 0.03, listingCount: 50 },
    { name: 'Fireball', gemLevel: 21, gemQuality: 20, corrupted: true, chaosValue: 90, divineValue: 0.5, listingCount: 20 },
    { name: 'Fireball', gemLevel: 20, gemQuality: 20, corrupted: true, chaosValue: 3, listingCount: 30 },
    { name: 'Fireball', gemLevel: 1, gemQuality: 0, corrupted: false, chaosValue: 1, listingCount: 300 },
  ] };
  const g = parseItem('Item Class: Skill Gems\nRarity: Gem\nFireball\n--------\nSpell, Projectile\nLevel: 21 (Max)\nQuality: +20% (augmented)\n--------\nCorrupted');
  assert.deepStrictEqual(N.typesFor(g, 'poe1').items, ['SkillGem', 'ImbuedGem']);
  assert.strictEqual(N.priceOf(g, { items: [gems] }, 'poe1').each, 90);
  const g2 = parseItem('Item Class: Skill Gems\nRarity: Gem\nFireball\n--------\nSpell\nLevel: 20\nQuality: +20% (augmented)');
  assert.strictEqual(N.priceOf(g2, { items: [gems] }, 'poe1').each, 5);
  const maps = { lines: [{ name: 'Cemetery Map', baseType: 'Cemetery Map', mapTier: 16, chaosValue: 2, listingCount: 99 }, { name: 'Cemetery Map', mapTier: 14, chaosValue: 1 }] };
  const m = parseItem('Item Class: Maps\nRarity: Rare\nForsaken Haunt\nCemetery Map\n--------\nMap Tier: 16\n--------\nItem Level: 83\n--------\nPlayers have -10% to all maximum Resistances');
  assert.deepStrictEqual(N.typesFor(m, 'poe1').items, ['Map']);
  assert.strictEqual(N.priceOf(m, { items: [maps] }, 'poe1').each, 2);
  const uniq = { lines: [{ name: 'Kaom\'s Heart', links: null, chaosValue: 400, divineValue: 2, listingCount: 40 }, { name: 'Kaom\'s Heart', links: 6, chaosValue: 1800, divineValue: 9, listingCount: 4 }] };
  const k = parseItem("Item Class: Body Armours\nRarity: Unique\nKaom's Heart\nGlorious Plate\n--------\nArmour: 553\n--------\nSockets: R-R-R-R-R-R\n--------\nItem Level: 80\n--------\n+500 to maximum Life");
  assert.deepStrictEqual(N.typesFor(k, 'poe1').items, ['UniqueArmour']);
  const pk = N.priceOf(k, { items: [uniq] }, 'poe1');
  assert.strictEqual(pk.eachDiv, 9); assert.strictEqual(pk.few, true);
  // magic and rare gear isn't priced from poe.ninja
  assert.deepStrictEqual(N.typesFor(parseItem('Item Class: Rings\nRarity: Rare\nX\nRuby Ring\n--------\n+30% to Fire Resistance'), 'poe1'), { exchange: false, items: [] });
});

test('ninja: info links and the hosts they may open', () => {
  const l = N.infoLinks({ name: "Kaom's Heart", rarity: 'Unique', slot: 'Body Armour' }, 'poe1');
  assert.strictEqual(l[0].url, "https://www.poewiki.net/wiki/Kaom's_Heart");
  assert.ok(N.isInfoPage(l[1].url) && !N.isInfoPage('https://evil.example/wiki'));
  assert.ok(N.infoLinks({ name: 'X', baseType: 'Ruby Ring', rarity: 'Rare', slot: 'Ring' }, 'poe2')[0].url.endsWith('/Ruby_Ring'));
});

test('map check: mods, your marks, and the build checks', () => {
  const M = require('../src/core/mapcheck');
  const it = parseItem('Item Class: Maps\nRarity: Rare\nForsaken Haunt\nCemetery Map\n--------\nMap Tier: 16\nItem Quantity: +80% (augmented)\n--------\nItem Level: 83\n--------\nPlayers have -12% to all maximum Resistances\nMonsters reflect 18% of Elemental Damage\nMonsters have 40% increased Area of Effect');
  assert.ok(M.isMap(it));
  assert.deepStrictEqual(M.modsOf(it), ['Players have -12% to all maximum Resistances', 'Monsters reflect 18% of Elemental Damage', 'Monsters have 40% increased Area of Effect']);
  const before = { TotalEHP: 24000, FireResist: 76, ColdResist: 76, LightningResist: 76, Life: 5000 };
  const pob = { before, results: [{ text: 'Players have -12% to all maximum Resistances', after: { ...before, TotalEHP: 17000, FireResist: 64, ColdResist: 64, LightningResist: 64 } }, { text: 'Monsters reflect 18% of Elemental Damage' }, { text: 'Monsters have 40% increased Area of Effect' }],
    damage: { Fire: 900, Physical: 100 }, minion: false };
  const c = M.check(it, pob, {});
  assert.strictEqual(c.rows[0].level, 'danger'); // -29% effective HP
  assert.match(c.rows[0].note, /effective HP -29\.2%/);
  assert.strictEqual(c.rows[1].level, 'danger'); // 90% elemental: reflected
  assert.strictEqual(c.rows[2].level, 'info');
  assert.strictEqual(c.verdict, 'danger');
  // your mark wins; a physical build doesn't care about elemental reflect
  const c2 = M.check(it, { ...pob, damage: { Physical: 1000 }, results: [] }, { [M.keyOf('Monsters have 40% increased Area of Effect')]: 'd' });
  assert.strictEqual(c2.rows[1].level, 'ok');
  assert.strictEqual(c2.rows[2].level, 'danger');
  assert.strictEqual(M.keyOf('Monsters reflect 18% of Elemental Damage'), M.keyOf('Monsters reflect 13% of Elemental Damage'));
  assert.strictEqual(M.nextMark(''), 'd'); assert.strictEqual(M.nextMark('g'), '');
});

test('loot filter: a section in front of your filter, replaced on the next run', () => {
  const F = require('../src/core/lootfilter');
  const s = F.build([{ slot: 'Ring', cls: 'Rings', bases: ['Two-Stone Ring'], affixes: ['Virile', 'of Tzteosh', 'Virile'] }, { slot: 'Boots', cls: 'Boots', bases: ['Two-Toned Boots'], affixes: ['Rotund'] }], { game: 'poe1', name: 'Berserker' });
  assert.match(s.text, /Class == "Rings"\n\tHasExplicitMod >=2 "Virile" "of Tzteosh"/);
  assert.ok(!/Class == "Boots"/.test(s.text)); // one top mod is not enough for a ">= 2" rule
  assert.match(s.text, /BaseType == "Two-Stone Ring" "Two-Toned Boots"\n\tItemLevel >= 82/);
  const mine = 'Show\n\tBaseType == "Mirror of Kalandra"\n';
  const once = F.merge(s, mine);
  assert.ok(once.endsWith(mine));
  const twice = F.merge(s, once);
  assert.strictEqual(twice, once); // not stacked
  // PoE2 filters have HasExplicitMod too
  const s2 = F.build([{ slot: 'Ring', cls: 'Rings', bases: ['Ruby Ring'], affixes: ['A', 'B'] }], { game: 'poe2' });
  assert.ok(/HasExplicitMod >=2 "A" "B"/.test(s2.text) && /ItemLevel >= 75/.test(s2.text));
  assert.deepStrictEqual(F.tagsFor('Ring 2', {}), ['ring']);
});

test('ninja: every exchange list in one request through the proxy', () => {
  assert.strictEqual(N.allExchangeUrl('Rise of the Abyssal', 'poe2'), 'https://poe2upgrade.com/ninja/poe2/exchange/all?league=Rise%20of%20the%20Abyssal');
  // the combined answer prices like the single lists
  const it = parseItem("Item Class: Stackable Currency\nRarity: Currency\nGemcutter's Prism\n--------\nStack Size: 2/20");
  assert.strictEqual(N.priceOf(it, { exchange: Object.values({ Currency: EX2, Runes: { core: EX2.core, items: [], lines: [] } }) }, 'poe2').total, 2);
});

test('ninja: the 7-day price history from the sparkline', () => {
  assert.deepStrictEqual(N.history({ data: [0, 10, null, 20], totalChange: 20 }), [0.833, 0.917, null, 1]);
  assert.deepStrictEqual(N.history({ data: [] }), []);
  assert.deepStrictEqual(N.history(null), []);
});

test('map check: 3.29 Thorns instead of reflect', () => {
  const M = require('../src/core/mapcheck');
  const phys = { damage: { Physical: 900, Fire: 10 } };
  assert.strictEqual(M.ruleFor('Rare Monsters have Physical Thorns', phys).level, 'warn');
  assert.strictEqual(M.ruleFor('Rare Monsters have Elemental Thorns', phys).level, 'ok');
  assert.strictEqual(M.ruleFor('Rare Monsters have Physical Thorns', { minion: true, damage: { Physical: 1 } }).level, 'ok');
});
