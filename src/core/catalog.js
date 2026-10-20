'use strict';

// The stat database for the stat picker: every stat the PoE2 trade site
// knows (from its public stat list), merged by wording, with which kinds it
// comes in (explicit, pseudo total, implicit, rune, desecrated...) and how
// often you've seen it on each item class you've copied.

const { norm } = require('./statnorm');

const KIND_LABEL = {
  pseudo: 'Total', explicit: 'Explicit', implicit: 'Implicit', augment: 'Rune', rune: 'Rune',
  desecrated: 'Desecrated', fractured: 'Fractured', crafted: 'Crafted', enchant: 'Enchant', skill: 'Skill',
};
const SKIP_KINDS = ['sanctum'];
// Pseudo "count" stats (# Prefix Modifiers etc.) aren't useful here.
const SKIP_TEXT = /^# (Empty |Unrevealed |Desecrated |Fractured |Crafted |Enchant |Implicit |Prefix |Suffix )*(Prefix |Suffix )?Modifiers$|uses remaining/;

function buildCatalog(statIndex, seenByClass) {
  const byNorm = new Map();
  for (const e of statIndex.all) {
    if (SKIP_KINDS.includes(e.type) || SKIP_TEXT.test(e.text)) continue;
    const k = norm(e.text);
    let c = byNorm.get(k);
    if (!c) { c = { n: k, text: e.text, kinds: {}, seen: {} }; byNorm.set(k, c); }
    if (!c.kinds[e.type]) c.kinds[e.type] = e.id;
    // show the explicit wording when there is one (reads like the item)
    if (e.type === 'explicit' && !c.kinds.__shown) { c.text = e.text; c.kinds.__shown = 1; }
  }
  for (const [cls, stats] of Object.entries(seenByClass || {})) {
    for (const [key, count] of Object.entries(stats)) {
      const c = byNorm.get(norm(key));
      if (c) c.seen[cls] = (c.seen[cls] || 0) + count;
    }
  }
  const entries = Array.from(byNorm.values()).map((c) => {
    delete c.kinds.__shown;
    return c;
  });
  entries.sort((a, b) => a.text.localeCompare(b.text));
  return { entries, classes: Object.keys(seenByClass || {}).sort(), kindLabel: KIND_LABEL };
}

// Turn a trade stat wording into the key the app uses for weights
// ("+#% to Fire Resistance" -> "#% to Fire Resistance").
function itemKeyFromText(text) {
  return String(text).replace(/\+#/g, '#').replace(/\s*\(Local\)\s*$/i, '').trim();
}

module.exports = { buildCatalog, itemKeyFromText, KIND_LABEL };
