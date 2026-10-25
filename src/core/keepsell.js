'use strict';

// Keep, sell or vendor: one plain answer under the verdict, from what the app already knows.
//  - KEEP: it's an upgrade for your build (or fills an empty slot)
//  - SELL: it isn't, but it's worth something (poe.ninja's price, or your own "What's it worth?")
//  - VENDOR: it isn't, and it's worth less than the sell line (or it's a plain magic / normal item)
//  - PRICE CHECK: a rare or unique we have no price for: check before you vendor it
// The sell line is a small fraction of a divine (or a few chaos / exalts without a divine rate).
// Loaded by the popup too (<script src="../core/keepsell.js">), so no requires.

(function (root) {
  const KEEP = new Set(['upgrade', 'small', 'risky', 'new']);

  // the least an item should be worth to be worth listing, in the game's base currency
  function sellLine(rate, unit) {
    if (rate > 0) return Math.max(1, Math.round(rate * 0.02 * 10) / 10);
    return unit === 'chaos' ? 5 : 2;
  }

  // what it's worth in the base currency (ex / chaos), or null
  function valueOf(r, rate) {
    if (r.worthEx != null && Number.isFinite(Number(r.worthEx))) return Number(r.worthEx);
    const p = r.ninja;
    if (!p) return null;
    // a stack is sold whole: what the stack is worth
    const n = Number(p.stack) > 1 ? Number(p.stack) : 1;
    if (p.each != null && p.unit === r.unit) return Number(p.each) * n;
    if (p.eachDiv != null && rate > 0) return Number(p.eachDiv) * rate * n;
    return null;
  }

  const money = (v, unit, rate) => {
    if (rate > 0 && v >= rate * 0.95) return `${Math.round((v / rate) * 10) / 10} div`;
    return `${v < 10 ? Math.round(v * 10) / 10 : Math.round(v)} ${unit}`;
  };

  // r: a popup result (as main.js serialises it)
  function advise(r) {
    if (!r || !r.ok || !r.item || r.isEquipped || r.kind === 'map') return null;
    const it = r.item;
    const rarity = String(it.rarity || '').toLowerCase();
    const unit = r.unit || 'ex';
    const rate = Number(r.ui && r.ui.divineRate) || 0;
    if (r.kind === 'price' && r.gem && r.gem.hits.some((h) => (h.verdict === 'upgrade' || h.verdict === 'small') && !(h.level === h.newLevel && h.quality === h.newQuality))) {
      return { action: 'keep', text: 'better than the one in your build' };
    }
    if (r.kind === 'price') {
      // currency, cards, gems...: only worth a word when we know the price
      if (/currency|stackable/i.test(it.itemClass || '') || !r.ninja) return null;
    } else if (r.pobPending && rarity !== 'unique') return null; // wait for Path of Building's verdict
    else if (r.verdict === 'unjudged' && rarity !== 'unique') return null;
    else if (it.slot === 'Flask' && !r.pob) return null; // PoE1 flask not (yet) judged by Path of Building
    if (r.kind !== 'price' && KEEP.has(r.verdict)) {
      // the verdict above already says why
      return { action: 'keep', text: '' };
    }
    if (r.ninja && r.ninja.unsure && r.worthEx == null) return { action: 'check', text: 'several versions of this unique: check its price' };
    const v = valueOf(r, rate);
    const line = sellLine(rate, unit);
    if (v != null) {
      const src = r.worthEx != null ? 'similar items sell for' : 'poe.ninja says';
      return v >= line
        ? { action: 'sell', text: `${src} about ${money(v, unit, rate)}` }
        : { action: 'vendor', text: `${src} under ${money(line, unit, rate)}` };
    }
    if (rarity === 'unique') return { action: 'check', text: "no price yet: press What's it worth?" };
    if (rarity === 'rare') {
      if (it.unidentified) return { action: 'check', text: 'identify it, then check again' };
      return { action: 'check', text: "not an upgrade; check its price before you vendor it" };
    }
    if (rarity === 'magic' || rarity === 'normal') return { action: 'vendor', text: 'not an upgrade, and magic and normal items rarely sell' };
    return null;
  }

  const api = { advise, sellLine, valueOf };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.keepSell = api;
})(typeof window !== 'undefined' ? window : this);
