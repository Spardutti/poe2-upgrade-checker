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

// plan: [{ slot, cls, bases: [..], affixes: [..] }], opts: { game, name, minItemLevel, when }
function build(plan, opts = {}) {
  const g = games.gameOf(opts.game);
  const minIlvl = Number(opts.minItemLevel) || (g.id === 'poe1' ? 82 : 75);
  const lines = [];
  lines.push('#===============================================================================');
  lines.push(`# PoE Upgrade Checker: upgrades for ${opts.name || 'your character'} (${g.name})`);
  lines.push(`# Made ${opts.when || new Date().toISOString().slice(0, 10)} from your Path of Building build. Your own filter follows below.`);
  lines.push('# Make it again after you change gear or build (My gear -> Loot filter).');
  lines.push('#===============================================================================');
  let blocks = 0;
  for (const p of plan) {
    const aff = [...new Set(p.affixes || [])].filter(Boolean);
    if (aff.length >= 2 && p.cls) {
      lines.push('', `# ${p.slot}: identified rares with 2+ of the mods your build values most here`, 'Show', '\tIdentified True', '\tRarity Rare', `\tClass == ${q(p.cls)}`, `\tHasExplicitMod >=2 ${aff.map(q).join(' ')}`, ...STYLE_MODS);
      blocks++;
    }
  }
  const bases = [...new Set(plan.flatMap((p) => p.bases || []))].filter(Boolean);
  if (bases.length) {
    lines.push('', `# The bases you wear, item level ${minIlvl}+ (for crafting or to identify)`, 'Show', '\tRarity Normal Magic Rare', `\tBaseType == ${bases.map(q).join(' ')}`, `\tItemLevel >= ${minIlvl}`, ...STYLE_BASE);
    blocks++;
  }
  lines.push('', '#=============================== your filter ====================================', '');
  return { text: lines.join('\n'), blocks, bases: bases.length, modBlocks: blocks - (bases.length ? 1 : 0) };
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

module.exports = { build, merge, tagsFor };
