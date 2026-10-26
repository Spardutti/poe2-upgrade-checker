'use strict';

// A loot filter section made from your build, to put in front of your own filter:
//  - rares on the bases you wear, at a high item level (they drop unidentified, so the base is
//    all a filter can see)
//  - identified rares with at least two of the top-tier mods Path of Building values most for that
//    slot ("HasExplicitMod" with the affix names, e.g. "Virile", "of Tzteosh"); both games' filters
//    have it (NeverSink's PoE2 filter uses it too)
// The game reads one filter file, so the app writes a new file: this section, then your filter.

const games = require('./games');

const q = (s) => `"${String(s).replace(/"/g, '')}"`;
const STYLE_MODS = ['\tSetFontSize 45', '\tSetTextColor 255 255 255 255', '\tSetBorderColor 230 190 110 255', '\tSetBackgroundColor 70 20 20 240', '\tPlayAlertSound 2 300', '\tPlayEffect Yellow', '\tMinimapIcon 0 Yellow Star'];
const STYLE_BASE = ['\tSetFontSize 40', '\tSetBorderColor 201 164 99 255', '\tPlayEffect Yellow Temp', '\tMinimapIcon 2 Yellow Diamond'];

const STYLE_BETTER = ['\tSetFontSize 40', '\tSetBorderColor 120 200 255 255', '\tPlayEffect Blue Temp', '\tMinimapIcon 2 Blue Diamond'];
const STYLE_UNIQUE = ['\tSetFontSize 45', '\tSetTextColor 175 96 37 255', '\tSetBorderColor 255 140 40 255', '\tSetBackgroundColor 40 20 5 240', '\tPlayAlertSound 3 300', '\tPlayEffect Orange', '\tMinimapIcon 0 Orange Star'];
const STYLE_RUNE = ['\tSetFontSize 42', '\tSetBorderColor 160 255 160 255', '\tPlayEffect Green', '\tMinimapIcon 1 Green Circle'];

// plan: [{ slot, cls, bases: [..], better: [..], affixes: [..] }]
// opts: { game, name, minItemLevel, when, level (your level: while levelling bases start there),
//   uniques: [{ name, base }] (the guide's uniques you don't have), runes: [names] (the best runes for your sockets) }
function build(plan, opts = {}) {
  const g = games.gameOf(opts.game);
  const top = g.id === 'poe1' ? 82 : 75;
  const lv = Number(opts.level) || 0;
  // while levelling, items drop at about the area's level: bases from your level up, not only end-game ones
  const minIlvl = Number(opts.minItemLevel) || (lv > 0 && lv < top - 5 ? Math.max(1, lv - 2) : top);
  const lines = [];
  lines.push('#===============================================================================');
  lines.push(`# PoE Upgrade Checker: upgrades for ${opts.name || 'your character'} (${g.name})`);
  lines.push(`# Made ${opts.when || new Date().toISOString().slice(0, 10)} from your Path of Building build. Your own filter follows below.`);
  lines.push('# Make it again after you change gear or build (My gear -> Loot filter).');
  lines.push('#===============================================================================');
  let blocks = 0;
  const uniques = (opts.uniques || []).filter((u) => u && u.base);
  if (uniques.length) {
    lines.push('', `# Uniques your build uses that you don't have yet: ${uniques.map((u) => u.name).join(', ')}`, 'Show', '\tRarity Unique', `\tBaseType == ${[...new Set(uniques.map((u) => u.base))].map(q).join(' ')}`, ...STYLE_UNIQUE);
    blocks++;
  }
  const runes = [...new Set(opts.runes || [])].filter(Boolean);
  if (runes.length) {
    lines.push('', '# The best runes and soul cores for your sockets (Character page -> Best runes)', 'Show', `\tBaseType == ${runes.map(q).join(' ')}`, ...STYLE_RUNE);
    blocks++;
  }
  for (const p of plan) {
    const aff = [...new Set(p.affixes || [])].filter(Boolean);
    if (aff.length >= 2 && p.cls) {
      lines.push('', `# ${p.slot}: identified magic and rare items with 2+ of the mods your build values most here`, 'Show', '\tIdentified True', '\tRarity Magic Rare', `\tClass == ${q(p.cls)}`, `\tHasExplicitMod >=2 ${aff.map(q).join(' ')}`, ...STYLE_MODS);
      blocks++;
    }
  }
  const better = [...new Set(plan.flatMap((p) => p.better || []))].filter(Boolean);
  if (better.length) {
    lines.push('', `# Better bases of the kinds you wear (more base defence or damage), item level ${minIlvl}+`, 'Show', '\tRarity Normal Magic Rare', `\tBaseType == ${better.map(q).join(' ')}`, `\tItemLevel >= ${minIlvl}`, ...STYLE_BETTER);
    blocks++;
  }
  const bases = [...new Set(plan.flatMap((p) => p.bases || []))].filter(Boolean);
  if (bases.length) {
    lines.push('', `# The bases you wear, item level ${minIlvl}+ (for crafting or to identify)`, 'Show', '\tRarity Normal Magic Rare', `\tBaseType == ${bases.map(q).join(' ')}`, `\tItemLevel >= ${minIlvl}`, ...STYLE_BASE);
    blocks++;
  }
  lines.push('', '#=============================== your filter ====================================', '');
  const modBlocks = plan.filter((p) => [...new Set(p.affixes || [])].filter(Boolean).length >= 2 && p.cls).length;
  return { text: lines.join('\n'), blocks, bases: bases.length, better: better.length, uniques: uniques.length, runes: runes.length, modBlocks, minIlvl, sig: signature(plan, opts) };
}
// what the filter was made from, so the app can say when it's out of date (your bases, the better
// ones, the guide's uniques, the runes, and whether you were levelling)
function signature(plan, opts = {}) {
  const lv = Number(opts.level) || 0;
  const parts = [plan.map((p) => `${p.slot}:${(p.bases || []).join('|')}>${(p.better || []).join('|')}#${(p.affixes || []).length}`).join(';'),
    (opts.uniques || []).map((u) => u.name).sort().join('|'), [...new Set(opts.runes || [])].sort().join('|'), lv > 0 && lv < 70 ? `lv${Math.floor(lv / 10)}` : 'end'];
  let h = 0; const str = parts.join('/');
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// this section in front of your filter (a previous one is replaced, not stacked)
const START = '#===============================================================================\n# PoE Upgrade Checker:';
const END = '#=============================== your filter ====================================';
function merge(section, existing) {
  let rest = String(existing || '');
  if (rest.startsWith(START)) { const i = rest.indexOf(END); if (i >= 0) rest = rest.slice(i + END.length).replace(/^\r?\n+/, ''); }
  return section.text + '\n' + rest;
}

// which PoE1 mod tags an item slot rolls with (Path of Building's weightKey names)
function tagsFor(slot, item) {
  const cls = String((item && item.itemClass) || '').toLowerCase();
  if (/^Ring/.test(slot)) return ['ring'];
  return ({ Amulet: ['amulet'], Belt: ['belt'], Helmet: ['helmet'], 'Body Armour': ['body_armour'], Gloves: ['gloves'], Boots: ['boots'] })[slot]
    || (slot === 'Offhand' && /shield/.test(cls) ? ['shield'] : slot === 'Offhand' && /quiver/.test(cls) ? ['quiver'] : slot === 'Offhand' && /foc/.test(cls) ? ['focus'] : null);
}

module.exports = { build, merge, tagsFor, signature };
