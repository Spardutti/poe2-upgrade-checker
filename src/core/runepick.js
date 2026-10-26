'use strict';

// PoE2 runes, soul cores and idols: Path of Building tries each one that fits each socket on your gear
// (pob/server.lua runeCheck); this ranks them with the usual verdict, picks the best set, and works
// out what's worth buying. Pure functions, so they can be tested without the engine.

// { slots: [{ slot, item, sockets, added, unknown, current, results: [{ socket, rune, type, req, lines, after }] }], before }
// judge(before, after) -> { score, verdict, breaks, dps, ehp, ... } (pobVerdict.judge with your priorities)
// -> [{ slot, item, socket, added, unknown, current, options: [{ rune, type, req, lines, score, verdict, breaks, dpsPct, ehpPct, resGain }] }]
const MIN_SCORE = 0.05; // under this a change is noise (PoB rounding), not a gain

function rank(check, judge, opts = {}) {
  const keep = opts.keep || 4;
  const out = [];
  for (const s of (check && check.slots) || []) {
    for (let socket = 1; socket <= (s.sockets || 1); socket++) {
      const options = [];
      for (const r of s.results || []) {
        if (r.socket !== socket || !r.after) continue;
        const j = judge(check.before, r.after);
        if (!j) continue;
        options.push({ rune: r.rune, type: r.type || 'Rune', req: r.req || 0, lines: (r.lines || []).slice(0, 4).map(String), score: round(j.score), verdict: j.verdict, breaks: j.breaks || [],
          dpsPct: j.dps && j.dps.pct != null ? round(j.dps.pct) : null, ehpPct: j.ehp && j.ehp.pct != null ? round(j.ehp.pct) : null, resGain: j.resGain || 0 });
      }
      // nothing that breaks the build first, then the biggest gain; one kind of rune once per socket
      options.sort((a, b) => (a.breaks.length - b.breaks.length) || (b.score - a.score));
      let cur = (s.current || [])[socket - 1];
      let guessed = false;
      // a rune the copied text doesn't name: the one whose mod lines are exactly the item's rune lines
      // is the one you have (one socket only: with more, two runes' lines add up)
      if (s.unknown && (s.sockets || 1) === 1 && (s.runeLines || []).length) {
        const have = new Set(s.runeLines.map(norm));
        const same = (s.results || []).filter((r) => r.socket === socket && (() => { const own = (r.lines || []).filter((l) => !/^Bonded:/i.test(l)).map(norm); return own.length && own.length === have.size && own.every((l) => have.has(l)); })());
        if (same.length === 1) { cur = same[0].rune; guessed = true; }
      }
      const known = cur && cur !== 'None' && cur !== '?';
      // what your rune gives now (compared with the socket empty), when the app can work it out
      const yours = s.unknown && s.bare ? judge(s.bare, check.before) : null;
      out.push({ slot: s.slot, item: s.item, socket, sockets: s.sockets || 1, added: !!s.added, unknown: !!s.unknown && !guessed, guessed, current: known ? cur : null,
        yours: yours ? { score: round(yours.score), dpsPct: yours.dps && yours.dps.pct != null ? round(yours.dps.pct) : null, ehpPct: yours.ehp && yours.ehp.pct != null ? round(yours.ehp.pct) : null, resGain: yours.resGain || 0 } : null,
        options: options.filter((o) => o.rune !== cur).slice(0, keep), best: options.find((o) => o.rune !== cur && !o.breaks.length && o.score >= MIN_SCORE) || null });
    }
  }
  return out;
}

// the best rune for each socket where one helps -> [{ slot, socket, rune }]
function picks(ranked) {
  return ranked.filter((r) => r.best).map((r) => ({ slot: r.slot, socket: r.socket, rune: r.best.rune }));
}

// what's worth buying first: gain per divine (free when it costs next to nothing), biggest first.
// price(rune) -> { eachDiv } | null
function shoppingList(ranked, price) {
  const list = [];
  for (const r of ranked) {
    if (!r.best) continue;
    const p = price(r.best.rune);
    const div = p && p.eachDiv != null ? p.eachDiv : null;
    list.push({ slot: r.slot, socket: r.socket, rune: r.best.rune, score: r.best.score, added: r.added, priceDiv: div, perDiv: div == null ? null : round(r.best.score / Math.max(div, 0.02)) });
  }
  // known prices by value for money, unknown ones after, by gain
  return list.sort((a, b) => (a.perDiv == null) - (b.perDiv == null) || (b.perDiv || 0) - (a.perDiv || 0) || b.score - a.score);
}

const norm = (l) => String(l || '').replace(/\s*\((rune|augmented)\)\s*$/i, '').trim().toLowerCase();
// the same build numbers (PoB's own rounding aside)
const KEYS = ['FullDPS', 'CombinedDPS', 'MinionDPS', 'TotalEHP', 'Life', 'EnergyShield', 'Mana', 'Armour', 'Evasion', 'Spirit', 'FireResistTotal', 'ColdResistTotal', 'LightningResistTotal', 'ChaosResistTotal', 'MovementSpeedMod', 'Str', 'Dex', 'Int'];
function sameStats(a, b) {
  if (!a || !b) return false;
  return KEYS.every((k) => { const x = Number(a[k]); const y = Number(b[k]); if (!Number.isFinite(x) && !Number.isFinite(y)) return true; return Math.abs((x || 0) - (y || 0)) <= Math.max(0.5, Math.abs(x || 0) * 0.001); });
}
const round = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10) / 10);

module.exports = { rank, picks, shoppingList, sameStats, MIN_SCORE };
