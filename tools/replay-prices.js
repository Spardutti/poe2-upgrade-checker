#!/usr/bin/env node
'use strict';
// Re-prices saved price checks (price-checks.jsonl, written next to the app's log) with the current
// code, without the trade site: each saved listing is parsed again, compared with the item
// (comparables.js) and priced (price.js). Shows what was said then and what would be said now.
//   node tools/replay-prices.js [path/to/price-checks.jsonl] [--item "Barren Compass"]
const fs = require('fs');
const path = require('path');
const { parseItem } = require('../src/core/parser');
const pq = require('../src/core/pricequery');
const comparables = require('../src/core/comparables');
const { priceStats } = require('../src/core/price');

const args = process.argv.slice(2);
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--item') || path.join(process.env.APPDATA || '', 'PoE2 Upgrade Checker', 'price-checks.jsonl');
const only = args.includes('--item') ? String(args[args.indexOf('--item') + 1] || '').toLowerCase() : '';
// the trade site's stat list, as the app keeps it next to the file (gear mods are matched with it)
const trade = require('../src/core/trade');
const indexes = {};
function statIndex(game) {
  if (indexes[game] !== undefined) return indexes[game];
  try { indexes[game] = trade.buildStatIndex(JSON.parse(fs.readFileSync(path.join(path.dirname(file), game === 'poe1' ? 'trade-cache-poe1.json' : 'trade-cache.json'), 'utf8')).stats); } catch (_) { indexes[game] = null; }
  return indexes[game];
}
const fmt = (x) => (x == null ? '-' : x >= 100 ? Math.round(x) : Math.round(x * 10) / 10);

for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
  let c; try { c = JSON.parse(line); } catch (_) { continue; }
  const item = c.item && parseItem(c.item);
  if (!item || (only && !String(item.name || '').toLowerCase().includes(only))) continue;
  const listings = (c.listings || []).map((x, i) => ({ id: 'l' + i, account: 'l' + i, price: x.price, priceEx: x.priceEx, indexed: x.indexed, item: x.text ? Object.assign(parseItem(x.text) || {}, { listingText: x.text }, x.affixes != null ? { affixCount: x.affixes } : {}) : null }));
  const map = pq.usesMapPriceQuery(item) && !pq.isTablet(item) && !/unique/i.test(item.rarity || '');
  const market = !map && pq.usesPriceQuery(item);
  let group = { group: 'all', listings };
  const preferLocal = ['Weapon', 'Offhand', 'Helmet', 'Body Armour', 'Gloves', 'Boots'].includes(item.slot);
  if (map || market) group = comparables.pick(item, listings, map ? { kind: 'map', game: c.game } : { game: c.game, preferLocal, statIndex: statIndex(c.game) }, pq.MIN);
  const s = priceStats(group.listings);
  const was = c.verdict || {};
  const now = group.group === 'weaker' ? `more than ${fmt(s && s.typicalEx)} (every listing weaker)` : s ? `${fmt(s.typicalEx)} (${fmt(s.lowEx)}–${fmt(s.highEx)})` : 'none';
  console.log(`${c.at} ${item.itemClass} "${item.name}": then ${fmt(was.typicalEx)}${was.group ? ` [${was.group}]` : ''} → now ${now} [${group.group}, ${group.listings.length} of ${listings.length} listings]`);
}
