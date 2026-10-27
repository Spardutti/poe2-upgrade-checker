'use strict';

// Which listings of a price search are really like your item.
//
// The trade search asks for your item's priced stats (pricequery.js), but a listing that has them
// can have more: a ring with your resistances, strength and added damage plus 80 life and attack
// speed is a better ring, priced higher. Pricing yours from the cheapest few of those over-prices it
// (the cheap "like yours" listings sit among dearer better ones). So each listing is compared with
// your item on the same priced stats:
//   extra:   priced stats it has that yours hasn't (a mod, or a total like life that yours is too
//            small on to count), or a stat well above yours (half again or more)
//   missing: your priced stats it lacks or has well under yours (a looser search lets some through)
// and the price is worked out from the closest group that has enough sellers: like yours (nothing
// extra, nothing missing), then at most one thing different, then everything.

const pq = require('./pricequery');

const MUCH_MORE = 1.5; // "well above yours"
const MUCH_LESS = 0.75; // "well under yours"

function statMap(item, opts) {
  const { stats, equip } = pq.priceStats(item, opts);
  const m = new Map();
  for (const s of stats) m.set(s.id, { value: s.value, label: s.label });
  for (const e of equip) m.set(`equip.${e.f}`, { value: e.value, label: { ar: 'Armour', ev: 'Evasion', es: 'Energy Shield', spirit: 'Spirit', pdps: 'Physical DPS', edps: 'Elemental DPS' }[e.f] || e.f });
  return m;
}

// how one listing differs from your item: { extra: [labels], missing: [labels] }
function compare(ours, theirs) {
  const extra = []; const missing = [];
  for (const [id, t] of theirs) {
    const o = ours.get(id);
    if (!o) extra.push(`${t.label} ${round(t.value)}`);
    else if (o.value > 0 && t.value >= o.value * MUCH_MORE) extra.push(`${t.label} ${round(t.value)} (yours ${round(o.value)})`);
  }
  for (const [id, o] of ours) {
    const t = theirs.get(id);
    if (!t) missing.push(o.label);
    else if (t.value < o.value * MUCH_LESS) missing.push(`${o.label} ${round(t.value)} (yours ${round(o.value)})`);
  }
  return { extra, missing };
}
const round = (x) => (x >= 10 ? Math.round(x) : Math.round(x * 10) / 10);

// listings: summarise() output ({ item, priceEx, ... }). Each gets .diff = { extra, missing }.
// -> { listings (the group to price from), group: 'alike' | 'close' | 'all', alike, close, total }
function pick(item, listings, opts = {}, min = 3) {
  const all = (listings || []).filter(Boolean);
  if (!item || !all.length) return { listings: all, group: 'all', alike: 0, close: 0, total: all.length };
  const ours = statMap(item, opts);
  for (const x of all) {
    if (!x.item) { x.diff = null; continue; }
    try { x.diff = compare(ours, statMap(x.item, opts)); } catch (_) { x.diff = null; }
  }
  const sellers = (list) => new Set(list.filter((x) => x.priceEx > 0).map((x) => x.account || x.id)).size;
  const alike = all.filter((x) => x.diff && !x.diff.extra.length && !x.diff.missing.length);
  const close = all.filter((x) => x.diff && x.diff.extra.length + x.diff.missing.length <= 1);
  const out = { alike: alike.length, close: close.length, total: all.length };
  if (sellers(alike) >= min) return { ...out, listings: alike, group: 'alike' };
  if (sellers(close) >= min) return { ...out, listings: close, group: 'close' };
  return { ...out, listings: all, group: 'all' };
}

module.exports = { pick, compare, statMap, MUCH_MORE, MUCH_LESS };
