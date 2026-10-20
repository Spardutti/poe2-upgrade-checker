'use strict';

// Works out how many Exalted Orbs one Divine Orb is worth from poe.ninja's
// PoE2 currency exchange overview. poe.ninja has two response shapes (the
// documented /exchange/current/overview and the older /currencyexchange/overview)
// so this accepts either.

const NINJA = 'https://poe.ninja/poe2/api/economy';

function ninjaUrls(league) {
  const l = encodeURIComponent(league);
  return [
    `${NINJA}/exchange/current/overview?league=${l}&type=Currency`,
    `${NINJA}/currencyexchange/overview?leagueName=${l}&overviewName=Currency`,
  ];
}

function findId(data, wantId, wantName) {
  const items = (data.core && data.core.items) || data.items || [];
  const byName = items.find((i) => String(i.name || '').toLowerCase() === wantName);
  if (byName && byName.id) return byName.id;
  return wantId;
}

// Returns exalts per divine, or null if it can't be worked out.
function divineInExalts(data) {
  if (!data || typeof data !== 'object') return null;
  const div = findId(data, 'divine', 'divine orb');
  const ex = findId(data, 'exalted', 'exalted orb');
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

// { currencyId: exalts each } for every currency in the overview.
function currencyRatesInExalts(data) {
  if (!data || typeof data !== 'object') return null;
  const lines = data.lines || [];
  const primary = data.core && data.core.primary;
  const exLine = lines.find((l) => l.id === 'exalted');
  const exVal = exLine && Number(exLine.primaryValue) > 0 ? Number(exLine.primaryValue) : (primary === 'exalted' || !primary ? 1 : null);
  if (!exVal) return null;
  const out = { exalted: 1 };
  for (const l of lines) {
    const v = Number(l.primaryValue);
    if (l.id && v > 0) out[l.id] = Math.round((v / exVal) * 10000) / 10000;
  }
  if (primary && !out[primary]) out[primary] = Math.round((1 / exVal) * 10000) / 10000;
  return out;
}

module.exports = { ninjaUrls, divineInExalts, currencyRatesInExalts };
