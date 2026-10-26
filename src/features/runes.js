'use strict';

// PoE2: the best rune, soul core or idol for each socket on your gear (Character page). Path of
// Building tries every one that fits (pob/server.lua runeCheck), core/runepick ranks them with your
// priorities, the picks are tried all together, and poe.ninja prices say what's worth buying first.
const { ipcMain } = require('electron');
const runepick = require('../core/runepick');

module.exports = function (C) {
  const last = new Map(); // character -> { gen, r }
  // the best rune for each socket from the last check (for the loot filter)
  C.runePicks = () => { const l = last.get(C.store.data.activeProfile); return l && l.r && l.r.ok ? [...new Set(l.r.ranked.filter((x) => x.best).map((x) => x.best.rune))] : []; };
  ipcMain.handle('pob:runes', async (_e, opts) => {
    if (C.tg() !== 'poe2') return { ok: false, error: 'Runes and soul cores are a Path of Exile 2 thing.' };
    if (!C.pobOn()) return { ok: false, error: 'Add your Path of Building build on My gear first.' };
    const key = C.store.data.activeProfile;
    const gen = C.pobSheetGen();
    if (!(opts && opts.refresh) && last.has(key) && last.get(key).gen === gen) return last.get(key).r;
    try {
      const eng = C.pobEngine();
      const info = await eng.ensureLoaded();
      // your level decides which tiers you can use (Path of Building's level, or your levelling level)
      const lv = C.store.settings.leveling;
      const level = lv && lv.on && Number(lv.level) > 0 ? Number(lv.level) : (info && Number(info.level)) || 100;
      const check = await eng.runeCheck({ level });
      // the app's slot names ("Weapon 1" is your Weapon, "Weapon 2" your Offhand)
      const NAME = { 'Weapon 1': 'Weapon', 'Weapon 2': 'Offhand' };
      const pobName = {};
      for (const s of check.slots || []) { const ours = NAME[s.slot] || s.slot; pobName[ours] = s.slot; s.slot = ours; }
      const judge = (a, b) => C.pobVerdict.judge(a, b, C.pobWeights());
      const ranked = runepick.rank(check, judge);
      // the picks together: runes in different slots can overlap (two lots of fire res past the cap)
      const chosen = runepick.picks(ranked);
      let together = null;
      if (chosen.length > 1) {
        try {
          const t = await eng.runeApply(chosen.map((p) => ({ ...p, slot: pobName[p.slot] || p.slot })));
          const j = judge(t.before, t.after);
          if (j) together = { score: j.score, verdict: j.verdict, dpsPct: j.dps && j.dps.pct, ehpPct: j.ehp && j.ehp.pct, breaks: j.breaks || [], resGain: j.resGain || 0 };
        } catch (err) { C.log('runes together: ' + err.message); }
      }
      // prices of the runes worth having (poe.ninja exchange lists), so the cheap wins come first
      const names = [...new Set(ranked.filter((r) => r.best).map((r) => r.best.rune))];
      const prices = {};
      await Promise.all(names.map((n) => C.ninjaPrice({ itemClass: 'Socketable', rarity: 'Currency', name: n, baseType: n })
        .then((p) => { if (p) prices[n] = { each: p.each, eachDiv: p.eachDiv, unit: p.unit }; }).catch(() => {})));
      const shop = runepick.shoppingList(ranked, (n) => prices[n] || null);
      const r = { ok: true, level, ranked, together, prices, shop, partial: (check.slots || []).some((s) => s.partial), at: Date.now() };
      last.set(key, { gen, r });
      return r;
    } catch (err) { C.log('rune check: ' + (err.message || err)); return { ok: false, error: err.message || String(err) }; }
  });
};
