'use strict';

// Item prices for stash valuation, from poe.ninja's PoE2 economy API:
//  - exchange overview (currency, essences, runes, omens, …): priced from the in-game Currency Exchange
//  - stash item overview (uniques): priced from trade listings
// Everything is converted to Divine Orbs. poe.ninja refreshes about hourly, so we cache for an hour.

const NINJA = 'https://poe.ninja/poe2/api/economy';
const EXCHANGE_TYPES = ['Currency', 'Fragments', 'Abyss', 'UncutGems', 'LineageSupportGems', 'Essences', 'SoulCores', 'Idols', 'Runes', 'Ritual', 'Expedition', 'Delirium', 'Breach', 'Verisium'];
const UNIQUE_TYPES = ['UniqueWeapons', 'UniqueArmours', 'UniqueAccessories', 'UniqueFlasks', 'UniqueCharms', 'UniqueJewels', 'UniqueSanctumRelics', 'UniqueTablets', 'PrecursorTablets'];

const norm = (s) => String(s || '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();

// How many divines one unit of the primary currency is worth, from the response's core block.
function divPerPrimary(core) {
  if (!core) return 1;
  if (!core.primary || core.primary === 'divine') return 1;
  const r = core.rates && Number(core.rates.divine);
  return r > 0 ? r : null; // rates: amount of <id> for 1 primary
}

// Exchange overview -> [{ name, div, volume, category }]
function parseExchange(data, type) {
  if (!data || !Array.isArray(data.lines)) return [];
  const k = divPerPrimary(data.core);
  if (!k) return [];
  const names = {};
  for (const it of [...(data.items || []), ...((data.core && data.core.items) || [])]) if (it && it.id) names[it.id] = it.name;
  const out = [];
  for (const l of data.lines) {
    const v = Number(l.primaryValue);
    const name = names[l.id] || l.name;
    if (!name || !(v > 0)) continue;
    out.push({ name, div: v * k, volume: Number(l.volumePrimaryValue) || null, category: type, source: 'exchange' });
  }
  // the primary currency itself has no line
  if (data.core && data.core.primary && names[data.core.primary] && !out.some((o) => norm(o.name) === norm(names[data.core.primary]))) {
    out.push({ name: names[data.core.primary], div: k, volume: null, category: type, source: 'exchange' });
  }
  return out;
}

// Stash item overview (uniques) -> [{ name, base, div, listings, corrupted }]
function parseUniques(data, type) {
  if (!data || !Array.isArray(data.lines)) return [];
  const k = divPerPrimary(data.core) || 1;
  return data.lines
    .filter((l) => l && l.name && Number(l.primaryValue) > 0)
    .map((l) => ({ name: l.name, base: l.baseType || null, div: Number(l.primaryValue) * k, listings: Number(l.listingCount) || 0, corrupted: !!l.corrupted, category: type, source: 'uniques' }));
}

// Merge into a lookup by lower-case name. For uniques keep the uncorrupted, most-listed entry.
function buildIndex(entries) {
  const byName = {};
  for (const e of entries) {
    const k = norm(e.name);
    const cur = byName[k];
    if (!cur) { byName[k] = e; continue; }
    if (e.source === 'uniques' && cur.source === 'uniques') {
      const better = (cur.corrupted && !e.corrupted) || (cur.corrupted === e.corrupted && (e.listings || 0) > (cur.listings || 0));
      if (better) byName[k] = e;
    }
  }
  return byName;
}

// A price we trust less: uniques with very few listings.
function confidence(p) {
  if (!p) return 'none';
  if (p.source === 'uniques') return p.listings >= 10 ? 'good' : p.listings >= 3 ? 'ok' : 'low';
  return p.volume != null && p.volume < 0.5 ? 'ok' : 'good';
}

// Fetch everything for a league. getJson(url) -> data. Failures of single types are skipped.
async function fetchAll(league, getJson, log) {
  const l = encodeURIComponent(league);
  const entries = []; const failed = [];
  for (const t of EXCHANGE_TYPES) {
    try { entries.push(...parseExchange(await getJson(`${NINJA}/exchange/current/overview?league=${l}&type=${t}`), t)); } catch (err) { failed.push(t); if (log) log(`prices ${t}: ${err.message || err}`); }
  }
  for (const t of UNIQUE_TYPES) {
    try { entries.push(...parseUniques(await getJson(`${NINJA}/stash/current/item/overview?league=${l}&type=${t}`), t)); } catch (err) { failed.push(t); if (log) log(`prices ${t}: ${err.message || err}`); }
  }
  return { league, fetched: Date.now(), byName: buildIndex(entries), count: entries.length, failed };
}

function lookup(index, name) {
  if (!index || !index.byName || !name) return null;
  return index.byName[norm(name)] || null;
}

module.exports = { EXCHANGE_TYPES, UNIQUE_TYPES, parseExchange, parseUniques, buildIndex, fetchAll, lookup, confidence, norm, divPerPrimary };
