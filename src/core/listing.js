'use strict';

// Turns trade-site listings (from /api/trade2/fetch) into the same item
// objects the rest of the app uses, so each listing can be scored against
// your equipped gear. Written defensively: field names that differ between
// game versions are all tried, and anything unknown is simply skipped.

const { parseItem } = require('./parser');

// PoE2 mod text can carry wiki markup: "+39% to [Lightning|Lightning] [Resistances|Resistance]"
function clean(text) {
  return String(text == null ? '' : text)
    .replace(/\[([^\]|]+)\|([^\]]+)\]/g, '$2')
    .replace(/\[([^\]]+)\]/g, '$1')
    .replace(/<[^>]*>{([^}]*)}/g, '$1') // <tag>{text}
    .replace(/\s+/g, ' ')
    .trim();
}

// A mod line can be a plain string or (newer trade API) an object like
// { description: "+39% to [Lightning|Lightning] Resistance", ... }.
function rawModText(m) {
  if (m == null) return '';
  if (typeof m === 'string') return m;
  if (typeof m !== 'object') return ''; // a bare number etc. isn't a mod line
  let t = m.description || m.text || m.line || m.mod || m.name || '';
  if (typeof t !== 'string') t = '';
  const vals = Array.isArray(m.values) ? m.values.map((v) => (Array.isArray(v) ? v[0] : v)) : [];
  if (/\{\d\}/.test(t) && vals.length) t = t.replace(/\{(\d)\}/g, (all, i) => (vals[i] != null ? vals[i] : all));
  return t;
}
function modText(m) { return clean(rawModText(m)); }
// One trade-site mod string can hold several lines ("+10% to Fire Resistance\n+10% to Cold Resistance").
function modLines(m) { return rawModText(m).split(/\r?\n/).map(clean).filter(Boolean); }
const arr = (v) => (Array.isArray(v) ? v : []);

function propLine(p) {
  if (!p || !p.name) return null;
  const name = clean(p.name);
  const vals = arr(p.values).map((v) => clean(Array.isArray(v) ? v[0] : v)).filter(Boolean);
  if (!vals.length) return null;
  if (name.includes('{0}')) return vals.reduce((s, v, i) => s.replace(`{${i}}`, v), name);
  return `${name}: ${vals.join(', ')}`;
}

const MOD_GROUPS = [
  ['enchantMods', '(enchant)'],
  ['runeMods', '(rune)'],
  ['implicitMods', '(implicit)'],
  ['fracturedMods', '(fractured)'],
  ['explicitMods', ''],
  ['desecratedMods', '(desecrated)'],
  ['craftedMods', '(crafted)'],
  // PoE1
  ['scourgeMods', '(scourge)'],
  ['crucibleMods', '(crucible)'],
  ['veiledMods', ''],
];

function rarityOf(it) {
  if (typeof it.rarity === 'string') return it.rarity;
  return ['Normal', 'Magic', 'Rare', 'Unique'][it.frameType] || 'Rare';
}

// result: one element of fetch().result; itemClass: the class we searched for
function listingToItem(result, itemClass) {
  const it = (result && result.item) || {};
  const lines = [`Item Class: ${itemClass || 'Unknown'}`, `Rarity: ${rarityOf(it)}`];
  const name = clean(it.name);
  const base = clean(it.typeLine || it.baseType);
  if (name) lines.push(name);
  if (base) lines.push(base);
  const blocks = [lines.join('\n')];
  const props = arr(it.properties).map(propLine).filter(Boolean);
  if (props.length) blocks.push(props.join('\n'));
  // PoE1 sockets: [{ group, sColour }] -> "Sockets: R-G-B B" (same group = linked)
  const socks = arr(it.sockets).filter((x) => x && x.sColour);
  if (socks.length) blocks.push('Sockets: ' + socks.map((x, i) => (i && socks[i - 1].group === x.group ? '-' : i ? ' ' : '') + x.sColour).join(''));
  if (it.ilvl) blocks.push(`Item Level: ${it.ilvl}`);
  for (const [field, tag] of MOD_GROUPS) {
    const mods = arr(it[field]).flatMap(modLines);
    if (mods.length) blocks.push(mods.map((m) => (tag ? `${m} ${tag}` : m)).join('\n'));
  }
  // PoE1 influences ({ shaper: true }) and the like, as the game prints them
  const inf = it.influences && typeof it.influences === 'object' ? Object.keys(it.influences).filter((k) => it.influences[k]) : [];
  if (inf.length) blocks.push(inf.map((k) => k.charAt(0).toUpperCase() + k.slice(1) + ' Item').join('\n'));
  if (it.synthesised) blocks.push('Synthesised Item');
  if (it.fractured && !arr(it.fracturedMods).length) blocks.push('Fractured Item');
  if (it.corrupted) blocks.push('Corrupted');
  if (it.identified === false) blocks.push('Unidentified');
  const text = blocks.join('\n--------\n');
  const item = parseItem(text);
  if (item) item.listingText = text;
  return item;
}

// A listing price we can use: a positive amount and a currency. Anything else is "no price"
// (an empty amount must not read as free).
function validPrice(price) {
  if (!price || typeof price !== 'object' || !price.currency) return false;
  const a = price.amount;
  if (a == null || (typeof a === 'string' && !a.trim()) || typeof a === 'boolean') return false;
  const n = Number(a);
  return Number.isFinite(n) && n > 0;
}

// Price in exalted orbs using { currencyId: exaltsEach } rates (PoE1: base 'chaos', chaos each).
function priceInEx(price, rates, base = 'exalted') {
  if (!validPrice(price)) return null;
  const cur = String(price.currency || '').toLowerCase();
  const r = (rates && rates[cur]) || (cur === base || (base === 'exalted' && cur === 'exalt') ? 1 : null);
  return r ? Number(price.amount) * r : null;
}

function formatPrice(price) {
  if (!validPrice(price)) return 'no price';
  const names = { divine: 'div', exalted: 'ex', chaos: 'chaos', mirror: 'mirror', annul: 'annul', regal: 'regal', alch: 'alch', vaal: 'vaal' };
  const cur = String(price.currency);
  return `${Number(price.amount)} ${names[cur.toLowerCase()] || cur}`;
}

function summarise(result, itemClass, rates, base) {
  const listing = (result && result.listing) || {};
  const item = listingToItem(result, itemClass);
  const acct = listing.account || {};
  return {
    id: result && result.id,
    item,
    price: validPrice(listing.price) ? listing.price : null,
    priceText: formatPrice(listing.price),
    priceEx: priceInEx(listing.price, rates, base),
    seller: acct.lastCharacterName || acct.name || '',
    account: acct.name || '',
    online: !!(acct.online),
    instant: !listing.whisper, // no whisper text = merchant (instant buyout) listing
    whisper: typeof listing.whisper === 'string' && !/\{\d\}/.test(listing.whisper) ? listing.whisper : null,
    indexed: listing.indexed || null,
    hideoutToken: listing.hideout_token || null,
  };
}

module.exports = { clean, modText, modLines, validPrice, listingToItem, priceInEx, formatPrice, summarise };
