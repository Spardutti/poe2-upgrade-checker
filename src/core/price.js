'use strict';

// "What's it worth?": a fair price from trade listings, cheapest first.
// The trade site's cheapest listings are often not real prices: price-fixing baits at 1 ex,
// one seller listing many copies, listings nobody has touched in weeks. So:
//   1. one listing per seller (their cheapest)
//   2. leave out listings older than STALE_DAYS when at least 3 fresh ones remain
//   3. drop baits: while the cheapest is under half the 4th cheapest (or far under the
//      middle of the market), drop it, at most a third of the listings
//   4. cheapest = what's left at the bottom; typical = the median of the cheapest 8
//   5. range = 2nd to 6th cheapest

const DAY = 24 * 3600 * 1000;
const STALE_DAYS = 14;

const medianOf = (a) => {
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

// listings: [{ priceEx, price, account, indexed, id }]
function priceStats(listings, opts = {}) {
  const now = opts.now || Date.now();
  const all = (listings || []).filter(Boolean);
  const unconvertible = all.filter((x) => x.price && x.priceEx == null).length; // priced in a currency we have no rate for
  const noPrice = all.filter((x) => !x.price).length;
  const bySeller = new Map();
  for (const x of all) {
    if (!(x.priceEx > 0)) continue;
    const k = x.account || x.id || bySeller.size;
    const cur = bySeller.get(k);
    if (!cur || x.priceEx < cur.priceEx) bySeller.set(k, x);
  }
  let list = [...bySeller.values()];
  const age = (x) => { const t = Date.parse(x.indexed || ''); return Number.isFinite(t) ? now - t : 0; };
  const fresh = list.filter((x) => age(x) <= STALE_DAYS * DAY);
  let stale = 0; let staleKept = 0;
  if (fresh.length >= 3 && fresh.length < list.length) { stale = list.length - fresh.length; list = fresh; }
  else staleKept = list.length - fresh.length; // too few fresh ones to leave the old ones out
  const p = list.map((x) => x.priceEx).sort((a, b) => a - b);
  if (!p.length) return unconvertible ? { count: 0, unconvertible, noPrice, total: all.length, unreliable: 'rate' } : null;
  const mid = medianOf(p);
  const maxDrop = Math.floor(p.length / 3);
  let baits = 0;
  while (p.length >= 4 && baits < maxDrop && (p[0] < 0.5 * p[Math.min(3, p.length - 1)] || p[0] < 0.35 * mid)) { p.shift(); baits++; }
  const n = p.length;
  const typicalEx = medianOf(p.slice(0, Math.min(8, n)));
  const lowEx = p[Math.min(1, n - 1)];
  const highEx = p[Math.min(5, n - 1)];
  const priced = all.filter((x) => x.price).length;
  return {
    cheapestEx: p[0], typicalEx, lowEx, highEx,
    count: n, sellers: bySeller.size, baits, stale, staleKept, unconvertible, noPrice, total: all.length,
    few: n < 3, // not enough listings to judge
    spread: n >= 2 && highEx / p[0] > 3, // prices vary a lot
    // too many listings in a currency without a rate: the number would be a guess
    unreliable: priced && unconvertible / priced > 0.3 ? 'rate' : null,
  };
}

module.exports = { priceStats, STALE_DAYS };
