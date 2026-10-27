'use strict';

// Your budget as a trade-site price filter, and how it reads.

const games = require('../games');
const { CURRENCIES } = require('./similar');

function num(v) { const n = Number(v); return v !== '' && v != null && Number.isFinite(n) && n > 0 ? n : null; }

// game: 'poe2' (prices counted in exalts) or 'poe1' (in chaos)
function priceFilter(budget, game) {
  const baseCur = games.gameOf(game).base;
  if (!budget) return null;
  let min = num(budget.min);
  let max = num(budget.max);
  if (min == null && max == null) return null;
  if (min != null && max != null && min > max) [min, max] = [max, min];
  const currency = CURRENCIES[budget.currency] ? budget.currency : 'divine';
  const rate = Number(budget.divineRate);
  const out = {};
  // PoE1: no currency named means "Chaos Orb equivalent", which the PoE1 site works out close to the
  // market, so a divine budget also finds the items priced in chaos (and the other way round)
  if (games.gameOf(game).id === 'poe1' && (currency === 'chaos' || (currency === 'divine' && Number.isFinite(rate) && rate > 0))) {
    const c = (v) => (v == null ? null : currency === 'divine' ? Math.max(1, Math.round(v * rate)) : v);
    if (min != null) out.min = c(min);
    if (max != null) out.max = c(max);
    if (out.min != null && out.max != null && out.min > out.max) out.min = out.max;
    return out;
  }
  // Don't use the site's "Exalted Orb equivalent": it converts divines with its own rate, far
  // from the market's (a 10 div minimum came out as ~27 div). Ask for the currency itself:
  // divine-priced listings in divines; small budgets (most such items are priced in exalts)
  // in exalts at the market rate.
  if (currency === 'divine' && max != null && max <= 2 && Number.isFinite(rate) && rate > 0) {
    // round both ends the same way so min <= max, and a tiny max is still at least 1 ex
    out.max = Math.max(1, Math.round(max * rate));
    if (min != null) out.min = Math.min(out.max, Math.max(1, Math.round(min * rate)));
    out.option = baseCur;
    return out;
  }
  if (min != null) out.min = min;
  if (max != null) out.max = max;
  out.option = currency;
  return out;
}

function applyBudget(body, budget, game) {
  if (!body || !body.query) return body;
  // leveling mode: only items you can wear at your level (budget.maxLevel)
  const lvl = budget && Number(budget.maxLevel);
  if (lvl > 0) {
    body.query.filters = body.query.filters || {};
    const rf = body.query.filters.req_filters || { filters: {} };
    rf.filters = { ...(rf.filters || {}), lvl: { ...((rf.filters || {}).lvl || {}), max: Math.round(lvl) } };
    body.query.filters.req_filters = rf;
  }
  // skip corrupted items (unless the search itself asks about corruption, as a price check does)
  if (budget && budget.noCorrupted) {
    body.query.filters = body.query.filters || {};
    const mf = body.query.filters.misc_filters || { filters: {} };
    if (!((mf.filters || {}).corrupted)) { mf.filters = { ...(mf.filters || {}), corrupted: { option: 'false' } }; body.query.filters.misc_filters = mf; }
  }
  const price = priceFilter(budget, game);
  if (!price) return body;
  body.query.filters = body.query.filters || {};
  body.query.filters.trade_filters = { filters: { price } };
  return body;
}

function budgetLabel(budget, game) {
  const lvl = (budget && Number(budget.maxLevel) > 0 ? ` · lvl ≤ ${Math.round(budget.maxLevel)}` : '') + (budget && budget.noCorrupted ? ' · not corrupted' : '');
  const r = priceLabel(budget, game);
  return r ? r + lvl : lvl ? lvl.slice(3) : null;
}
function priceLabel(budget, game) {
  const price = priceFilter(budget, game);
  if (!price) return null;
  const name = { divine: 'div', exalted: 'ex', chaos: 'chaos' }[budget.currency] || 'div';
  let min = num(budget.min); let max = num(budget.max);
  if (min != null && max != null && min > max) [min, max] = [max, min];
  const range = min != null && max != null ? `${min}–${max} ${name}` : max != null ? `≤ ${max} ${name}` : `≥ ${min} ${name}`;
  if (!price.option) return range; // PoE1: any currency, counted in chaos
  // the trade site takes one currency per search (its own "equivalent" uses a rate far from the
  // market's), so the label says which listings are in it: a 2 div budget searches exalt-priced
  // listings, a 10 div one divine-priced listings
  const short = { exalted: 'ex', divine: 'div', chaos: 'chaos' }[price.option] || price.option;
  return `${range} (${short} listings only)`;
}

module.exports = { priceFilter, applyBudget, budgetLabel };
