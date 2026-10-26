'use strict';

// Your resistances, kept in step with your gear.
//
// What you enter (or import from PoB) is a snapshot taken with the gear you had then. We also
// remember how much of each resistance that gear gave, so when you change an item later the
// totals move with it: live = entered - gear then + gear now.
//
// PoB's numbers can include things that aren't always on in game (charms, flasks, buffs and
// conditions ticked in its Configuration tab), and typed-in numbers can be a little old, so a
// resistance only counts as "safely capped" when it's over the cap by a margin (the buffer).

const { MAIN_SLOTS } = require('./slots');

const ELS = [['fire', 'Fire'], ['cold', 'Cold'], ['lightning', 'Lightning'], ['chaos', 'Chaos']];
const DEFAULT_BUFFER = { pob: 15, game: 5, manual: 10 };

function itemRes(it) {
  const out = { fire: 0, cold: 0, lightning: 0, chaos: 0 };
  if (!it || !it.stats) return out;
  for (const [el, El] of ELS) out[el] += Number(it.stats[`#% to ${El} Resistance`]) || 0;
  return out;
}
function gearRes(equipped) {
  const out = { fire: 0, cold: 0, lightning: 0, chaos: 0 };
  for (const [slot, it] of Object.entries(equipped || {})) {
    if (!it || !MAIN_SLOTS.includes(slot)) continue;
    const r = itemRes(it);
    for (const [el] of ELS) out[el] += r[el];
  }
  return out;
}
// +% to Maximum X Resistance from gear (Ruby/Sapphire/Topaz Legacies, some uniques)
function gearMax(equipped) {
  const out = { fire: 0, cold: 0, lightning: 0, chaos: 0 };
  for (const [slot, it] of Object.entries(equipped || {})) {
    if (!it || !it.stats || !MAIN_SLOTS.includes(slot)) continue;
    // PoE2 writes "Maximum", PoE1 "maximum"; PoE1 also has "+1% to all maximum Resistances" (chaos too)
    for (const [k, v] of Object.entries(it.stats)) {
      const n = Number(v) || 0;
      if (!n) continue;
      let m = k.match(/^#% to Maximum (Fire|Cold|Lightning|Chaos) Resistance$/i);
      if (m) { out[m[1].toLowerCase()] += n; continue; }
      if (/^#% to all Maximum Elemental Resistances$/i.test(k)) { for (const el of ['fire', 'cold', 'lightning']) out[el] += n; continue; }
      if (/^#% to all Maximum Resistances$/i.test(k)) for (const el of ['fire', 'cold', 'lightning', 'chaos']) out[el] += n;
    }
  }
  return out;
}

// The same item copied again with more detail (e.g. a Mageblood now read with its Legacies)
// isn't a change to your character: shift the remembered gear so the totals don't move.
function rebase(rec, oldItem, newItem) {
  if (!rec || !rec.gear || !oldItem || !newItem) return rec;
  if (oldItem.name !== newItem.name || oldItem.baseType !== newItem.baseType) return rec;
  const a = itemRes(oldItem); const b = itemRes(newItem);
  const gear = { ...rec.gear };
  for (const [el] of ELS) gear[el] = (gear[el] || 0) + (b[el] - a[el]);
  return { ...rec, gear };
}

const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

// Make a stored record from entered totals and the gear worn when they were taken.
function snapshot(totals, equipped, source, prev) {
  const rec = { cap: num(totals.cap) || (prev && prev.cap) || 75, source: source || 'manual', at: Date.now(), gear: gearRes(equipped) };
  for (const [el] of ELS) { const v = num(totals[el]); if (v != null) rec[el] = v; }
  const b = num(totals.buffer);
  rec.buffer = b != null ? b : (prev && prev.bufferSet ? prev.buffer : DEFAULT_BUFFER[rec.source]);
  if (b != null || (prev && prev.bufferSet)) rec.bufferSet = true;
  return rec;
}

// Totals with the gear you're wearing now. Old records without `gear` are taken as matching it.
function live(rec, equipped) {
  if (!rec) return null;
  const now = gearRes(equipped);
  const then = rec.gear || now;
  const out = { cap: Number(rec.cap) > 0 ? Number(rec.cap) : 75, buffer: num(rec.buffer) != null ? num(rec.buffer) : DEFAULT_BUFFER[rec.source || 'pob'], source: rec.source || 'pob', at: rec.at || null };
  const mx = gearMax(equipped);
  out.caps = {};
  for (const [el] of ELS) out.caps[el] = out.cap + mx[el];
  let any = false;
  for (const [el] of ELS) {
    const v = num(rec[el]);
    if (v == null) continue;
    out[el] = Math.round(v - then[el] + now[el]);
    any = true;
  }
  return any ? out : null;
}

module.exports = { ELS, DEFAULT_BUFFER, itemRes, gearRes, gearMax, rebase, snapshot, live };
