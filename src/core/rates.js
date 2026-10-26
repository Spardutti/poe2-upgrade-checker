'use strict';

// Works out how many Exalted Orbs one Divine Orb is worth from poe.ninja's
// PoE2 currency exchange overview. poe.ninja has two response shapes (the
// documented /exchange/current/overview and the older /currencyexchange/overview)
// so this accepts either.

// PoE1 works the same way at poe.ninja/poe1 (and the old poe.ninja/api/data/currencyoverview),
// with prices counted in chaos instead of exalts ("base").
const ninjaBase = (game) => `https://poe.ninja/${game === 'poe1' ? 'poe1' : 'poe2'}/api/economy`;

function ninjaUrls(league, game) {
  const l = encodeURIComponent(league);
  const NINJA = ninjaBase(game);
  const urls = [
    // the app's caching proxy first (poe.ninja asks desktop apps not to call it from every PC)
    `https://poe2upgrade.com/ninja/${game === 'poe1' ? 'poe1' : 'poe2'}/exchange/current/overview?league=${l}&type=Currency`,
    `${NINJA}/exchange/current/overview?league=${l}&type=Currency`,
    `${NINJA}/currencyexchange/overview?leagueName=${l}&overviewName=Currency`,
  ];
  if (game === 'poe1') urls.push(`https://poe.ninja/api/data/currencyoverview?league=${l}&type=Currency`);
  return urls;
}

// the old PoE1 API: { lines: [{ currencyTypeName, chaosEquivalent }] } -> the new shape
function normalise(data) {
  if (data && Array.isArray(data.lines) && data.lines.length && data.lines[0].currencyTypeName && !data.lines[0].id) {
    // the trade site's own short ids ("alch", "fusing", "chrome") come with it as currencyDetails[].tradeId
    const trade = new Map((Array.isArray(data.currencyDetails) ? data.currencyDetails : []).filter((c) => c && c.name && c.tradeId).map((c) => [c.name, c.tradeId]));
    const id = (n) => trade.get(n) || String(n).toLowerCase().replace(/ orb$/, '').replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
    return {
      core: { primary: 'chaos', items: data.lines.map((l) => ({ id: id(l.currencyTypeName), name: l.currencyTypeName })) },
      lines: data.lines.map((l) => ({ id: id(l.currencyTypeName), primaryValue: Number(l.chaosEquivalent) })),
    };
  }
  return data;
}

function findId(data, wantId, wantName) {
  const items = (data.core && data.core.items) || data.items || [];
  const byName = items.find((i) => String(i.name || '').toLowerCase() === wantName);
  if (byName && byName.id) return byName.id;
  return wantId;
}

// Returns exalts per divine (PoE1: base 'chaos', chaos per divine), or null if it can't be worked out.
function divineInExalts(data, base = 'exalted') {
  data = normalise(data);
  if (!data || typeof data !== 'object') return null;
  const div = findId(data, 'divine', 'divine orb');
  const ex = findId(data, base, base + ' orb');
  const lines = data.lines || [];
  const line = (id) => lines.find((l) => l.id === id);
  const primary = data.core && data.core.primary;

  // primaryValue = value of 1 item in the primary currency
  const val = (id) => {
    const l = line(id);
    if (l && Number(l.primaryValue) > 0) return Number(l.primaryValue);
    if (primary === id) return 1;
    const rates = data.core && data.core.rates;
    // rates: how many of <id> you get for 1 primary -> value = 1 / rate
    if (rates && Number(rates[id]) > 0) return 1 / Number(rates[id]);
    return null;
  };
  const d = val(div);
  const e = val(ex);
  if (!d || !e) return null;
  const rate = d / e;
  // sanity check: a divine has always been worth well over 1 exalt
  if (!Number.isFinite(rate) || rate < 1 || rate > 100000) return null;
  return Math.round(rate * 10) / 10;
}

// { currencyId: exalts each } for every currency in the overview (PoE1: chaos each).
function currencyRatesInExalts(data, base = 'exalted') {
  data = normalise(data);
  if (!data || typeof data !== 'object') return null;
  const lines = data.lines || [];
  const primary = data.core && data.core.primary;
  // the base currency's value, found the same ways divineInExalts finds it (its line, being the
  // primary currency, or the primary's exchange rates)
  const baseId = findId(data, base, base + ' orb');
  const exLine = lines.find((l) => l.id === baseId);
  const rts = data.core && data.core.rates;
  const exVal = exLine && Number(exLine.primaryValue) > 0 ? Number(exLine.primaryValue)
    : primary === baseId || !primary ? 1 : rts && Number(rts[baseId]) > 0 ? 1 / Number(rts[baseId]) : null;
  if (!exVal || !lines.length) return null;
  const out = { [base]: 1 };
  for (const l of lines) {
    const v = Number(l.primaryValue);
    if (l.id && v > 0) out[l.id] = Math.round((v / exVal) * 10000) / 10000;
  }
  if (primary && !out[primary]) out[primary] = Math.round((1 / exVal) * 10000) / 10000;
  // chaos orbs under the trade site's id, whatever poe.ninja calls them (prices are also shown in chaos)
  const chaosId = findId(data, 'chaos', 'chaos orb');
  if (!out.chaos && out[chaosId]) out.chaos = out[chaosId];
  return out;
}

module.exports = { ninjaUrls, divineInExalts, currencyRatesInExalts };
