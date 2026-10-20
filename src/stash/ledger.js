'use strict';

// The wealth ledger: what's in each scanned tab, your listed items, items you added by hand,
// and how the total changed over time. Pure functions over a plain state object, so it's easy
// to test and to save as JSON.

const prices = require('./prices');

const TAB_LABELS = {
  currency: 'Currency', essence: 'Essence', fragments: 'Fragments', ritual: 'Ritual (Omens)', delirium: 'Delirium',
  breach: 'Breach', expedition: 'Expedition', abyss: 'Abyss', socketables_runes: 'Runes', socketables_soulcores: 'Soul Cores',
  socketables_idols: 'Idols', socketables_augments: 'Augments', socketables_kalguuran: 'Kalguuran runes',
};
const tabLabel = (id) => TAB_LABELS[id] || id;

function emptyState() {
  // adj: running sum of changes that aren't income (a tab scanned for the first time, items added
  // or removed by hand, corrections). Profit = change in (total - adj).
  return { tabs: {}, listings: null, items: [], history: [], feed: [], session: null, hidden: {}, adj: 0 };
}

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

// Value of one line. Returns { unit, value, conf } (unit/value null if no price).
function priceLine(index, name, count) {
  const p = prices.lookup(index, name);
  if (!p) return { unit: null, value: null, conf: 'none' };
  return { unit: p.div, value: p.div * count, conf: prices.confidence(p) };
}

function tabValue(tab, index) {
  const lines = []; let value = 0; const unpriced = [];
  for (const [name, count] of Object.entries(tab.counts || {})) {
    if (!(count > 0)) continue;
    const pl = priceLine(index, name, count);
    if (pl.value == null) unpriced.push({ name, count }); else value += pl.value;
    lines.push({ name, count, ...pl });
  }
  lines.sort((a, b) => (b.value || 0) - (a.value || 0));
  return { value, lines, unpriced };
}

// Names counted in scanned tabs (so a listed stack from the same tab isn't counted twice).
function scannedNames(state) {
  const s = new Set();
  for (const t of Object.values(state.tabs || {})) for (const [n, c] of Object.entries(t.counts || {})) if (c > 0) s.add(prices.norm(n));
  return s;
}

function listingsValue(state, index) {
  const L = state.listings;
  if (!L || !Array.isArray(L.items)) return { value: 0, asking: 0, count: 0, skipped: 0, lines: [] };
  const seen = scannedNames(state);
  let value = 0; let asking = 0; let skipped = 0; const lines = [];
  for (const it of L.items) {
    const qty = it.stackSize || 1;
    if (it.isStack && seen.has(prices.norm(it.name))) { skipped++; continue; }
    const p = prices.lookup(index, it.name);
    // stackables and uniques: market price; anything else: what you're asking for it
    const market = p && (it.isStack || p.source === 'uniques') ? p.div * qty : null;
    const v = market != null ? market : (it.priceDiv || 0);
    value += v; asking += it.priceDiv || 0;
    lines.push({ ...it, value: v, basis: market != null ? 'market' : it.priceDiv ? 'asking' : 'none' });
  }
  lines.sort((a, b) => b.value - a.value);
  return { value, asking, count: lines.length, skipped, lines };
}

function itemsValue(state, index) {
  let value = 0; const lines = [];
  for (const it of state.items || []) {
    // uniques and stackables follow the market; others keep the price they were added with
    const p = it.priceFrom === 'ninja' ? prices.lookup(index, it.name) : null;
    const unit = p ? p.div : Number(it.div) || 0;
    const v = unit * (Number(it.qty) || 1);
    value += v;
    lines.push({ ...it, unit, value: v });
  }
  lines.sort((a, b) => b.value - a.value);
  return { value, lines };
}

// Full valuation.
function valuate(state, index, now = Date.now()) {
  const tabs = Object.entries(state.tabs || {}).map(([id, t]) => {
    const v = tabValue(t, index);
    return { id, label: tabLabel(id), scannedAt: t.scannedAt, ageH: t.scannedAt ? (now - t.scannedAt) / 3600000 : null, unreadable: t.unreadable || [], hidden: !!(state.hidden && state.hidden[id]), ...v };
  }).sort((a, b) => b.value - a.value);
  const listings = listingsValue(state, index);
  const items = itemsValue(state, index);
  const tabsTotal = tabs.filter((t) => !t.hidden).reduce((a, t) => a + t.value, 0);
  const total = tabsTotal + (state.hidden && state.hidden.__listings ? 0 : listings.value) + items.value;
  const unpriced = tabs.reduce((a, t) => a + t.unpriced.length, 0);
  return { total, tabsTotal, tabs, listings, items, unpriced, pricesAt: index && index.fetched, league: index && index.league };
}

// A new reading of a tab. Unreadable cells keep their previous count instead of dropping to 0.
// Returns the changes [{ name, from, to, delta, div }].
function applyScan(state, tabId, counts, unreadable, index, now = Date.now()) {
  const prev = (state.tabs[tabId] && state.tabs[tabId].counts) || null;
  const next = { ...counts };
  for (const name of unreadable || []) if (prev && prev[name] != null && next[name] == null) next[name] = prev[name];
  const changes = [];
  if (prev) {
    const names = new Set([...Object.keys(prev), ...Object.keys(next)]);
    for (const n of names) {
      const a = prev[n] || 0; const b = next[n] || 0;
      if (a === b) continue;
      const p = prices.lookup(index, n);
      changes.push({ name: n, from: a, to: b, delta: b - a, div: p ? round(p.div * (b - a), 3) : null });
    }
  }
  state.tabs[tabId] = { counts: next, scannedAt: now, unreadable: unreadable || [], first: !prev };
  if (changes.length) {
    for (const c of changes) state.feed.unshift({ t: now, tab: tabId, ...c });
    state.feed = state.feed.slice(0, 300);
  }
  return changes;
}

// Book a change that isn't income (so session profit and 24 h change ignore it).
function adjust(state, amount) {
  if (Number.isFinite(amount) && amount) state.adj = (state.adj || 0) + amount;
}

// Keep a time series of the total. A point is added when the total moves, or every 15 minutes.
// Each point: [time, total, adj].
function recordHistory(state, total, now = Date.now()) {
  const h = state.history || (state.history = []);
  const last = h[h.length - 1];
  const t = round(total, 3); const a = round(state.adj || 0, 3);
  if (!last || Math.abs(last[1] - t) > 1e-6 || Math.abs((last[2] || 0) - a) > 1e-6 || now - last[0] > 15 * 60000) h.push([now, t, a]);
  if (h.length > 5000) {
    // thin out old points: keep every other one from the oldest half
    const half = Math.floor(h.length / 2);
    state.history = h.slice(0, half).filter((_, i) => i % 2 === 0).concat(h.slice(half));
  }
  if (!state.session) state.session = { start: now, startTotal: t, startAdj: a };
}

// Session: since the app started (or you pressed Reset). Profit per hour needs at least 10 minutes.
function sessionStats(state, total, now = Date.now()) {
  const s = state.session;
  if (!s) return null;
  const gained = (total - (state.adj || 0)) - (s.startTotal - (s.startAdj || 0));
  const hours = (now - s.start) / 3600000;
  return { start: s.start, startTotal: s.startTotal, gained, hours, perHour: hours >= 1 / 6 ? gained / hours : null };
}

// Change over a window from the history (e.g. last 24 hours), not counting adjustments.
function changeSince(state, total, ms, now = Date.now()) {
  const h = state.history || [];
  const cutoff = now - ms;
  let base = null;
  for (const p of h) { if (p[0] <= cutoff) base = p; else { if (base == null) base = p; break; } }
  if (!base) return null;
  return (total - (state.adj || 0)) - (base[1] - (base[2] || 0));
}

module.exports = { emptyState, adjust, valuate, applyScan, recordHistory, sessionStats, changeSince, tabLabel, TAB_LABELS, tabValue, listingsValue };
