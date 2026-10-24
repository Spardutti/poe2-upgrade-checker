'use strict';

// "If you equip it": what happens to your character's totals when an item replaces what's
// in its slot(s): resistances against the cap, Spirit, Energy Shield, Life, Mana,
// Intelligence, minion skill levels, movement speed, and your overall gear score.

const { MAIN_SLOTS } = require('./slots');

// [label, keys counted, slots where it counts (null = all)]
const TRACK = [
  ['Minion skill levels', ['# to Level of all Minion Skills'], null],
  ['Spirit', ['[Base] Spirit', '# to Spirit'], null],
  // flat ES on armour is already in the armour's Energy Shield; on jewellery it adds to yours
  ['Energy Shield', ['[Base] Energy Shield'], null, { '# to maximum Energy Shield': ['Amulet', 'Ring 1', 'Ring 2', 'Belt'] }],
  ['Life', ['# to maximum Life'], null],
  ['Mana', ['# to maximum Mana'], null],
  ['Intelligence', ['# to Intelligence'], null],
  ['Strength', ['# to Strength'], null],
  ['Dexterity', ['# to Dexterity'], null],
  ['Movement speed', ['#% increased Movement Speed'], null],
];
const RES = [['fire', 'Fire'], ['cold', 'Cold'], ['lightning', 'Lightning'], ['chaos', 'Chaos']];

function statOf(item, key) { return (item && item.stats && Number(item.stats[key])) || 0; }

function totalFor(gear, keys, extra) {
  let t = 0;
  for (const [slot, it] of Object.entries(gear)) {
    if (!it || !MAIN_SLOTS.includes(slot)) continue;
    for (const k of keys) t += statOf(it, k);
    if (extra) for (const [k, slots] of Object.entries(extra)) if (slots.includes(slot)) t += statOf(it, k);
  }
  return t;
}

// equipped: { slot: item }, item: the new one, slots: which slots it replaces (first one gets it)
// opts: { resists: { fire, cold, lightning, chaos, cap }, gearScore(item, slot) -> score|null }
function changeIfEquipped(equipped, item, slots, opts = {}) {
  if (!item || !slots || !slots.length) return null;
  const after = { ...equipped };
  for (const s of slots) delete after[s];
  after[slots[0]] = item;

  const lines = [];
  for (const [label, keys, , extra] of TRACK) {
    const a = totalFor(equipped, keys, extra); const b = totalFor(after, keys, extra);
    const d = Math.round((b - a) * 10) / 10;
    if (d) lines.push({ label, from: Math.round(a * 10) / 10, to: Math.round(b * 10) / 10, delta: d });
  }

  const res = [];
  const R = opts.resists || null;
  const cap = (R && Number(R.cap)) || 75;
  const buffer = (R && Number(R.buffer)) || 0;
  for (const [el, name] of RES) {
    const capAt = (R && R.caps && Number(R.caps[el])) || cap;
    const safeAt = capAt + buffer;
    const key = `#% to ${name} Resistance`;
    const removed = slots.reduce((t, s) => t + statOf(equipped[s], key), 0);
    const added = statOf(item, key);
    const d = added - removed;
    if (!d) continue;
    const known = R && Number.isFinite(Number(R[el]));
    if (known) {
      const from = Number(R[el]); const to = from + d;
      res.push({ label: `${name} res`, el, from, to, delta: d, cap: capAt, safe: safeAt, under: to < capAt, wasUnder: from < capAt, thin: to >= capAt && to < safeAt, wasThin: from >= capAt && from < safeAt, fromShown: Math.min(from, capAt), toShown: Math.min(to, capAt) });
    } else {
      res.push({ label: `${name} res`, el, delta: d, from: null, to: null, cap: capAt });
    }
  }

  let overall = null;
  if (opts.gearScore) {
    const avg = (gear) => {
      const sc = MAIN_SLOTS.map((s) => (gear[s] ? opts.gearScore(gear[s], s) : null)).filter((v) => v != null);
      return sc.length ? Math.round(sc.reduce((x, y) => x + y, 0) / sc.length) : null;
    };
    const a = avg(equipped); const b = avg(after);
    if (a != null && b != null) overall = { from: a, to: b, delta: b - a };
  }
  const src = R && R.source === 'pob' ? 'Path of Building' : 'your entered';
  const warnings = [];
  for (const r of res) {
    if (r.from == null || r.delta >= 0) continue;
    if (r.under && !r.wasUnder) warnings.push(`${r.label} drops below the cap (${r.to}% of ${r.cap}%)`);
    else if (r.under) warnings.push(`${r.label} goes further under the cap (${r.from}% → ${r.to}%)`);
    else if (r.thin && r.from >= r.safe) warnings.push(`${r.label} would be only ${r.to - r.cap}% over the cap (${r.delta}%) – ${src} numbers can include flasks, charms and buffs that aren't always on, so check your character sheet first`);
  }
  return { lines, res, overall, warnings, slots };
}

module.exports = { changeIfEquipped, TRACK };
