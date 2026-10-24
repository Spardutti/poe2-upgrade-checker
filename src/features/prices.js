'use strict';

// poe.ninja prices for things that aren't judged as gear (currency, gems, maps, divination cards,
// uniques), through the app's proxy on poe2upgrade.com; the price card in the popup.
// Moved out of main.js: it reaches the app's shared state and helpers through C (see main.js).
const fs = require('fs');
const path = require('path');
const { app, ipcMain, shell } = require('electron');

module.exports = function (C) {
  const ninjaCache = new Map(); // url key -> { at, data } (or a promise while it loads)
  const NINJA_TTL = 20 * 60000;
  // one poe.ninja answer, through the app's proxy first; cached for 20 minutes
  async function ninjaGet(urls) {
    const key = urls[urls.length - 1];
    const hit = ninjaCache.get(key);
    if (hit && hit.p) return hit.p;
    if (hit && Date.now() - hit.at < NINJA_TTL) return hit.data;
    const p = (async () => {
      let lastErr = null;
      for (const u of urls) {
        try { const d = await C.getJson(u); ninjaCache.set(key, { at: Date.now(), data: d }); return d; } catch (err) { lastErr = err; }
      }
      ninjaCache.delete(key);
      if (hit && hit.data) return hit.data; // keep using the older answer
      throw lastErr || new Error('poe.ninja unreachable');
    })();
    ninjaCache.set(key, { p, data: hit && hit.data });
    return p;
  }
  // which exchange lists to look in first, by item class (then all the others)
  const NINJA_FIRST = {
    poe2: [[/essence/i, 'Essences'], [/rune|talisman/i, 'Runes'], [/soul core/i, 'SoulCores'], [/omen/i, 'Ritual'], [/idol/i, 'Idols'], [/uncut|gem/i, 'UncutGems'], [/splinter|fragment|key|tablet/i, 'Fragments']],
    poe1: [[/divination/i, 'DivinationCard'], [/essence/i, 'Essence'], [/fossil/i, 'Fossil'], [/resonator/i, 'Resonator'], [/oil/i, 'Oil'], [/scarab/i, 'Scarab'], [/omen/i, 'Omen'], [/tattoo/i, 'Tattoo'], [/fragment|splinter|key|emblem/i, 'Fragment']],
  };
  async function ninjaPrice(item) {
    const game = C.tg();
    const want = C.ninjaLib.typesFor(item, game);
    if (!want.exchange && !want.items.length) return null;
    const league = await C.ninjaLeague();
    const found = { items: [], exchange: [] };
    // poe.ninja (and the app's cache) unreachable is said as such, not as "no price"
    let answered = 0; let lastErr = null;
    for (const t of want.items) {
      try { found.items.push(await ninjaGet(C.ninjaLib.itemUrls(league, t, game))); answered++; } catch (err) { lastErr = err; C.log(`poe.ninja ${t}: ${err.message}`); }
    }
    let r = C.ninjaLib.priceOf(item, found, game);
    if (r || !want.exchange) return r && { ...r, league };
    // every exchange list in one request, gathered and cached by the app's proxy (one request instead
    // of up to 18; poe.ninja itself is asked once per list per refresh for everyone)
    try {
      const all = await ninjaGet([C.ninjaLib.allExchangeUrl(league, game)]);
      answered++;
      if (all && all.types && typeof all.types === 'object') {
        found.exchange = Object.values(all.types).filter(Boolean);
        r = C.ninjaLib.priceOf(item, found, game);
        if (r) return { ...r, league };
        if (Object.keys(all.types).length >= C.ninjaLib.EXCHANGE_TYPES[C.G(game).id].length) return null; // every list looked at
      }
    } catch (err) { lastErr = err; C.log('poe.ninja (all lists): ' + err.message); }
    const cls = `${item.itemClass || ''} ${item.name || ''} ${item.baseType || ''}`;
    const first = (NINJA_FIRST[C.G(game).id] || []).filter(([re]) => re.test(cls)).map(([, t]) => t);
    const order = [...new Set([...first, ...C.ninjaLib.EXCHANGE_TYPES[C.G(game).id]])];
    for (const t of order) {
      try { found.exchange = [await ninjaGet(C.ninjaLib.exchangeUrls(league, t, game))]; answered++; } catch (err) { lastErr = err; C.log(`poe.ninja ${t}: ${err.message}`); if (!answered && order.indexOf(t) >= 2) break; continue; }
      r = C.ninjaLib.priceOf(item, found, game);
      if (r) return { ...r, league };
    }
    if (!answered && lastErr) throw new Error(/ENOTFOUND|ECONN|offline|timed? ?out|net::/i.test(lastErr.message) ? "can't reach it right now, check your internet connection" : lastErr.message);
    return null;
  }
  // the popup for something that isn't gear: what it's worth on poe.ninja
  function showPriceCard(item) {
    const r = { ok: true, kind: 'price', item, pricePending: true, links: C.ninjaLib.infoLinks(item, C.tg()) };
    C.showResult(r);
    const seq = C.popupSeq;
    ninjaPrice(item).then((p) => { r.ninja = p; if (!p) r.priceNote = "poe.ninja doesn't list a price for this."; })
      .catch((err) => { r.priceNote = `Couldn't get the price from poe.ninja (${err.message}).`; C.log('poe.ninja: ' + err.message); })
      .then(() => { r.pricePending = false; if (seq === C.popupSeq && C.popup && !C.popup.isDestroyed()) C.popup.webContents.send('popup:result', C.serialise(r)); });
  }
  return { ninjaPrice, showPriceCard, ninjaGet };
};
