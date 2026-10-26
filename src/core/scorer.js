'use strict';

// Scores items with your stat weights and compares a new item with what you
// have equipped in the same slot.

const { SLOT_GROUPS, WEAKEST_OF } = require('./slots');

function score(item, weights) {
  if (!item) return 0;
  let total = 0;
  for (const [key, value] of Object.entries(item.stats)) {
    total += (weights[key] || 0) * value;
  }
  return total;
}

function mergeStats(...items) {
  const out = {};
  for (const it of items) {
    if (!it) continue;
    for (const [k, v] of Object.entries(it.stats)) out[k] = (out[k] || 0) + v;
  }
  return out;
}

function diffStats(newStats, oldStats, weights, ignore) {
  const keys = new Set([...Object.keys(newStats), ...Object.keys(oldStats)]);
  const rows = [];
  for (const key of keys) {
    if (ignore && ignore(key)) continue;
    const n = newStats[key] || 0;
    const o = oldStats[key] || 0;
    const diff = Math.round((n - o) * 100) / 100;
    if (diff === 0) continue;
    const weight = weights[key] || 0;
    rows.push({ key, newValue: n, oldValue: o, diff, weight, impact: diff * weight });
  }
  // biggest weighted impact first, then unweighted stats by size
  rows.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact) || Math.abs(b.diff) - Math.abs(a.diff));
  return rows;
}

function compareOne(item, baselineItems, weights, targetSlot, ignore) {
  const oldStats = mergeStats(...baselineItems);
  const newScore = score(item, weights);
  const oldScore = score({ stats: oldStats }, weights);
  const delta = newScore - oldScore;
  const pct = oldScore !== 0 ? (delta / Math.abs(oldScore)) * 100 : null;
  return {
    targetSlot,
    replacing: baselineItems.filter(Boolean).map((b) => b.name),
    newScore, oldScore, delta, pct,
    rows: diffStats(item.stats, oldStats, weights, ignore),
  };
}

// equipped: { "Helmet": item, "Ring 1": item, ... }
// opts.ignore(key) -> true for stats you've chosen to ignore: they don't
// count towards the score and aren't listed.
function compare(item, equipped, weightsIn, opts) {
  const ignore = (opts && opts.ignore) || null;
  const weights = { ...weightsIn };
  if (ignore) for (const k of Object.keys(weights)) if (ignore(k)) delete weights[k];
  const notes = [];
  if (!item || !item.slot) {
    return { ok: false, reason: `${(item && item.itemClass) || 'This item'} isn't gear, so there's nothing to compare.` };
  }
  if (item.unidentified) notes.push('Item is unidentified – mods are hidden, so the score only covers its base.');
  if (item.corrupted) notes.push('Corrupted – it cannot be modified further.');

  let result;
  if (WEAKEST_OF.includes(item.slot)) {
    // rings / charms / jewels: an empty slot first, otherwise your weakest one
    const group = SLOT_GROUPS[item.slot];
    const empty = group.find((s) => !equipped[s]);
    const some = group.some((s) => equipped[s]);
    if (item.slot === 'Jewel' && some) {
      // jewels: the app keeps room for 40, so an "empty" one doesn't mean your tree has a free
      // socket: compared with your weakest jewel (Path of Building knows your real sockets)
      result = group.filter((s) => equipped[s]).map((s) => compareOne(item, [equipped[s]], weights, s, ignore)).sort((a, b) => b.delta - a.delta)[0];
      notes.push('Compared with your weakest jewel. If your tree has a free jewel socket, it would be an addition instead.');
    } else if (empty && some) result = compareOne(item, [null], weights, empty, ignore);
    else if (empty) result = compareOne(item, [null], weights, group[0], ignore);
    else result = group.map((s) => compareOne(item, [equipped[s]], weights, s, ignore)).sort((a, b) => b.delta - a.delta)[0];
  } else if (item.slot === 'Weapon' && item.twoHanded) {
    result = compareOne(item, [equipped['Weapon'], equipped['Offhand']], weights, 'Weapon', ignore);
    if (equipped['Offhand']) notes.push('Two-handed: compared against your weapon + offhand together.');
  } else {
    result = compareOne(item, [equipped[item.slot]], weights, item.slot, ignore);
    if (item.slot === 'Offhand' && equipped['Weapon'] && equipped['Weapon'].twoHanded
        && !/quiver/i.test(item.itemClass || '')) {
      notes.push('Your equipped weapon is two-handed, so you can\'t use this with it.');
    }
  }

  const hasBaseline = result.replacing.length > 0;
  // Is the copied item the one already saved in that slot?
  const same = (a, b) => a && b && a.name === b.name && a.itemClass === b.itemClass
    && JSON.stringify((a.lines || []).map((l) => l.text)) === JSON.stringify((b.lines || []).map((l) => l.text));
  const slotNames = SLOT_GROUPS[item.slot] || [result.targetSlot];
  const isEquipped = slotNames.some((s) => same(item, equipped[s]));
  if (!hasBaseline) notes.push(`Nothing saved for ${result.targetSlot} yet – copy your equipped item and click "Set as equipped".`);
  const weightedRows = result.rows.filter((r) => r.weight !== 0);
  if (weightedRows.length === 0 && result.rows.length) {
    notes.push('None of the changed stats have a weight yet. Set weights in Settings (or click a stat in this popup).');
  }

  let verdict;
  if (!hasBaseline) verdict = 'new';
  else if (Math.abs(result.delta) < 1e-9) verdict = 'same';
  else verdict = result.delta > 0 ? 'upgrade' : 'downgrade';

  if (isEquipped) verdict = 'equipped';
  return { ok: true, item, verdict, notes, isEquipped, ...result };
}

module.exports = { score, compare, diffStats, mergeStats };
