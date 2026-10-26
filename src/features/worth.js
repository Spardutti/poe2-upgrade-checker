'use strict';

// "What's it worth?": prices from the trade site in exalts, divines and chaos.
const { ipcMain, shell } = require('electron');
const trade = require('../core/trade');
const listingLib = require('../core/listing');
const priceLib = require('../core/price');
const priceQuery = require('../core/pricequery');
const ninjaLib = require('../core/ninja');

module.exports = function (C) {
  // ---------- price check ("What's it worth?") ----------

  // Both units, so prices are easy to compare: "2 div (1,393 ex)" / "180 ex (0.26 div)"
  // PoE2 prices also in chaos orbs: exalts per chaos from poe.ninja (null in PoE1, where chaos is the base)
  function chaosRate() { const c = C.tg() === 'poe2' && C.store.settings.currencyRates && Number(C.store.settings.currencyRates.chaos); return c > 0 ? c : null; }
  const chaosText = (ex) => { const c = chaosRate(); if (!c || !(ex > 0)) return null; const v = ex / c; return `${v < 10 ? Math.round(v * 10) / 10 : Math.round(v).toLocaleString('en')} chaos`; };
  function fmtEx(ex) {
    if (ex == null) return '?';
    const div = C.store.settings.divineRate;
    const u = C.G().baseShort; // ex (PoE2) or chaos (PoE1)
    const exText = ex < 10 ? `${Math.round(ex * 10) / 10} ${u}` : `${Math.round(ex).toLocaleString('en')} ${u}`;
    const ch = chaosText(ex);
    if (!div) return ch ? `${exText} (${ch})` : exText;
    if (ex >= div * 0.95) return `${Math.round((ex / div) * 10) / 10} div (${[`${Math.round(ex).toLocaleString('en')} ${C.G().baseShort}`, ch].filter(Boolean).join(' · ')})`;
    if (ex / div < 0.05) return ch ? `${exText} (${ch})` : exText; // "0.01 div" says nothing
    return `${exText} (${[`${Math.round((ex / div) * 100) / 100} div`, ch].filter(Boolean).join(' · ')})`;
  }

  // the price verdict, with everything that makes it less certain said out loud
  function priceSummary(listings, league, level = 0) {
    const s = priceLib.priceStats(listings);
    if (!s) return null;
    const pl = (k, one, many) => `${k} ${k === 1 ? one : many}`;
    const notes = [];
    const rate = C.store.settings.divineRate;
    if (s.unconvertible) notes.push(`${pl(s.unconvertible, 'listing is', 'listings are')} priced in ${rate ? 'a currency' : 'divines or a currency'} without a known ${C.G().base} rate${rate ? '' : " (poe.ninja couldn't be reached)"}, so ${s.unconvertible === 1 ? "it's" : "they're"} left out`);
    if (rate && C.store.settings.divineRateAt && Date.now() - C.store.settings.divineRateAt > 6 * C.HOUR) notes.push(`the divine rate (${rate} ${C.G().baseShort}) is ${Math.round((Date.now() - C.store.settings.divineRateAt) / C.HOUR)} hours old`);
    if (rate && league && C.store.settings.divineRateLeague && C.store.settings.divineRateLeague !== league) notes.push(`the divine rate is from ${C.store.settings.divineRateLeague}, not ${league}`);
    if (s.baits) notes.push(`${pl(s.baits, 'listing', 'listings')} far under the rest left out (likely price-fixing bait)`);
    if (s.stale) notes.push(`${pl(s.stale, 'listing', 'listings')} older than ${priceLib.STALE_DAYS} days left out`);
    if (s.staleKept) notes.push(`${pl(s.staleKept, 'listing is', 'listings are')} over ${priceLib.STALE_DAYS} days old and may not be a real offer`);
    if (s.noPrice) notes.push(`${s.noPrice} unpriced`);
    if (s.spread && !s.few) notes.push('prices vary a lot');
    const out = {
      count: s.count, sellers: s.sellers, total: s.total, notes,
      cheapestEx: s.cheapestEx == null ? null : s.cheapestEx, typicalEx: null, few: !!s.few, unreliable: s.unreliable,
      cheapest: s.cheapestEx == null ? null : fmtEx(s.cheapestEx), typical: null, range: null,
    };
    if (s.unreliable) {
      out.verdict = `Can't price this reliably: ${s.unconvertible} of the listings are priced in currencies without a known rate.`;
    } else if (s.few) {
      out.verdict = s.count ? `Only ${s.count} listed – not enough to judge${s.count ? ` (from ${fmtEx(s.cheapestEx)})` : ''}.` : 'No priced listings.';
    } else {
      out.typicalEx = s.typicalEx; out.typical = fmtEx(s.typicalEx);
      out.range = s.lowEx !== s.highEx ? `${fmtEx(s.lowEx)} – ${fmtEx(s.highEx)}` : null;
      out.verdict = `Worth about ${out.typical}${out.range ? ` (most ${out.range})` : ''}.`;
      out.confidence = priceLib.confidence(s, level);
      // selling it: a little under the cheapest comparable listing (not when the price is a guess)
      if (out.confidence && out.confidence.grade !== 'guess') {
        const rate = C.store.settings.divineRate;
        out.sell = ninjaLib.sellNote({ total: s.cheapestEx, totalDiv: rate ? s.cheapestEx / rate : null, unit: C.G().baseShort, stack: 1 });
      }
    }
    return out;
  }

  // ---------- where to spend your divines ----------
  ipcMain.handle('trade:price', C.inGame(async (_e, target, picks) => {
    const item = C.resolveItem(target);
    if (!item) return { ok: false, error: 'No item to price.' };
    return tradePrice(item, picks, { window: true });
  }));
  // the trade site's price for an item. opts.window: show the listings in the results window;
  // without it (Alt+E's quick price) the listings are only read for the price
  async function tradePrice(item, picks, opts0 = {}) {
    let d;
    try { d = await C.loadTradeData(false); } catch (err) { return { ok: false, error: 'Could not load trade site data: ' + (err.message || err) }; }
    await C.refreshDivineRate(false);
    const league = C.pickLeague(d);
    const armourOrWeapon = ['Weapon', 'Offhand', 'Helmet', 'Body Armour', 'Gloves', 'Boots'].includes(item.slot);
    // Price check looks for close matches to THIS item, without your price range
    // or ignored stats (those are about what you want, not what it's worth).
    // always "available" listings (instant buyout + in person): offline sellers' prices aren't what it sells for
    const opts = { statIndex: d.index, filtersData: d.filters, preferLocal: armourOrWeapon, forPrice: true, game: C.tg() };
    let r = null; let q = null;
    // you chose the stats in the popup: exactly those, at your minimums (with the same rarity,
    // corruption, links and influences as the item), one search
    const chosen = Array.isArray(picks) ? picks.filter((p) => p && typeof p.key === 'string').slice(0, 20) : null;
    // rare and magic gear: the market search (pricequery.js); uniques and the rest: the like-for-like one
    // maps, waystones and tablets: their tier / kind and numbers (pricequery.js)
    const mapish = !chosen && priceQuery.usesMapPriceQuery(item);
    const market = !chosen && !mapish && priceQuery.usesPriceQuery(item);
    const levels = chosen ? 1 : mapish ? priceQuery.MAP_LEVELS.length : market ? priceQuery.LEVELS.length : 3;
    // the closest search with at least a few sellers wins: looser matches are different (usually cheaper) items
    const enough = market || mapish ? priceQuery.MIN : 3;
    for (let level = 0; level < levels; level++) {
      q = mapish ? priceQuery.buildMapPriceQuery(item, { ...opts, level }) : market ? priceQuery.buildPriceQuery(item, { ...opts, level }) : trade.buildSimilarQuery(item, { ...opts, level });
      if (chosen) {
        const c = trade.buildQuery(chosen.map((p) => ({ key: p.key, min: p.min, max: p.max, source: p.source, ...(typeof p.id === 'string' && /^[a-z]+\.[a-z0-9_]{1,80}$/.test(p.id) ? { id: p.id, idType: ['pseudo', 'explicit', 'implicit', 'enchant', 'rune', 'fractured', 'crafted'].includes(p.idType) ? p.idType : undefined } : {}) })), { itemClass: item.itemClass, statIndex: d.index, filtersData: d.filters, preferLocal: armourOrWeapon, status: 'available' });
        q.body.query.stats = c.body.query.stats;
        const eq = c.body.query.filters && c.body.query.filters.equipment_filters;
        if (eq) q.body.query.filters.equipment_filters = eq; else delete q.body.query.filters.equipment_filters;
        q.levelLabel = 'the stats you chose'; q.need = chosen.length - c.unmatched.length; q.total = chosen.length;
        if (c.unmatched.length) q.unmatched = c.unmatched;
      }
      q.body.sort = { price: 'asc' };
      r = await C.runSearch(league, q.body, chosen ? 'price chosen' : `price L${level}`);
      if (!r.ok || r.total == null || r.total >= enough) break;
      if (r.near) break;
      await new Promise((res) => setTimeout(res, 700));
    }
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'Search failed.' };
    // the search itself failed (only a pre-filled link came back): open that rather than saying "nothing listed"
    if (r.total == null) return { ok: true, mode: 'price', total: null, league, item: item.name, url: r.url, fallback: true, levelLabel: q.levelLabel }; // a button, never a browser by itself
    if (!r.total) return { ok: true, mode: 'price', total: 0, league, item: item.name, url: r.url, levelLabel: q.levelLabel };
    const ctx = { item, mode: 'price', title: `Price check: ${item.name}`, body: q.body, searchKey: C.searchKey(q.body),
      note: `Listings like this one (${q.levelLabel}, ${q.need} of ${q.total} stats), cheapest first.` };
    if (!C.sameGame()) return C.SWITCHED();
    if (!opts0.window) {
      // just the price: the first 40 listings read, nothing shown, nothing judged
      const rates = { ...(C.store.settings.currencyRates || {}), ...(C.store.settings.divineRate ? { divine: C.store.settings.divineRate } : {}) };
      const raw = r.ids && r.ids.length ? await C.fetchListings(league, r.searchId, r.ids.slice(0, 40), C.tg()) : [];
      const listings = raw.map((x) => listingLib.summarise(x, item.itemClass, rates, C.G().base));
      const summary = priceSummary(listings, league, q.level || 0);
      if (summary && summary.typicalEx != null && item.id) C.lastWorth.set(item.id, summary.typicalEx);
      return { ok: true, mode: 'price', total: r.total, league, item: item.name, url: r.url, summary, levelLabel: q.levelLabel, level: q.level };
    }
    const shown = r.ids && r.ids.length ? await C.showResults(r, ctx) : false;
    let summary = null;
    if (shown) {
      summary = priceSummary(C.resultsState.listings, league, q.level || 0);
      C.resultsState.ctx.priceSummary = summary;
      C.resultsState.ctx.priceLeague = league;
      C.resultsState.ctx.priceLevel = q.level || 0;
      if (summary && summary.typicalEx != null && item.id) C.lastWorth.set(item.id, summary.typicalEx);
      if (C.resultsWin && !C.resultsWin.isDestroyed()) C.resultsWin.webContents.send('results:data', C.resultsPayload());
    } else {
      await shell.openExternal(r.url);
    }
    return { ok: true, mode: 'price', total: r.total, league, item: item.name, url: r.url, inApp: shown, opened: true,
      summary, levelLabel: q.levelLabel, level: q.level, need: q.need, of: q.total };
  }

  return {
    chaosRate,
    priceSummary,
    tradePrice,
  };
};
