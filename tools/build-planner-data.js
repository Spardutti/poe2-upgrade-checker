#!/usr/bin/env node
'use strict';
// Makes src/core/buildplanner-data.json, what the app needs to turn a PoE2 Build Planner file
// (.build) into a Path of Building build. Run it again when the passive tree or Path of Building
// changes (a new league):
//
//   node tools/build-planner-data.js "<path to GGG's passive tree export data.json>"
//
// - passives: a .build names passives by the game's PassiveSkills ids ("strength89"); Path of
//   Building by their tree hash. Both are in Grinding Gear Games' own passive tree export (the
//   "Skill Trees/<version>/data.json" of their developer data exports): each node has its id and
//   its skill hash. Only nodes the bundled Path of Building tree has are kept.
// - ascendancies: the game's ascendancy ids ("Sorceress3") and names, with their class, from the
//   same export (Path of Building reads the ids as they are)
// - gems: every gem the bundled Path of Building knows, by the game's id, with its top level
// - uniques: the bundled Path of Building's unique items as item text, so a guide's unique can be
//   put on the build by name
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const POB = path.join(ROOT, 'vendor', 'pob', 'src');
const OUT = path.join(ROOT, 'src', 'core', 'buildplanner-data.json');

const src = process.argv[2];
if (!src) { console.error('usage: node tools/build-planner-data.js "<GGG passive tree export data.json>"'); process.exit(2); }
const ggg = JSON.parse(fs.readFileSync(src, 'utf8'));

// the tree the bundled Path of Building uses
const versions = fs.readFileSync(path.join(POB, 'GameVersions.lua'), 'utf8');
const treeList = [...versions.match(/treeVersionList\s*=\s*\{([^}]*)\}/)[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
const treeVersion = treeList[treeList.length - 1];
const targetVersion = versions.match(/liveTargetVersion\s*=\s*"([^"]+)"/)[1];
const pobTree = JSON.parse(fs.readFileSync(path.join(POB, 'TreeData', treeVersion, 'tree.json'), 'utf8'));
const pobNodes = new Set(Object.keys(pobTree.nodes).map(Number));

const passives = {};
let skipped = 0;
for (const n of Object.values(ggg.nodes || {})) {
  if (!n || !n.id || n.skill == null) continue;
  if (!pobNodes.has(Number(n.skill))) { skipped++; continue; }
  passives[n.id] = Number(n.skill);
}

// classes: Path of Building's integer id ("classInternalId") by class name, and each ascendancy
const pobClass = {};
for (const c of pobTree.classes || []) pobClass[c.name] = c.integerId;
const ascendancies = {};
const classes = {};
for (const c of ggg.classes || []) {
  if (pobClass[c.name] == null) continue;
  classes[c.name] = pobClass[c.name];
  for (const a of c.ascendancies || []) if (a && a.id) ascendancies[a.id] = { name: a.name, className: c.name };
}

// gems: "Metadata/Items/Gems/SkillGemEarthquake" -> { name, max, support }
const gems = {};
const gemSrc = fs.readFileSync(path.join(POB, 'Data', 'Gems.lua'), 'utf8');
for (const block of gemSrc.split(/\n\t\["Metadata\/[^"]+"\] = \{/).slice(1)) {
  const id = (block.match(/\n\t\tgameId = "([^"]+)"/) || [])[1];
  const name = (block.match(/\n\t\tname = "([^"]+)"/) || [])[1];
  if (!id || gems[id]) continue;
  const attr = /\n\t\t\tstrength = true/.test(block) ? 'str' : /\n\t\t\tdexterity = true/.test(block) ? 'dex' : /\n\t\t\tintelligence = true/.test(block) ? 'int' : null;
  gems[id] = { name: name || id.split('/').pop(), max: Number((block.match(/\n\t\tnaturalMaxLevel = (\d+)/) || [])[1]) || 20, support: /\n\t\t\tsupport = true/.test(block), ...(attr ? { attr } : {}) };
}

// uniques: name -> item text from Path of Building's own list (its newest variant, rolls as ranges,
// which Path of Building takes at their middle)
const uniques = {};
const uDir = path.join(POB, 'Data', 'Uniques');
for (const f of fs.readdirSync(uDir).filter((x) => x.endsWith('.lua'))) {
  const text = fs.readFileSync(path.join(uDir, f), 'utf8');
  for (const m of text.matchAll(/\[\[\n?([\s\S]*?)\]\]/g)) {
    const lines = m[1].split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    const name = lines[0];
    if (uniques[name]) continue;
    uniques[name] = lines.join('\n');
  }
}

// base types, so a guide's rare can be found among its text ("Rare Gloves\nVaal Gloves\n1. …")
const bases = [];
const bDir = path.join(POB, 'Data', 'Bases');
for (const f of fs.readdirSync(bDir).filter((x) => x.endsWith('.lua'))) for (const m of fs.readFileSync(path.join(bDir, f), 'utf8').matchAll(/^itemBases\["([^"]+)"\]/gm)) bases.push(m[1]);

// "+5 to any Attribute" passives: a .build doesn't say which attribute was picked
const attributeNodes = Object.entries(pobTree.nodes).filter(([, n]) => n && n.isAttribute).map(([k]) => Number(k));

const out = {
  attributeNodes, bases,
  source: `Grinding Gear Games passive tree export (${ggg.tree || 'tree'}) and Path of Building ${treeVersion}`,
  treeVersion, targetVersion, classes, ascendancies, passives, gems, uniques,
};
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`${Object.keys(passives).length} passives (${skipped} not in Path of Building's tree), ${Object.keys(ascendancies).length} ascendancies, ${Object.keys(gems).length} gems, ${Object.keys(uniques).length} uniques -> ${path.relative(ROOT, OUT)} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`);
