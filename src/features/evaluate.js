'use strict';

// Judging one item: the gear score (PoE2) and Path of Building's verdict against what you wear.
const ignoreLib = require('../core/ignore');
const gearLib = require('../core/gearscore');
const characterLib = require('../core/character');
const { compare } = require('../core/scorer');
const { SLOT_GROUPS, WEAKEST_OF } = require('../core/slots');

module.exports = function (C) {
  // gear score of `item` if it went in `slot` (defaults to the item's own slot)
  // the gear score's build profiles are for PoE2; PoE1 items are judged by Path of Building only
  const gearScoreOn = () => C.store.settings.build !== 'off' && C.tg() === 'poe2';
  function gearOf(item, slot) {
    if (!item || !gearScoreOn()) return null;
    const target = slot || (item.slot && SLOT_GROUPS[item.slot] ? SLOT_GROUPS[item.slot][0] : item.slot);
    return gearLib.gearScore(item, { ...C.gearOpts(), resNeed: C.resNeedFor(target) });
  }
  // One verdict: when a build is chosen, UPGRADE/DOWNGRADE comes from the gear
  // score (how useful the item is to your build). Your stat weights are only
  // used when the build is turned off, or for "By my weights" searches.
  function evaluate(item) {
    const rules = C.ignoreRules();
    const ignore = (k) => ignoreLib.isIgnored(rules, k);
    const r = compare(item, C.store.equipped, C.store.weights, { ignore });
    if (!r || !r.ok) return r;
    r.ignoring = ignoreLib.describe(rules);
    const gearOn = gearScoreOn();
    r.gear = gearOf(item, r.targetSlot);
    if (gearOn && r.gear && r.gear.score != null) {
      // rings / charms / jewels: compare with your weakest one by gear score
      const group = WEAKEST_OF.includes(item.slot) ? SLOT_GROUPS[item.slot] : null;
      if (group && group.every((sl) => C.store.equipped[sl]) && !r.isEquipped) {
        const scored = group.map((sl) => { const gg = gearOf(C.store.equipped[sl], sl); return [sl, gg && gg.score != null ? gg.score : 0]; });
        const weaker = scored.sort((a, b) => a[1] - b[1])[0][0];
        if (weaker !== r.targetSlot) {
          r.targetSlot = weaker;
          r.replacing = [C.store.equipped[weaker].name];
          r.rows = require('../core/scorer').diffStats(item.stats, C.store.equipped[weaker].stats, C.store.weights, ignore);
          r.gear = gearOf(item, weaker);
        }
      }
      const eqItem = C.store.equipped[r.targetSlot];
      const ge = r.isEquipped ? null : gearOf(eqItem, r.targetSlot);
      r.gearEquipped = ge;
      r.scoreMode = 'gear';
      if (!r.isEquipped && eqItem) {
        const yours = ge && ge.score != null ? ge.score : null;
        if (yours == null) { r.delta = null; r.verdict = 'same'; } else {
          r.delta = r.gear.score - yours;
          r.pct = null;
          // a few points either way is noise: only +6 or more is a real upgrade
          r.verdict = r.delta >= 6 ? 'upgrade' : r.delta >= 3 ? 'small' : r.delta <= -3 ? 'downgrade' : 'same';
        }
      }
    } else {
      r.scoreMode = 'weights';
      r.gearEquipped = r.isEquipped ? null : gearOf(C.store.equipped[r.targetSlot], r.targetSlot);
    }
    // what changes on your character if you equip it
    if (!r.isEquipped && r.targetSlot) {
      const slots = [r.targetSlot];
      if (item.twoHanded && r.targetSlot === 'Weapon' && C.store.equipped.Offhand) slots.push('Offhand');
      try {
        r.character = characterLib.changeIfEquipped(C.store.equipped, item, slots, {
          resists: C.liveResists(),
          gearScore: gearOn ? (it, sl) => { const g = gearOf(it, sl); return g && g.score != null ? g.score : null; } : null,
        });
      } catch (err) { C.log('character change: ' + err.message); }
      // things the score doesn't see that can make an "upgrade" a sidegrade (or worse)
      const ch = r.character;
      const risks = [];
      if (ch) {
        const sp = (ch.lines || []).find((l) => l.label === 'Spirit');
        if (sp && sp.delta < 0) risks.push(`Spirit ${sp.delta}: check your minions and auras still fit`);
        for (const w of ch.warnings || []) risks.push(w);
        const lv = (ch.lines || []).find((l) => l.label === 'Minion skill levels');
        if (lv && lv.delta < 0) risks.push(`${lv.delta} minion skill level${lv.delta === -1 ? '' : 's'}`);
        // your resistance totals aren't known: a big drop can't be checked against the cap, so it's said
        for (const x of ch.res || []) {
          if (x.from == null && x.delta <= -10 && (x.el !== 'chaos' || C.pobPriorities().chaos)) risks.push(`${x.label || x.el} ${x.delta}%: type your resistances on My gear (or add your Path of Building build) to see if this takes you under the cap`);
        }
      }
      if (risks.length) {
        r.risks = risks;
        if (r.verdict === 'upgrade' || r.verdict === 'small') r.verdict = 'risky';
      }
      // resistances matter most: losing them (off the cap or further under it) is its own verdict
      const lost = ch ? (ch.res || []).filter((x) => x.from != null && x.delta < 0 && x.under && (x.el !== 'chaos' || (!C.pobCI() && (C.pobPriorities().chaos || !x.wasUnder)))) : [];
      if (lost.length && !r.isEquipped) r.verdict = 'resloss';
      r.resRank = lost.length ? -1 : ch && (ch.res || []).some((x) => x.wasUnder && !x.under) ? 2 : ch && (ch.res || []).some((x) => x.wasUnder && x.delta > 0) ? 1 : 0;
    }
    // how much each changed stat matters to the build (for colours / top changes)
    const go = C.gearOpts();
    r.rows = r.rows.map((row) => ({ ...row, useful: gearOn ? gearLib.usefulness(item.slot, row.key, go) : (row.weight || 0) }))
      .sort((a, b) => Math.abs(b.diff * b.useful) - Math.abs(a.diff * a.useful) || Math.abs(b.diff) - Math.abs(a.diff));
    // PoE1: no gear score, so without Path of Building there's no honest verdict to give
    // PoE1 flasks have no slot of their own in the app: Path of Building's flask slots decide, so
    // until it answers (or without a build) there's no verdict, never "empty slot"
    if (item.slot === 'Flask') { r.verdict = 'unjudged'; r.delta = null; r.pct = null; r.unjudged = C.poe1Unjudged(item, r.targetSlot) || null; }
    // (an "empty" slot in PoE1 usually just means nothing was saved there, so it's no verdict either)
    else if (C.tg() === 'poe1' && !r.isEquipped) {
      const why = C.poe1Unjudged(item, r.targetSlot);
      if (why) { r.verdict = 'unjudged'; r.unjudged = why; r.delta = null; r.pct = null; }
    }
    // unidentified: the mods are hidden, so there's nothing honest to say about it for your build yet
    if (item.unidentified && !r.isEquipped) { r.verdict = 'unjudged'; r.delta = null; r.pct = null; r.unjudged = 'Unidentified: its mods are hidden. Identify it, then press the hotkey again.'; }
    return r;
  }

  return {
    gearScoreOn,
    gearOf,
    evaluate,
  };
};
