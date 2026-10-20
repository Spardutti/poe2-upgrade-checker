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

function propLine(p) {
  if (!p || !p.name) return null;
  const name = clean(p.name);
  const vals = (p.values || []).map((v) => clean(Array.isArray(v) ? v[0] : v)).filter(Boolean);
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
  const props = (it.properties || []).map(propLine).filter(Boolean);
  if (props.length) blocks.push(props.join('\n'));
  if (it.ilvl) blocks.push(`Item Level: ${it.ilvl}`);
  for (const [field, tag] of MOD_GROUPS) {
    const mods = (it[field] || []).map(clean).filter(Boolean);
    if (mods.length) blocks.push(mods.map((m) => (tag ? `${m} ${tag}` : m)).join('\n'));
  }
  if (it.corrupted) blocks.push('Corrupted');
  if (it.identified === false) blocks.push('Unidentified');
  const text = blocks.join('\n--------\n');
  const item = parseItem(text);
  if (item) item.listingText = text;
  return item;
}

// Price in exalted orbs using { currencyId: exaltsEach } rates.
function priceInEx(price, rates) {
  if (!price || !Number.isFinite(Number(price.amount))) return null;
  const cur = String(price.currency || '').toLowerCase();
  const r = (rates && rates[cur]) || (cur === 'exalted' || cur === 'exalt' ? 1 : null);
  return r ? Number(price.amount) * r : null;
}

function formatPrice(price) {
  if (!price) return 'no price';
  const names = { divine: 'div', exalted: 'ex', chaos: 'chaos', mirror: 'mirror', annul: 'annul', regal: 'regal', alch: 'alch', vaal: 'vaal' };
  return `${Number(price.amount)} ${names[price.currency] || price.currency}`;
}

function summarise(result, itemClass, rates) {
  const listing = (result && result.listing) || {};
  const item = listingToItem(result, itemClass);
  const acct = listing.account || {};
  return {
    id: result && result.id,
    item,
    price: listing.price || null,
    priceText: formatPrice(listing.price),
    priceEx: priceInEx(listing.price, rates),
    seller: acct.lastCharacterName || acct.name || '',
    account: acct.name || '',
    online: !!(acct.online),
    instant: !listing.whisper, // no whisper text = merchant (instant buyout) listing
    whisper: typeof listing.whisper === 'string' && !/\{\d\}/.test(listing.whisper) ? listing.whisper : null,
    indexed: listing.indexed || null,
    hideoutToken: listing.hideout_token || null,
  };
}

module.exports = { clean, listingToItem, priceInEx, formatPrice, summarise };
