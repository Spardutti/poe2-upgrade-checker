'use strict';

// The trade site's addresses for each game, and turning a PoE2 search into a PoE1 one.

const games = require('../games');
const { BASE } = require('./stats');

// PoE2: /api/trade2/search/poe2/<league>; PoE1: /api/trade/search/<league>
const realmPart = (game) => { const r = games.gameOf(game).trade.realm; return r ? r + '/' : ''; };
function apiUrl(game, what) { return `${BASE}/api/${games.gameOf(game).trade.api}/${what}`; }
function pageUrl(game, league) { return `${BASE}/${games.gameOf(game).trade.page}/search/${realmPart(game)}${encodeURIComponent(league)}`; }
function searchUrl(league, game) {
  return `${BASE}/api/${games.gameOf(game).trade.api}/search/${realmPart(game)}${encodeURIComponent(league)}`;
}
function fetchUrl(ids, searchId, game) {
  const realm = games.gameOf(game).trade.realm;
  return `${BASE}/api/${games.gameOf(game).trade.api}/fetch/${ids.map(encodeURIComponent).join(',')}?query=${encodeURIComponent(searchId)}${realm ? '&realm=' + realm : ''}`;
}
function resultsUrl(league, id, game) {
  return `${pageUrl(game, league)}/${encodeURIComponent(id)}`;
}
// Fallback if the POST fails: the site also accepts the query in the URL.
function prefilledUrl(league, body, game) {
  return `${pageUrl(game, league)}?q=${encodeURIComponent(JSON.stringify(body))}`;
}
// is this a trade site page of this app's games (for opening links)
function isTradePage(url) {
  return typeof url === 'string' && Object.values(games.GAMES).some((g) => url.startsWith(`${BASE}/${g.trade.page}/`));
}

// The searches are built in PoE2's shape; PoE1's trade site splits PoE2's equipment_filters into
// armour_filters and weapon_filters and has no Spirit or rune sockets.
const POE1_ARMOUR = ['ar', 'ev', 'es', 'block', 'ward'];
const POE1_WEAPON = ['dps', 'pdps', 'edps', 'aps', 'crit'];
function adaptQuery(body, game) {
  if (!body || !body.query || games.gameOf(game).id !== 'poe1') return body;
  const f = body.query.filters || {};
  const eq = f.equipment_filters && f.equipment_filters.filters;
  if (eq) {
    const armour = {}; const weapon = {};
    for (const [k, v] of Object.entries(eq)) {
      if (POE1_ARMOUR.includes(k)) armour[k] = v;
      else if (POE1_WEAPON.includes(k)) weapon[k] = v;
    }
    delete f.equipment_filters;
    if (Object.keys(armour).length) f.armour_filters = { filters: armour };
    if (Object.keys(weapon).length) f.weapon_filters = { filters: weapon };
  }
  if (f.misc_filters && f.misc_filters.filters) delete f.misc_filters.filters.rune_sockets;
  body.query.filters = f;
  return body;
}

module.exports = { apiUrl, pageUrl, searchUrl, fetchUrl, resultsUrl, prefilledUrl, isTradePage, adaptQuery };
