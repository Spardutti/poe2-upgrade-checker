'use strict';

// PoE2's own build files (.build, the in-game Build Planner's format, which guide sites hand out)
// -> a Path of Building build, so a guide's build is judged like a pobb.in link.
//
// A .build is JSON: name, author, ascendancy, passives (the game's PassiveSkills ids), skills with
// their supports (the game's gem ids), and per-slot gear hints (a unique by name, or text). Any
// passive, skill or hint can have a level_interval ([from, to]): a levelling guide is one file with
// several stages. Spec: pathofexile.com/developer/docs/game (Build Planner, version 1).
//
// What it turns into (all on your PC):
//   - the passive tree at the stage you pick (weapon-set passives into Path of Building's weapon sets)
//   - the skills with their supports, at a gem level that fits the stage
//   - the guide's uniques by name, and rares the guide spells out ("Base\n1. mod\n2. mod") - only
//     in slots you haven't copied your own item into (yours always win)
// and a report of anything it couldn't place.

const MAX_FILE = 5 * 1024 * 1024;
let DATA = null;
const data = () => DATA || (DATA = require('./buildplanner-data.json'));

// a .build is JSON with a Build's fields; a PoB code or XML isn't
const isBuildFile = (text) => { const s = String(text || '').replace(/^﻿/, '').trim(); return s.startsWith('{') && /"(passives|skills|inventory_slots|ascendancy)"\s*:/.test(s); };

const idOf = (e) => (typeof e === 'string' ? e : e && typeof e.id === 'string' ? e.id : null);
function interval(e) {
  const li = e && typeof e === 'object' ? e.level_interval : null;
  if (Array.isArray(li) && li.length) return [Number(li[0]) || 0, li.length > 1 && Number.isFinite(Number(li[1])) ? Number(li[1]) : 100];
  if (li != null && Number.isFinite(Number(li))) return [Number(li), 100];
  return [0, 100];
}
const at = (e, level) => { const [a, b] = interval(e); return level >= a && level <= b; };

function parse(text) {
  const s = String(text || '').replace(/^﻿/, '');
  if (s.length > MAX_FILE) throw new Error('That file is too big to be a .build file.');
  let b;
  try { b = JSON.parse(s); } catch (_) { throw new Error("That isn't a .build file (it isn't valid JSON)."); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error("That isn't a .build file.");
  for (const k of ['passives', 'skills', 'inventory_slots']) if (b[k] != null && !Array.isArray(b[k])) throw new Error(`That .build file's "${k}" isn't a list.`);
  if (!(b.passives || []).length && !(b.skills || []).length) throw new Error('That .build file has no passives or skills in it.');
  return b;
}

// the levelling stages a file has: [{ from, to, label }], endgame last. A file without levels has one.
function stages(b) {
  const cuts = new Set([1]);
  const all = [...(b.passives || []), ...(b.skills || []), ...(b.inventory_slots || [])];
  for (const s of b.skills || []) for (const sp of s && s.support_skills || []) all.push(sp);
  for (const e of all) { const [a, z] = interval(e); if (a > 1) cuts.add(a); if (z < 100) cuts.add(z + 1); }
  const pts = [...cuts].filter((x) => x <= 100).sort((x, y) => x - y);
  const out = pts.map((from, i) => ({ from: Math.max(1, from), to: i + 1 < pts.length ? pts[i + 1] - 1 : 100 }));
  return out.map((s) => ({ ...s, label: s.from <= 1 && s.to >= 100 ? 'The build' : s.to >= 100 ? `Level ${s.from}+` : `Levels ${s.from}–${s.to}` }));
}

// the ascendancy as the game writes it ("Sorceress3") or by name ("Disciple of Varashta")
function ascendancyOf(b) {
  const d = data();
  const raw = String(b.ascendancy || '').trim();
  if (!raw) return null;
  if (d.ascendancies[raw]) return { id: raw, ...d.ascendancies[raw] };
  const byName = Object.entries(d.ascendancies).find(([, a]) => String(a.name || '').toLowerCase() === raw.toLowerCase());
  if (byName) return { id: byName[0], ...byName[1] };
  // a class name alone ("Sorceress")
  if (d.classes[raw]) return { id: '', name: '', className: raw };
  return null;
}

// a gem's level for a stage: the top level at the end of the game, else about what you'd have then
const gemLevel = (gem, stageTo) => (stageTo >= 90 ? gem.max : Math.max(1, Math.min(gem.max, Math.ceil(stageTo / 5))));

const SLOTS = {
  Weapon1: 'Weapon 1', Weapon: 'Weapon 1', Offhand1: 'Weapon 2', Offhand: 'Weapon 2', Weapon2: 'Weapon 2',
  Helm: 'Helmet', Helm1: 'Helmet', BodyArmour: 'Body Armour', BodyArmour1: 'Body Armour', Gloves: 'Gloves', Gloves1: 'Gloves',
  Boots: 'Boots', Boots1: 'Boots', Amulet: 'Amulet', Amulet1: 'Amulet', Belt: 'Belt', Belt1: 'Belt',
  Ring: 'Ring 1', Ring1: 'Ring 1', Ring2: 'Ring 2', Flask1: 'Flask 1', Flask2: 'Flask 2',
};
// the app's slot names for the same ("Weapon 1" -> "Weapon"), to know which ones you've copied yourself
const APP_SLOT = { 'Weapon 1': 'Weapon', 'Weapon 2': 'Offhand', Helmet: 'Helmet', 'Body Armour': 'Body Armour', Gloves: 'Gloves', Boots: 'Boots', Amulet: 'Amulet', Belt: 'Belt', 'Ring 1': 'Ring 1', 'Ring 2': 'Ring 2' };

// game markup ("<b>{text}</b>", "<rgb(…)>{…}") -> plain text
const plain = (t) => String(t || '').replace(/<[^>{}]*>\{([^}]*)\}/g, '$1').replace(/<[^>]*>/g, '').replace(/\{|\}/g, '').replace(/\r/g, '');

// a guide's rare: "Ancestral Tiara\n1. +41 to maximum Life\n2. …" (base first, then the mods)
let BASES = null;
function rareFromText(text) {
  const lines = plain(text).split('\n').map((l) => l.trim().replace(/^(rare|base( type)?)\s*:\s*/i, '')).filter(Boolean);
  if (lines.length < 2) return null;
  // the base: the first line that's a real base type (a heading like "Rare Gloves" can come before it)
  if (!BASES) BASES = new Set((data().bases || []).map((b) => b.toLowerCase()));
  const i = lines.findIndex((l) => BASES.has(l.toLowerCase()));
  if (i < 0) return null;
  const mods = lines.slice(i + 1).map((l) => l.replace(/^(\d+[.)]|[-•*])\s*/, '')).filter((l) => /\d/.test(l) && l.length < 120);
  if (!mods.length) return null;
  return { base: lines[i], mods };
}

// the build as Path of Building's XML. opts: { level (pick the stage), have: { slotName: true } (slots
// you've copied yourself: the guide's item isn't used there) } -> { xml, report }
function toPob(b, opts = {}) {
  const d = data();
  const level = Math.max(1, Math.min(100, Number(opts.level) || 100));
  const st = stages(b).find((s) => level >= s.from && level <= s.to) || { from: 1, to: 100 };
  const report = { name: String(b.name || 'Guide build').slice(0, 80), author: b.author ? String(b.author).slice(0, 60) : null, link: b.link ? String(b.link).slice(0, 300) : null, stage: st, missing: [], notes: [] };
  const asc = ascendancyOf(b);
  if (!asc) throw new Error(b.ascendancy ? `Unknown ascendancy "${b.ascendancy}" in that .build file (is Path of Building up to date?).` : "That .build file doesn't say which class or ascendancy it's for.");
  report.className = asc.className; report.ascendancy = asc.name || null;

  // passives at this level, with weapon-set passives kept apart
  const nodes = []; const sets = { 1: [], 2: [] }; let unknown = 0; let inStage = 0;
  for (const p of b.passives || []) {
    if (!at(p, level)) continue;
    const id = idOf(p); if (!id) continue;
    inStage++;
    const hash = d.passives[id];
    if (hash == null) { unknown++; continue; }
    nodes.push(hash);
    const ws = p && typeof p === 'object' ? Number(p.weapon_set) : 0;
    if (ws === 1 || ws === 2) sets[ws].push(hash);
  }
  report.passives = { total: inStage, placed: nodes.length };
  if (unknown) report.missing.push(`${unknown} passive${unknown === 1 ? '' : 's'} the bundled tree doesn't have (the guide may be for another patch)`);

  // skills with their supports. opts.skills (your choices, kept per character):
  //   level: 'stage' (about what you'd have at this stage; the default) | 'max' | a number for every gem
  //   quality: a number for every skill gem (supports have none in PoE2)
  //   gems: { gameId: { level, quality } } one gem set apart from the rest
  //   main: gameId of the skill items are judged on (default: the one with the most supports)
  //   full: { gameId: true } other skills counted in Path of Building's total DPS
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cfg = opts.skills || {};
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v))));
  const levelFor = (gid, g) => {
    const own = cfg.gems && cfg.gems[gid];
    if (own && Number(own.level) > 0) return clamp(own.level, 1, 40);
    if (cfg.level === 'max') return g.max;
    if (Number(cfg.level) > 0) return clamp(cfg.level, 1, 40);
    return gemLevel(g, st.to);
  };
  const qualityFor = (gid) => {
    const own = cfg.gems && cfg.gems[gid];
    if (own && own.quality != null && own.quality !== '') return clamp(own.quality, 0, 23);
    return Number(cfg.quality) > 0 ? clamp(cfg.quality, 0, 23) : 0;
  };
  const found = []; let gemsPlaced = 0; let gemsUnknown = 0;
  for (const s of b.skills || []) {
    if (!at(s, level)) continue;
    const id = idOf(s); const g = id && d.gems[id];
    if (!g) { gemsUnknown++; continue; }
    if (found.some((f) => f.id === id)) continue; // the same skill twice in a stage: once is enough
    const supports = [];
    for (const sp of (s && s.support_skills) || []) {
      if (!at(sp, level)) continue;
      const sid = idOf(sp); const sg = sid && d.gems[sid];
      if (!sg) { gemsUnknown++; continue; }
      supports.push({ id: sid, name: sg.name, gem: sg });
      gemsPlaced++;
    }
    gemsPlaced++;
    found.push({ id, name: g.name, gem: g, supports, level: levelFor(id, g), quality: qualityFor(id) });
  }
  // the main skill: yours if it's in this stage, else the one with the most supports (a guide's
  // damage skill is the one it links up most), the first one on a tie
  let main = found.find((f) => f.id === cfg.main);
  if (!main && found.length) main = found.reduce((a, f) => (f.supports.length > a.supports.length ? f : a), found[0]);
  const ordered = main ? [main, ...found.filter((f) => f !== main)] : found;
  const groups = ordered.map((f) => {
    const full = f === main || !!(cfg.full && cfg.full[f.id]);
    const sup = f.supports.map((sp) => `<Gem gemId="${esc(sp.id)}" nameSpec="${esc(sp.name)}" level="${sp.gem.support ? 1 : levelFor(sp.id, sp.gem)}" quality="${sp.gem.support ? 0 : qualityFor(sp.id)}" enabled="true"/>`).join('');
    return `<Skill enabled="true" label="" mainActiveSkill="1" includeInFullDPS="${full ? 'true' : 'false'}"><Gem gemId="${esc(f.id)}" nameSpec="${esc(f.name)}" level="${f.level}" quality="${f.quality}" enabled="true"/>${sup}</Skill>`;
  });
  report.skills = ordered.map((f) => ({ id: f.id, name: f.name, level: f.level, quality: f.quality, max: f.gem.max, supports: f.supports.map((x) => x.name), main: f === main, full: f === main || !!(cfg.full && cfg.full[f.id]), own: !!(cfg.gems && cfg.gems[f.id]) }));
  report.gems = { placed: gemsPlaced, skills: groups.length };
  if (gemsUnknown) report.missing.push(`${gemsUnknown} gem${gemsUnknown === 1 ? '' : 's'} the bundled Path of Building doesn't know`);
  if (!groups.length) report.notes.push('No skills for this stage: damage can\'t be judged until you set a skill in Path of Building.');

  // the guide's gear, where you haven't copied your own
  const items = []; const slots = []; const fromGuide = []; const uniques = [];
  for (const inv of b.inventory_slots || []) {
    if (!inv || !at(inv, level)) continue;
    const slot = SLOTS[inv.inventory_id];
    if (!slot || slots.includes(slot)) continue;
    if (opts.have && opts.have[APP_SLOT[slot]]) continue;
    let text = null;
    if (inv.unique_name && d.uniques[inv.unique_name]) {
      const u = d.uniques[inv.unique_name].split('\n');
      const variants = u.filter((l) => /^Variant:/i.test(l)).length;
      text = ['Rarity: UNIQUE', u[0], u[1], ...(variants ? [`Selected Variant: ${variants}`] : []), ...u.slice(2)].join('\n');
      uniques.push({ slot: APP_SLOT[slot] || slot, name: u[0], base: u[1] });
    } else if (inv.unique_name) { report.missing.push(`the unique ${inv.unique_name} (not in the bundled Path of Building)`); continue; } else {
      const r = rareFromText(inv.additional_text);
      if (r) text = ['Rarity: RARE', `Guide ${r.base}`, r.base, ...r.mods].join('\n');
    }
    if (!text) continue;
    items.push(`<Item id="${items.length + 1}">\n${esc(text)}\n</Item>`);
    slots.push(slot);
    fromGuide.push(`${APP_SLOT[slot] || slot}: ${inv.unique_name || 'a rare as described'}`);
  }
  report.gear = fromGuide;
  // every unique the guide uses at this stage (also in slots you've copied your own item into), for the loot filter
  report.uniques = uniques;
  for (const inv of b.inventory_slots || []) {
    if (!inv || !at(inv, level) || !inv.unique_name || !d.uniques[inv.unique_name]) continue;
    const u = d.uniques[inv.unique_name].split('\n');
    if (!uniques.some((x) => x.name === u[0])) uniques.push({ slot: APP_SLOT[SLOTS[inv.inventory_id]] || SLOTS[inv.inventory_id] || null, name: u[0], base: u[1] });
  }

  // "+5 to any attribute" passives: the build's gem colours decide (most of them go to the colour
  // most of its gems are, the rest split by the share of the others), so gem requirements come out right
  const attrNodes = new Set(d.attributeNodes || []);
  const mine = nodes.filter((h) => attrNodes.has(h));
  let overrides = '';
  if (mine.length) {
    const count = { str: 0, dex: 0, int: 0 };
    for (const s of b.skills || []) {
      if (!at(s, level)) continue;
      for (const id of [idOf(s), ...((s && s.support_skills) || []).filter((x) => at(x, level)).map(idOf)]) { const g = id && d.gems[id]; if (g && g.attr) count[g.attr]++; }
    }
    const total = count.str + count.dex + count.int;
    const order = Object.keys(count).sort((x, y) => count[y] - count[x]);
    const by = { str: [], dex: [], int: [] };
    if (!total) by.str = mine; else {
      // largest remainder: each colour gets its share of the attribute passives
      const want = Object.fromEntries(order.map((k) => [k, (count[k] / total) * mine.length]));
      const base = Object.fromEntries(order.map((k) => [k, Math.floor(want[k])]));
      let left = mine.length - Object.values(base).reduce((x, y) => x + y, 0);
      for (const k of order.slice().sort((x, y) => (want[y] - base[y]) - (want[x] - base[x]))) { if (left <= 0) break; base[k]++; left--; }
      let i = 0; for (const k of order) for (let n = 0; n < base[k]; n++) by[k].push(mine[i++]);
    }
    overrides = `<Overrides><AttributeOverride strNodes="${by.str.join(',')}" dexNodes="${by.dex.join(',')}" intNodes="${by.int.join(',')}"/></Overrides>`;
    const said = [['str', 'Strength'], ['dex', 'Dexterity'], ['int', 'Intelligence']].filter(([k]) => by[k].length).map(([k, n]) => `${by[k].length} ${n}`);
    report.notes.push(`Build Planner files don't say which attribute each "+5 to any attribute" passive takes: set to ${said.join(', ')} from the build's gems (change them in Path of Building if the guide says otherwise).`);
  }
  const setXml = [1, 2].filter((k) => sets[k].length).map((k) => `<WeaponSet${k} nodes="${sets[k].join(',')}"/>`).join('') + overrides;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<PathOfBuilding2>
<Build level="${Math.min(100, st.to)}" targetVersion="${d.targetVersion}" className="${esc(asc.className)}" ascendClassName="${esc(asc.name || 'None')}" mainSocketGroup="1" viewMode="TREE"/>
<Tree activeSpec="1"><Spec treeVersion="${d.treeVersion}" classInternalId="${d.classes[asc.className]}" ascendancyInternalId="${esc(asc.id || '')}" nodes="${nodes.join(',')}">${setXml}</Spec></Tree>
<Skills activeSkillSet="1" defaultGemLevel="normalMaximum"><SkillSet id="1">${groups.join('')}</SkillSet></Skills>
<Items activeItemSet="1">${items.join('')}<ItemSet id="1">${slots.map((sl, i) => `<Slot name="${esc(sl)}" itemId="${i + 1}"/>`).join('')}</ItemSet></Items>
<Config/>
<Notes>${esc(`From the Build Planner file "${report.name}"${report.author ? ` by ${report.author}` : ''}${report.link ? ` (${report.link})` : ''}.`)}</Notes>
</PathOfBuilding2>`;
  return { xml, report };
}

// in words, for the import message: "Tree: 112 passives · 6 skills, 22 supports · guide gear: Gloves, Boots"
function summary(report) {
  const bits = [`${report.passives.placed} passive${report.passives.placed === 1 ? '' : 's'}`, `${report.gems.skills} skill${report.gems.skills === 1 ? '' : 's'} with ${report.gems.placed - report.gems.skills} support${report.gems.placed - report.gems.skills === 1 ? '' : 's'}`];
  if (report.gear.length) bits.push(`the guide's ${report.gear.map((g) => g.split(':')[0]).join(', ')}`);
  return bits.join(', ');
}

module.exports = { isBuildFile, parse, stages, toPob, summary, rareFromText, interval };
