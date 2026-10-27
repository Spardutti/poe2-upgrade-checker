'use strict';

// Path of Exile 1 item text (step 3 of docs/POE1-SUPPORT.md).
// The fixtures follow the game's clipboard format as Awakened PoE Trade parses it
// (renderer/src/parser/Parser.ts, renderer/public/data/en/client_strings.js) and as Path of
// Building reads it (vendor/pob1/src/Classes/Item.lua); the mods come from PoB's test builds
// (test/fixtures/pob1/*.xml) where they could. Since 3.29 a plain Ctrl+C copies the advanced
// text ({ Prefix Modifier ... } headers), so most fixtures use it.

const test = require('node:test');
const assert = require('node:assert');
const { parseItem } = require('../src/core/parser');
const { slotForClass, isTwoHanded, SLOTS } = require('../src/core/slots');
const G = require('../src/core/games');

// Advanced copy: rare body armour, 5-link, quality, requirements, fractured + crafted mods.
const BODY_ADV = `Item Class: Body Armours
Rarity: Rare
Oblivion Cloak
Astral Plate
--------
Quality: +20% (augmented)
Armour: 1214 (augmented)
--------
Requirements:
Level: 62
Str: 180
--------
Sockets: R-R-R-G-B B
--------
Item Level: 86
--------
{ Implicit Modifier — Elemental, Resistance }
+12(8-12)% to all Elemental Resistances (implicit)
--------
{ Prefix Modifier "Prime" (Tier: 1) — Life }
+119(110-119) to maximum Life
{ Prefix Modifier "Impenetrable" (Tier: 2) — Defences, Armour }
85(80-91)% increased Armour
{ Fractured Suffix Modifier "of the Volcano" (Tier: 2) — Elemental, Fire, Resistance }
+44(42-45)% to Fire Resistance (fractured)
{ Suffix Modifier "of the Ice" (Tier: 3) — Elemental, Cold, Resistance }
+38(36-41)% to Cold Resistance
{ Master Crafted Suffix Modifier "of Craft" (Rank: 2) — Elemental, Lightning, Resistance }
+25(25-28)% to Lightning Resistance (crafted)
--------
Fractured Item`;

// The same item as plain (pre-3.29 Ctrl+C) text.
const BODY_PLAIN = `Item Class: Body Armours
Rarity: Rare
Oblivion Cloak
Astral Plate
--------
Quality: +20% (augmented)
Armour: 1214 (augmented)
--------
Requirements:
Level: 62
Str: 180
--------
Sockets: R-R-R-G-B B
--------
Item Level: 86
--------
+12% to all Elemental Resistances (implicit)
--------
+119 to maximum Life
85% increased Armour
+44% to Fire Resistance (fractured)
+38% to Cold Resistance
+25% to Lightning Resistance (crafted)
--------
Fractured Item`;

// Influenced (Elder + Hunter) boots, with a lab enchant, corrupted, price note.
const BOOTS_INFLUENCED = `Item Class: Boots
Rarity: Rare
Loath Road
Two-Toned Boots
--------
Quality: +20% (augmented)
Armour: 160 (augmented)
Evasion Rating: 160 (augmented)
--------
Requirements:
Level: 70
Str: 62
Dex: 62
--------
Sockets: W-B-G-G
--------
Item Level: 84
--------
16% chance to Avoid being Stunned if you've Killed Recently (enchant)
--------
+12% to Fire and Cold Resistances (implicit)
--------
Socketed Gems are Supported by Level 20 Fortify
+42% to Fire Resistance
+41% to Lightning Resistance
30% increased Movement Speed
+20% to Fire and Cold Resistances (crafted)
--------
Corrupted
--------
Elder Item
Hunter Item
--------
Note: ~price 3 divine`;

// Eldritch implicits (advanced copy) on a helmet; the "... Item" lines are appended to the last section.
const HELM_ELDRITCH = `Item Class: Helmets
Rarity: Rare
Havoc Crown
Hubris Circlet
--------
Quality: +20% (augmented)
Energy Shield: 312 (augmented)
--------
Requirements:
Level: 69
Int: 154
--------
Sockets: B-B-B-G
--------
Item Level: 85
--------
{ Searing Exarch Implicit Modifier (Greater) — Elemental, Cold, Resistance }
Nearby Enemies have -9(-9--8)% to Cold Resistance (implicit)
{ Eater of Worlds Implicit Modifier (Grand) — Mana }
14(13-15)% increased Mana Reservation Efficiency of Skills (implicit)
--------
{ Prefix Modifier "Seraphim's" (Tier: 1) — Defences, Energy Shield }
104(101-110)% increased Energy Shield
{ Prefix Modifier "Vigorous" (Tier: 5) — Life }
+73(70-79) to maximum Life
{ Suffix Modifier "of the Rainbow" (Tier: 4) — Elemental, Resistance }
+11(10-12)% to all Elemental Resistances
{ Suffix Modifier "of the Lightning" (Tier: 1) — Elemental, Lightning, Resistance }
+47(46-48)% to Lightning Resistance
Searing Exarch Item
Eater of Worlds Item`;

// Synthesised, corrupted rare ring.
const RING_SYNTH = `Item Class: Rings
Rarity: Rare
Kraken Coil
Synthesised Diamond Ring
--------
Requirements:
Level: 60
--------
Item Level: 84
--------
+18% to Fire Resistance (implicit)
6% increased maximum Life (implicit)
--------
+29 to maximum Mana
+14 to all Attributes
+78 to maximum Life
+41% to Lightning Resistance
+13% to Fire and Chaos Resistances (crafted)
--------
Corrupted
--------
Synthesised Item`;

// A plain rare ring: looks the same in both games.
const RING_PLAIN = `Item Class: Rings
Rarity: Rare
Blight Eye
Steel Ring
--------
Requirements:
Level: 80
--------
Item Level: 83
--------
Adds 4 to 16 Physical Damage to Attacks (implicit)
--------
+55 to Strength
+71 to maximum Life
11% increased Rarity of Items found`;

// Rare amulet with an anointment.
const AMULET = `Item Class: Amulets
Rarity: Rare
Beast Clasp
Turquoise Amulet
--------
Quality (Attribute Modifiers): +20% (augmented)
--------
Requirements:
Level: 60
--------
Item Level: 84
--------
Allocates Swift Skewering (enchant)
--------
+24 to Dexterity and Intelligence (implicit)
--------
+49 to Dexterity
Adds 14 to 27 Physical Damage to Attacks
20% increased Cold Damage
+15% to all Elemental Resistances`;

// Talisman: an amulet with a tier line, always corrupted.
const TALISMAN = `Item Class: Amulets
Rarity: Rare
Soul Gorget
Monkey Twig Talisman
--------
Talisman Tier: 2
--------
Item Level: 75
--------
6% increased Attack Speed (implicit)
--------
+56 to maximum Life
+30 to Dexterity
+32% to Global Critical Strike Multiplier
+29% to Cold Resistance
--------
Corrupted`;

// Rare jewel with help text.
const JEWEL = `Item Class: Jewels
Rarity: Rare
Entropy Shard
Crimson Jewel
--------
Item Level: 81
--------
20% increased Damage with Bleeding (fractured)
+12% to Global Critical Strike Multiplier
+17% to Critical Strike Multiplier with One Handed Melee Weapons
7% increased maximum Life
--------
Place into an allocated Jewel Socket on the Passive Skill Tree. Right click to remove from the Socket.`;

// Abyss jewel, advanced copy.
const ABYSS = `Item Class: Abyss Jewels
Rarity: Rare
Dusk Eye
Murderous Eye Jewel
--------
Abyss
--------
Requirements:
Level: 45
--------
Item Level: 84
--------
{ Prefix Modifier "Hale" (Tier: 3) — Life }
+33(31-35) to maximum Life
{ Prefix Modifier "Sharpened" (Tier: 2) — Damage, Physical, Attack }
Adds 6(5-7) to 12(11-13) Physical Damage to Attacks
{ Suffix Modifier "of Fury" (Tier: 1) — Damage, Critical }
+15(14-16)% to Critical Strike Multiplier with Two Handed Melee Weapons
--------
Place into an Abyssal Socket on an Item or into an allocated Jewel Socket on the Passive Skill Tree. Right click to remove from the Socket.`;

// Large cluster jewel.
const CLUSTER = `Item Class: Jewels
Rarity: Rare
Soul Cut
Large Cluster Jewel
--------
Requirements:
Level: 40
--------
Item Level: 81
--------
Adds 8 Passive Skills (enchant)
2 Added Passive Skills are Jewel Sockets (enchant)
Added Small Passive Skills grant: 12% increased Physical Damage (enchant)
--------
Added Small Passive Skills also grant: +3 to Intelligence
1 Added Passive Skill is Furious Assault
1 Added Passive Skill is Iron Breaker
1 Added Passive Skill is Master the Fundamentals
--------
Place into an allocated Large Jewel Socket on the Passive Skill Tree. Added passives do not interact with jewel radiuses. Right click to remove from the Socket.`;

// Life flask.
const LIFE_FLASK = `Item Class: Life Flasks
Rarity: Magic
Bubbling Divine Life Flask of Staunching
--------
Quality: +20% (augmented)
Recovers 1440 (augmented) Life over 3.00 Seconds
Consumes 15 of 45 Charges on use
Currently has 45 Charges
--------
Requirements:
Level: 60
--------
Item Level: 84
--------
{ Prefix Modifier "Bubbling" (Tier: 1) }
50% reduced Amount Recovered
135% increased Recovery rate
50% of Recovery applied Instantly
{ Suffix Modifier "of Staunching" (Tier: 1) }
Grants Immunity to Bleeding for 4 seconds if used while Bleeding
Grants Immunity to Corrupted Blood for 4 seconds if used while affected by Corrupted Blood
--------
Right click to drink. Can only hold charges while in belt. Refills as you kill monsters.`;

// Utility flask: its own buff sits in the property block.
const UTILITY_FLASK = `Item Class: Utility Flasks
Rarity: Magic
Experimenter's Quicksilver Flask of Adrenaline
--------
Quality: +20% (augmented)
Lasts 4.80 (augmented) Seconds
Consumes 20 of 50 Charges on use
Currently has 50 Charges
40% increased Movement Speed
--------
Requirements:
Level: 4
--------
Item Level: 42
--------
24% increased Duration
29% increased Movement Speed during Flask effect
--------
Right click to drink. Can only hold charges while in belt. Refills as you kill monsters.`;

// Unique with flavour text.
const UNIQUE = `Item Class: Body Armours
Rarity: Unique
Kaom's Heart
Glorious Plate
--------
Armour: 776
--------
Requirements:
Level: 68
Str: 191
--------
Item Level: 83
--------
Has no Sockets
+500 to maximum Life
20% increased Fire Damage
--------
The warrior who fears will fall.
--------
Note: ~b/o 4 divine`;

// Foulborn unique (advanced copy, mutated mod).
const FOULBORN = `Item Class: Belts
Rarity: Unique
Foulborn Ryslatha's Coil
Studded Belt
--------
Requirements:
Level: 32
--------
Item Level: 71
--------
{ Implicit Modifier — Stun }
27(20-30)% increased Stun Duration on Enemies (implicit)
--------
{ Unique Modifier — Attribute }
+30(20-40) to Strength
{ Foulborn Unique Modifier — Damage, Physical, Attack }
48(30-50)% more Maximum Physical Attack Damage
{ Unique Modifier — Life }
+83(60-80) to maximum Life
--------
All things that slither, writhe and coil.`;

// Unidentified rare.
const UNID = `Item Class: Boots
Rarity: Rare
Titan Greaves
--------
Armour: 247
--------
Requirements:
Level: 68
Str: 120
--------
Sockets: R-R-G-B
--------
Item Level: 82
--------
Unidentified
--------
Hunter Item`;

// Weapons PoE2 doesn't have (or not like this).
const CLAW = `Item Class: Claws
Rarity: Rare
Gale Grip
Imperial Claw
--------
Claw
Quality: +20% (augmented)
Physical Damage: 55-145 (augmented)
Elemental Damage: 10-20 (augmented)
Critical Strike Chance: 6.30%
Attacks per Second: 1.60 (augmented)
Weapon Range: 1.1 metres
--------
Requirements:
Level: 68
Dex: 131
Int: 95
--------
Sockets: G-G-B
--------
Item Level: 84
--------
{ Implicit Modifier — Life, Attack }
Grants 46 Life per Enemy Hit (implicit)
--------
{ Prefix Modifier "Merciless" (Tier: 1) — Damage, Physical, Attack }
170(155-169)% increased Physical Damage
{ Prefix Modifier "Fuming" (Tier: 7) — Damage, Elemental, Cold, Attack }
Adds 10(9-12) to 20(18-21) Cold Damage
{ Suffix Modifier "of Celebration" (Tier: 1) — Attack, Speed }
14(14-16)% increased Attack Speed
{ Master Crafted Suffix Modifier "of Craft" (Rank: 3) — Critical }
+25(24-26)% to Global Critical Strike Multiplier (crafted)`;

const mkWeapon = (cls, type, base, extra = '') => `Item Class: ${cls}
Rarity: Rare
Test Fang
${base}
--------
${type}
Physical Damage: 20-80
Critical Strike Chance: 7.00%
Attacks per Second: 1.20
--------
Item Level: 80
--------
+40 to Dexterity${extra}`;

const QUIVER = `Item Class: Quivers
Rarity: Rare
Grim Fletch
Penetrating Arrow Quiver
--------
Requirements:
Level: 61
--------
Item Level: 84
--------
Arrows Pierce an additional Target (implicit)
--------
+92 to maximum Life
+40% to Cold Resistance
+35% to Global Critical Strike Multiplier for Bows`;

// "Veiled" mods and the "cannot use" note.
const VEILED = `Item Class: Gloves
Rarity: Rare
You cannot use this item. Its stats will be ignored
--------
Woe Caress
Fingerless Silk Gloves
--------
Energy Shield: 64
--------
Requirements:
Level: 70 (unmet)
Int: 95
--------
Sockets: R-G-B-B A
--------
Item Level: 78
--------
16% increased Spell Damage (implicit)
--------
+92 to maximum Life
+24% to Fire Resistance
Veiled Suffix
--------
Mirrored`;

const keys = (it) => Object.keys(it.stats).sort();
const noJunk = (it) => {
  const bad = Object.keys(it.stats).filter((k) => /Sockets|Item$|Charges|Requirements|Passive Skill|Place into|Right click|Recovers|Lasts|Talisman|Synthesised|Fractured|Note|Level:|^Corrupted$|^Abyss$/i.test(k));
  assert.deepStrictEqual(bad, [], `junk stat keys on ${it.name}`);
};

test('poe1: advanced body armour (3.29 Ctrl+C)', () => {
  const it = parseItem(BODY_ADV);
  noJunk(it);
  assert.strictEqual(it.slot, 'Body Armour');
  assert.strictEqual(it.baseType, 'Astral Plate');
  assert.strictEqual(it.requiredLevel, 62);
  assert.strictEqual(it.itemLevel, 86);
  assert.strictEqual(it.sockets, 'R-R-R-G-B B');
  assert.strictEqual(it.links, 5);
  assert.strictEqual(it.socketCount, 6);
  assert.strictEqual(it.fractured, true);
  assert.deepStrictEqual(it.stats, {
    '[Base] Armour': 1214,
    '#% to Fire Resistance': 56, '#% to Cold Resistance': 50, '#% to Lightning Resistance': 37,
    '# to maximum Life': 119, '#% increased Armour': 85,
  });
  const tag = (re) => it.lines.find((l) => re.test(l.text)).tag;
  assert.strictEqual(tag(/all Elemental/), 'implicit');
  assert.strictEqual(tag(/Fire Resistance/), 'fractured');
  assert.strictEqual(tag(/Lightning Resistance/), 'crafted');
  assert.strictEqual(tag(/Cold Resistance/), 'explicit');
  // crafted mods take an affix slot
  assert.deepStrictEqual(it.affixes, { known: true, prefixes: 2, suffixes: 3, openPrefix: 1, openSuffix: 0 });
  assert.ok(!it.lines.some((l) => /Fractured Item/.test(l.text) && l.tag !== 'info'));
});

test('poe1: plain and advanced copies give the same stats', () => {
  const a = parseItem(BODY_ADV); const p = parseItem(BODY_PLAIN);
  assert.deepStrictEqual(p.stats, a.stats);
  assert.deepStrictEqual(p.lines.filter((l) => l.key).map((l) => [l.key, l.value, l.tag]), a.lines.filter((l) => l.key).map((l) => [l.key, l.value, l.tag]));
  assert.strictEqual(p.affixes.known, false);
  assert.strictEqual(p.links, 5);
});

test('poe1: influences, enchant, corrupted, note', () => {
  const it = parseItem(BOOTS_INFLUENCED);
  noJunk(it);
  assert.strictEqual(it.slot, 'Boots');
  assert.deepStrictEqual(it.influences, ['elder', 'hunter']);
  assert.strictEqual(it.corrupted, true);
  assert.strictEqual(it.links, 4);
  assert.strictEqual(it.sockets, 'W-B-G-G');
  assert.strictEqual(it.stats['#% to Fire Resistance'], 12 + 42 + 20);
  assert.strictEqual(it.stats['#% to Cold Resistance'], 32);
  assert.strictEqual(it.stats['[Base] Evasion Rating'], 160);
  assert.strictEqual(it.lines.find((l) => /Stunned/.test(l.text)).tag, 'enchant');
  assert.ok(!it.lines.some((l) => /Item$|Note/.test(l.text)));
  assert.strictEqual(it.eldritch, undefined);
});

test('poe1: Searing Exarch / Eater of Worlds implicits', () => {
  const it = parseItem(HELM_ELDRITCH);
  noJunk(it);
  assert.deepStrictEqual(it.eldritch, { exarch: true, eater: true, exarchRank: 'Greater', eaterRank: 'Grand' });
  assert.strictEqual(it.influences, undefined);
  assert.strictEqual(it.stats['Nearby Enemies have #% to Cold Resistance'], -9);
  assert.strictEqual(it.stats['#% increased Mana Reservation Efficiency of Skills'], 14);
  assert.strictEqual(it.lines.find((l) => /Mana Reservation/.test(l.text)).tag, 'implicit');
  assert.deepStrictEqual(it.affixes, { known: true, prefixes: 2, suffixes: 2, openPrefix: 1, openSuffix: 1 });
  assert.strictEqual(it.stats['#% to Lightning Resistance'], 58);
  assert.strictEqual(it.lines.length, 7); // base ES + 2 implicits + 4 mods
});

test('poe1: synthesised corrupted ring', () => {
  const it = parseItem(RING_SYNTH);
  noJunk(it);
  assert.strictEqual(it.slot, 'Ring');
  assert.strictEqual(it.synthesised, true);
  assert.strictEqual(it.baseType, 'Diamond Ring');
  assert.strictEqual(it.name, 'Kraken Coil');
  assert.strictEqual(it.corrupted, true);
  assert.strictEqual(it.stats['#% to Fire Resistance'], 31);
  assert.strictEqual(it.stats['#% to Chaos Resistance'], 13);
  assert.strictEqual(it.stats['# to Intelligence'], 14);
  assert.strictEqual(it.stats['#% increased maximum Life'], 6);
});

test('poe1: rings, amulets and talismans', () => {
  const r = parseItem(RING_PLAIN);
  assert.deepStrictEqual(keys(r), ['# to Strength', '# to maximum Life', '#% increased Rarity of Items found', 'Adds # to # Physical Damage to Attacks']);
  for (const k of ['sockets', 'influences', 'synthesised', 'fractured', 'eldritch', 'flask']) assert.strictEqual(r[k], undefined, k);
  const a = parseItem(AMULET);
  noJunk(a);
  assert.strictEqual(a.slot, 'Amulet');
  assert.strictEqual(a.stats['# to Dexterity'], 73);
  assert.strictEqual(a.stats['# to Intelligence'], 24);
  assert.strictEqual(a.lines.find((l) => /Allocates/.test(l.text)).tag, 'enchant');
  const t = parseItem(TALISMAN);
  noJunk(t);
  assert.strictEqual(t.slot, 'Amulet');
  assert.strictEqual(t.twoHanded, false);
  assert.strictEqual(t.talismanTier, 2);
  assert.strictEqual(t.corrupted, true);
  assert.strictEqual(t.stats['#% to Global Critical Strike Multiplier'], 32);
  assert.ok(!t.lines.some((l) => /Talisman Tier/.test(l.text)));
});

test('poe1: jewels, abyss jewels and cluster jewels', () => {
  const j = parseItem(JEWEL);
  noJunk(j);
  assert.strictEqual(j.slot, 'Jewel');
  assert.strictEqual(j.fractured, true);
  assert.strictEqual(j.stats['#% increased maximum Life'], 7);
  assert.strictEqual(j.lines.find((l) => /Place into/.test(l.text)).tag, 'info');
  const a = parseItem(ABYSS);
  noJunk(a);
  assert.strictEqual(a.slot, 'Jewel');
  assert.strictEqual(a.abyss, true);
  assert.strictEqual(a.cluster, undefined);
  assert.strictEqual(a.requiredLevel, 45);
  assert.strictEqual(a.stats['Adds # to # Physical Damage to Attacks'], 9);
  assert.deepStrictEqual(a.affixes, { known: true, prefixes: 2, suffixes: 1, openPrefix: 0, openSuffix: 1 });
  assert.ok(!a.lines.some((l) => l.text === 'Abyss'));
  const c = parseItem(CLUSTER);
  noJunk(c);
  assert.strictEqual(c.slot, 'Jewel');
  assert.deepStrictEqual(c.cluster, {
    size: 'large', passives: 8, jewelSockets: 2,
    smallGrants: ['12% increased Physical Damage', '+3 to Intelligence'],
    notables: ['Furious Assault', 'Iron Breaker', 'Master the Fundamentals'],
  });
  assert.deepStrictEqual(c.stats, {});
  assert.strictEqual(c.lines.find((l) => /^Adds 8/.test(l.text)).tag, 'enchant');
});

test('poe1: flasks', () => {
  const f = parseItem(LIFE_FLASK);
  noJunk(f);
  assert.strictEqual(f.flask, true);
  assert.strictEqual(f.slot, 'Life Flask');
  assert.strictEqual(f.stats['#% increased Amount Recovered'], -50);
  assert.strictEqual(f.stats['#% of Recovery applied Instantly'], 50);
  assert.ok(f.lines.filter((l) => /Charges|Recovers/.test(l.text)).every((l) => l.tag === 'info' && !l.key));
  assert.strictEqual(f.lines.find((l) => /Right click/.test(l.text)).tag, 'info');
  const u = parseItem(UTILITY_FLASK);
  noJunk(u);
  assert.strictEqual(u.flask, true);
  assert.strictEqual(u.slot, null); // no utility flask slot in the shared list
  // the flask's own buff (property block) is not a mod; its explicit mods are
  assert.strictEqual(u.stats['#% increased Movement Speed'], undefined);
  assert.strictEqual(u.lines.find((l) => l.text === '40% increased Movement Speed').tag, 'flask');
  assert.strictEqual(u.stats['#% increased Movement Speed during Flask effect'], 29);
  assert.strictEqual(parseItem('Item Class: Mana Flasks\nRarity: Normal\nDivine Mana Flask\n--------\nRecovers 700 Mana over 6.50 Seconds\nConsumes 10 of 45 Charges on use\nCurrently has 0 Charges\n--------\nItem Level: 70').slot, 'Mana Flask');
  assert.strictEqual(parseItem('Item Class: Hybrid Flasks\nRarity: Normal\nHallowed Hybrid Flask\n--------\nItem Level: 70').slot, null);
});

test('poe1: uniques, foulborn and unidentified', () => {
  const u = parseItem(UNIQUE);
  noJunk(u);
  assert.deepStrictEqual(keys(u), ['# to maximum Life', '#% increased Fire Damage', '[Base] Armour']);
  assert.strictEqual(u.name, "Kaom's Heart");
  const f = parseItem(FOULBORN);
  assert.strictEqual(f.foulborn, true);
  assert.strictEqual(f.name, "Ryslatha's Coil");
  assert.strictEqual(f.stats['#% more Maximum Physical Attack Damage'], 48);
  assert.strictEqual(f.stats['# to Strength'], 30);
  assert.strictEqual(f.affixes.known, false); // uniques have no open affixes
  const n = parseItem(UNID);
  noJunk(n);
  assert.strictEqual(n.unidentified, true);
  assert.strictEqual(n.name, 'Titan Greaves');
  assert.strictEqual(n.baseType, 'Titan Greaves');
  assert.deepStrictEqual(n.influences, ['hunter']);
  assert.deepStrictEqual(keys(n), ['[Base] Armour']);
});

test('poe1: weapon classes, DPS and two-handed', () => {
  const c = parseItem(CLAW);
  noJunk(c);
  assert.strictEqual(c.slot, 'Weapon');
  assert.strictEqual(c.twoHanded, false);
  assert.strictEqual(c.stats['[Weapon] Physical DPS'], 160);
  assert.strictEqual(c.stats['[Weapon] Elemental DPS'], 24);
  assert.strictEqual(c.stats['[Weapon] Critical Hit Chance'], 6.3);
  assert.strictEqual(c.stats['#% to Global Critical Strike Multiplier'], 25);
  // the weapon-type line is info (in a long property block it's left out, as before)
  assert.ok(c.lines.filter((l) => l.text === 'Claw').every((l) => l.tag === 'info'));
  assert.strictEqual(c.lines.find((l) => /Weapon Range/.test(l.text)).tag, 'info');
  assert.deepStrictEqual(c.affixes, { known: true, prefixes: 2, suffixes: 2, openPrefix: 1, openSuffix: 1 });
  const cases = [
    ['Daggers', 'Dagger', 'Ambusher', false], ['Rune Daggers', 'Rune Dagger', 'Platinum Kris', false],
    ['Wands', 'Wand', 'Imbued Wand', false], ['Bows', 'Bow', 'Thicket Bow', false],
    ['Staves', 'Staff', 'Eclipse Staff', true], ['Warstaves', 'Warstaff', 'Maelström Staff', true],
    ['Thrusting One Hand Swords', 'Thrusting One Handed Sword', 'Vaal Rapier', false],
    ['One Hand Axes', 'One Handed Axe', 'Runic Hatchet', false], ['Two Hand Swords', 'Two Handed Sword', 'Reaver Sword', true],
    ['Sceptres', 'Sceptre', 'Void Sceptre', false], ['Fishing Rods', 'Fishing Rod', 'Fishing Rod', true],
  ];
  for (const [cls, type, base, two] of cases) {
    const w = parseItem(mkWeapon(cls, type, base));
    assert.strictEqual(w.slot, 'Weapon', cls);
    assert.strictEqual(w.twoHanded, two, cls);
    assert.strictEqual(w.stats['[Weapon] Physical DPS'], 60, cls);
    assert.deepStrictEqual(keys(w).filter((k) => !k.startsWith('[')), ['# to Dexterity'], cls);
    assert.strictEqual(w.lines.find((l) => l.text === type).tag, 'info', cls);
  }
  const q = parseItem(QUIVER);
  assert.strictEqual(q.slot, 'Offhand');
  assert.strictEqual(q.stats['#% to Global Critical Strike Multiplier for Bows'], 35);
});

test('poe1: veiled, mirrored, abyssal socket and "cannot use" note', () => {
  const it = parseItem(VEILED);
  noJunk(it);
  assert.strictEqual(it.name, 'Woe Caress');
  assert.strictEqual(it.baseType, 'Fingerless Silk Gloves');
  assert.strictEqual(it.slot, 'Gloves');
  assert.strictEqual(it.requiredLevel, 70);
  assert.strictEqual(it.veiled, true);
  assert.strictEqual(it.mirrored, true);
  assert.strictEqual(it.sockets, 'R-G-B-B A');
  assert.strictEqual(it.links, 4);
  assert.deepStrictEqual(keys(it), ['# to maximum Life', '#% increased Spell Damage', '#% to Fire Resistance', '[Base] Energy Shield']);
});

test('poe1: slots map onto the shared slot list only', () => {
  for (const cls of ['Claws', 'Daggers', 'Rune Daggers', 'Wands', 'Bows', 'Staves', 'Warstaves', 'Thrusting One Hand Swords']) assert.strictEqual(slotForClass(cls), 'Weapon', cls);
  assert.strictEqual(slotForClass('Quivers'), 'Offhand');
  assert.strictEqual(slotForClass('Abyss Jewels'), 'Jewel');
  assert.strictEqual(slotForClass('Utility Flasks'), null);
  assert.strictEqual(slotForClass('Tinctures'), null);
  assert.strictEqual(slotForClass('Trinkets'), null);
  assert.strictEqual(isTwoHanded('Warstaves'), true);
  assert.strictEqual(isTwoHanded('Bows'), false); // the quiver is its offhand
  assert.ok(!SLOTS.includes('Ring 3') && !SLOTS.includes('Flask 3'));
});

test('poe1: item text tells the game', () => {
  for (const t of [BODY_ADV, BODY_PLAIN, BOOTS_INFLUENCED, HELM_ELDRITCH, RING_SYNTH, TALISMAN, JEWEL, ABYSS, CLUSTER, UTILITY_FLASK, UNID, CLAW, QUIVER, VEILED]) {
    assert.strictEqual(G.gameFromItemText(t), 'poe1', t.split('\n').slice(0, 3).join(' / '));
  }
  // looks the same in both games
  assert.strictEqual(G.gameFromItemText(RING_PLAIN), null);
  assert.strictEqual(G.gameFromItemText(LIFE_FLASK), null);
  assert.strictEqual(G.gameFromItemText(UNIQUE), null);
});

// PoE2: every item text the other tests parse (plus two more), as the parser read them before
// PoE1 support. Fields must be unchanged; the only differences allowed are PoE1-style flags that
// also apply in PoE2 (fractured, flask) and non-mod lines (weapon type, "Fractured Item") now
// tagged 'info' (same text, still no stat).
test('poe2: items parse as before', () => {
  const baseline = require('./fixtures/poe2-parse-baseline.json');
  assert.ok(baseline.length >= 30);
  const ADDED = ['fractured', 'flask'];
  for (const { text, parsed: was } of baseline) {
    const now = JSON.parse(JSON.stringify(parseItem(text)));
    // a unique's keyword mods ("Cannot be Ignited") are shown now; they were left out before
    if (now.rarity === 'Unique') now.lines = now.lines.filter((l) => !(l.kw && l.key === null && !was.lines.some((o) => o.text === l.text)));
    const label = text.split('\n').slice(0, 3).join(' / ');
    for (const k of Object.keys(now)) if (!(k in was)) assert.ok(ADDED.includes(k), `${label}: new field ${k}`);
    for (const k of Object.keys(was)) {
      if (k === 'lines') continue;
      assert.deepStrictEqual(now[k], was[k], `${label}: ${k}`);
    }
    assert.strictEqual(now.lines.length, was.lines.length, `${label}: lines`);
    now.lines.forEach((l, i) => {
      const o = was.lines[i];
      assert.deepStrictEqual([l.text, l.key, l.value], [o.text, o.key, o.value], label);
      if (l.tag !== o.tag) assert.ok(l.key === null && l.tag === 'info', `${label}: ${l.text} ${o.tag} -> ${l.tag}`);
    });
  }
});

test('poe2: flask and charm charges are not stats', () => {
  const charm = parseItem('Item Class: Charms\nRarity: Magic\nThawing Ruby Charm\n--------\nLasts 3 Seconds\nConsumes 40 of 80 Charges on use\nCurrently has 80 Charges\nGrants Immunity to Freeze\n--------\nRequires: Level 12\n--------\nItem Level: 40\n--------\nUsed when you become Frozen');
  assert.strictEqual(charm.slot, 'Charm');
  assert.deepStrictEqual(charm.stats, {});
  assert.deepStrictEqual(charm.lines.map((l) => l.text), ['Lasts 3 Seconds', 'Consumes 40 of 80 Charges on use', 'Currently has 80 Charges', 'Grants Immunity to Freeze', 'Used when you become Frozen']);
  assert.strictEqual(G.gameFromItemText('Item Class: Quarterstaves\nRarity: Rare\nX\nY\n--------\nCritical Hit Chance: 10.00%'), 'poe2');
});
