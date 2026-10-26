'use strict';

// Shared renderer for a comparison result (used by the popup and the
// settings "Test an item" tab). Exposes window.renderComparison.

(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => {
    const r = Math.round(n * 100) / 100;
    return (r > 0 ? '+' : '') + (Number.isInteger(r) ? r : r.toFixed(1));
  };

  function label(key, diff) {
    key = String(key).replace(/^\[Base\]\s*/, '').replace(/\s*\(Local\)\s*$/i, ''); // internal tags, not game text
    if (!key.includes('#')) return `${fmt(diff)} ${key}`;
    let first = true;
    // "+# to x" style keys: put the signed diff in the first #, leave other #s as "…"
    return key.replace(/#/g, () => { if (first) { first = false; return fmt(diff); } return '…'; })
      .replace(/^\+\+/, '+').replace(/^\+-/, '-');
  }

  // a trade stat's template as a name: "# to maximum Life" -> "Maximum Life", "#% increased Energy Shield" -> "Increased Energy Shield"
  function statName(key) {
    let t = String(key).replace(/^\[(Base|Weapon)\]\s*/, '').replace(/\s*\(Local\)\s*$/i, '');
    t = t.replace(/^[+-]?#%?\s*(to\s+)?/i, '').replace(/#%?/g, '…').trim();
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : String(key);
  }
  window.statName = statName;
  // an item's mods, each with its tier (T1 is the best) and how high it rolled, when the game said (advanced copy)
  window.modsHtml = function (lines) {
    return (lines || []).filter((l) => l.tag !== 'info').map((l) => {
      const t = l.tier != null ? `<span class="tier ${l.tier <= 2 ? 'tier-top' : l.tier <= 4 ? 'tier-mid' : 'tier-low'}" title="${esc(l.affix ? `"${l.affix}", ` : '')}tier ${l.tier} (T1 is the best)">T${esc(l.tier)}</span>` : '';
      const roll = l.roll != null ? ` <span class="dim small" title="How high in its range it rolled">${esc(l.roll)}%</span>` : '';
      return `<div class="mod ${esc(l.tag)}">${t}${esc(l.text)}${roll}</div>`;
    }).join('');
  };
  const VERDICT = {
    upgrade: { text: 'UPGRADE', cls: 'up' },
    small: { text: 'SMALL UPGRADE', cls: 'up' },
    risky: { text: 'UPGRADE ⚠', cls: 'risky' },
    resloss: { text: 'LOSES RESISTANCE', cls: 'down' },
    dmgloss: { text: 'LOSES DAMAGE', cls: 'down' },
    downgrade: { text: 'DOWNGRADE', cls: 'down' },
    same: { text: 'SIDEGRADE', cls: 'same' },
    new: { text: 'EMPTY SLOT', cls: 'new' },
    equipped: { text: 'EQUIPPED', cls: 'same' },
    unjudged: { text: 'NOT JUDGED', cls: 'same' },
  };

  function equipButtons(r) {
    const item = r.item;
    let slots;
    const groups = (r.slots && r.slotGroups) || {};
    if (groups[item.slot]) slots = groups[item.slot];
    else if (item.slot === 'Ring') slots = ['Ring 1', 'Ring 2'];
    else slots = [item.slot];
    return slots.map((s) => `<button class="equip" data-slot="${esc(s)}">Set as ${esc(s)}</button>`).join('');
  }

  // Shows the outcome of a trade search in `el` (text + "open anyway" link).
  window.showSearchResult = function (el, res) {
    if (!res) { el.textContent = ''; return; }
    if (!res.ok) { el.textContent = res.error || 'Search failed.'; return; }
    const where = `${res.league}${res.budget ? ', ' + res.budget : ''}`;
    let t;
    if (res.total === 0) {
      t = `No listings found (${where}).`;
      if (res.mode === 'price') t += ' Nothing similar is listed – it may be rare (or worth little).';
      else if (res.mode === 'craft') t += ' No rare base with those stats and an open affix right now – try a higher price limit.';
      else if (res.mode === 'similar') t += ` Even at ${res.levelLabel || 'looser values'} with ${res.need} of ${res.of} stats nothing is listed – try a higher price limit, or Custom search and untick a stat.`;
      else if (res.mode === 'weights') t += ' Nothing scores higher with your weights – check they suit your build.';
      else if (res.mode === 'pob') t += ' Nothing is listed in your price range with the stats Path of Building looked for – try a higher price limit.';
      else if (res.mode === 'gear') t += ` Nothing listed is better for your build${res.score != null ? ` than your gear score ${res.score}` : ''}, even within 10% – try a higher price limit.`;
      else t += ' Untick a stat or lower some minimums.';
    } else {
      t = `${res.inApp ? 'Showing in the results window' : res.opened ? 'Opened in your browser' : 'Search ready'} (${where})${res.total != null ? ` – ${res.total} listing${res.total === 1 ? '' : 's'}` : ''}.`;
      if (res.mode === 'price' && res.summary && res.summary.typical) {
        // the answer first, big; the details small under it
        const sm = res.summary;
        el.innerHTML = `<div class="price-answer">≈ <b>${esc(sm.typical)}</b>${window.confHtml(sm.confidence)}</div>${sm.sell ? `<div class="sell-row"><span class="dim small">List it at</span> <b>${esc(sm.sell.text)}</b> <button class="link" data-note="${esc(sm.sell.note)}" title="Copies &quot;${esc(sm.sell.note)}&quot;: right-click the item in a premium stash tab and paste it into the note">Copy price note</button></div>` : ''}<div class="dim small">${[sm.range ? `most ${esc(sm.range)}` : '', `${esc(res.total)} similar listed`, sm.cheapest && !sm.range ? `cheapest ${esc(sm.cheapest)}` : '', res.level > 0 ? `compared with ${esc(res.levelLabel)}` : ''].filter(Boolean).join(' · ')}${sm.notes && sm.notes.length ? `. ${esc(sm.notes.join('; '))}` : ''}</div>`;
        const cp = el.querySelector('[data-note]');
        if (cp) cp.addEventListener('click', () => { window.api.copyText(cp.dataset.note); cp.textContent = 'Copied'; });
        return;
      }
      if (res.mode === 'price' && res.summary) {
        const sm = res.summary;
        t = `${sm.verdict || ''} ${res.total} similar listed.${sm.notes && sm.notes.length ? ` Note: ${sm.notes.join('; ')}.` : ''}`;
      }
      if (res.mode === 'price' && res.level > 0) t += ` Compared with ${res.levelLabel}.`;
      if (res.mode === 'craft' && res.keyStats) t += ` Rare bases with ${res.keyStats.join(' + ')} and an open affix to craft.`;
      if (res.mode === 'similar' && res.of) {
        t += res.unique ? ` Same unique${res.need ? `, ${res.need} of ${res.of} mods at ${res.levelLabel}` : ''}.` : ` At least ${res.need} of your ${res.of} stats at ${res.levelLabel}.`;
        if (res.level > 0) t += ' (Loosened: nothing matched your exact values.)';
      }
      if (res.mode === 'gear') t += res.level === 1 ? ' No clear upgrade listed; these are a little better than yours.' : res.level > 1 ? ` Nothing beats yours yet; these come close (${res.levelLabel}).` : ` Clearly better for your build than yours${res.score != null ? ` (gear score ${res.score})` : ''} – best for your build first.`;
      if (res.fallback) t = "The trade site didn't answer the search (it may be busy or down). Try again in a moment, or open it on the trade site.";
    }
    if (res.skipped && res.skipped.length) t += ` ${res.skipped.length} rune bonus${res.skipped.length === 1 ? '' : 'es'} left out (you can socket your own).`;
    if (res.ignored && res.ignored.length) t += ` Ignored: ${res.ignored.length} stat${res.ignored.length === 1 ? '' : 's'}.`;
    if (res.excluded) t += ' Listings with your excluded stats are hidden.';
    if (res.unmatched && res.unmatched.length) t += ` Not searchable: ${res.unmatched.join(', ')}.`;
    el.textContent = t;
    if (res.url && !res.opened) {
      const a = document.createElement('button');
      a.className = 'link'; a.textContent = res.fallback ? 'Open on trade site' : 'Open on trade site anyway';
      a.addEventListener('click', () => window.api.openUrl(res.url));
      el.appendChild(document.createTextNode(' ')); el.appendChild(a);
    }
  };

  // "If you equip it": changes to your character's totals (resistances vs cap, Spirit, ES, ...)
  window.characterBlock = function (ch, opts) {
    if (!ch) return '';
    opts = opts || {};
    const n = (v) => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10);
    const sg = (v) => `${v > 0 ? '+' : '−'}${n(Math.abs(v))}`;
    const items = [];
    if (ch.overall && ch.overall.delta) items.push({ cls: ch.overall.delta > 0 ? 'pos' : 'neg', html: `Average gear score of all you wear ${ch.overall.from} → <b>${ch.overall.to}</b>` });
    for (const r of ch.res || []) {
      if (r.from == null) { items.push({ cls: r.delta > 0 ? 'pos' : 'neg', html: `${esc(r.label)} ${sg(r.delta)}%` }); continue; }
      const capped = (v) => (v >= r.cap ? `${r.cap}%${v > r.cap ? ` (+${n(v - r.cap)} over)` : ''}` : `${n(v)}%`);
      // only matters when it crosses or sits below the cap
      const matters = r.under || r.wasUnder || (r.thin && r.delta < 0);
      items.push({ cls: r.under && r.delta < 0 ? 'neg warn' : r.thin && r.delta < 0 ? 'neg warn' : r.wasUnder && r.delta > 0 ? 'pos' : 'dim', html: `${esc(r.label)} ${capped(r.from)} → <b>${capped(r.to)}</b>${r.under ? ' ⚠ below cap' : r.thin && r.delta < 0 ? ' ⚠ barely capped' : ''}`, minor: !matters });
    }
    for (const l of ch.lines || []) items.push({ cls: l.delta > 0 ? 'pos' : 'neg', html: `${esc(l.label)} ${n(l.from)} → <b>${n(l.to)}</b> <span class="dim">(${sg(l.delta)})</span>` });
    if (!items.length && !(opts.risks && opts.risks.length)) return opts.empty ? '<div class="charch dim">No change to your totals.</div>' : '';
    const shown = opts.compact ? items.filter((x) => !x.minor).slice(0, 4) : items;
    const losses = (ch.res || []).filter((r) => r.from != null && r.delta < 0 && r.under && (r.el !== 'chaos' || !r.wasUnder));
    const banner = window.resLossBanner && losses.length && !opts.noBanner ? window.resLossBanner(losses) : '';
    const otherRisks = (opts.risks || []).filter((x) => !/res (drops below|goes further under) the cap/.test(x));
    const risk = banner + (otherRisks.length ? `<div class="risks">⚠ ${otherRisks.map(esc).join(' · ')}</div>` : '');
    if (!shown.length) return risk;
    return `${risk}<div class="charch"><span class="dim" title="Totals from your saved gear; resistances use the totals from Path of Building / My gear">If you equip it:</span> ${shown.map((x) => `<span class="cc ${x.cls}">${x.html}</span>`).join('')}</div>`;
  };

  // Big red warning for resistances an item drops off (or further under) the cap.
  // rows: [{ el, from, to, max }] (PoB) or the app's own res rows ({ label, from, to, cap })
  window.resLossBanner = function (rows, o) {
    if (!rows || !rows.length) return '';
    const txt = rows.map((r) => {
      const el = r.el || String(r.label || '').replace(/ res$/, '');
      const max = r.max || r.cap || 75;
      const from = Math.round(r.from); const to = Math.round(r.to);
      return `<b>${esc(el)}</b> ${Math.min(from, max)}% → <b>${to}%</b> <span>(${to - Math.min(from, max)} ${from >= max ? 'off the cap' : 'further under the cap'})</span>`;
    }).join(' · ');
    return o && o.plain ? `<div class="loss-line">${txt}</div>` : `<div class="res-loss-banner">⚠ LOSES RESISTANCE: ${txt}</div>`;
  };
  // the same for an item that costs a big part of your damage (e.g. a ring without your minion mods)
  window.dmgLossBanner = function (d, o) {
    if (!d) return '';
    const n = (v) => (v >= 1000 ? Math.round(v).toLocaleString('en') : Math.round(v));
    if (o && o.plain) return `<div class="loss-line"><b>${d.minion ? 'Minion DPS' : 'DPS'} ${n(d.from)} → ${n(d.to)}</b> (−${Math.abs(d.pct)}%: it doesn't have the damage mods your item gives)</div>`;
    return `<div class="res-loss-banner">⚠ LOSES DAMAGE: <b>${d.minion ? 'Minion DPS' : 'DPS'} ${n(d.from)} → ${n(d.to)}</b> <span>(−${Math.abs(d.pct)}%: it doesn't have the damage mods your item gives)</span></div>`;
  };

  // Path of Building's verdict: what the item really does to your build
  //   p: pobverdict.judge() output; opts: { pending, error, compact }
  window.pobBlock = function (p, opts) {
    opts = opts || {};
    if (opts.pending && !p) return '<div class="pob dim"><span class="pob-tag">PoB</span> <span class="spinner"></span> Checking with Path of Building…</div>';
    if (!p) return opts.error ? `<div class="pob dim"><span class="pob-tag">PoB</span> ${esc(opts.error)}</div>` : '';
    const n = (v) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en') : Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10);
    const sgn = (v) => (v > 0 ? '+' : v < 0 ? '−' : '±');
    const pc = (v) => (v == null ? '' : `<b class="${v > 0.05 ? 'pos' : v < -0.05 ? 'neg' : 'dim'}">${sgn(v)}${Math.abs(Math.round(v * 10) / 10)}%</b>`);
    const dl = (label, d) => (d ? `<span class="cc ${d.delta > 0 ? 'pos' : 'neg'}">${label} ${n(d.from)} → <b>${n(d.to)}</b></span>` : '');
    const dmgName = `<span title="${esc(p.skill === 'Full DPS' ? 'Path of Building\'s Full DPS: every skill ticked to count in it' : p.skill ? `Judged on your main skill in Path of Building: ${p.skill}` : 'Your main skill in Path of Building')}">${p.dpsKey === 'MinionDPS' ? 'Minion DPS' : 'DPS'}${p.skill && p.skill !== 'Full DPS' ? ` <span class="dim">(${esc(p.skill)})</span>` : ''}</span>`;
    // only what changes: no "±0%" (a flask, say, changes neither), and a resistance loss already said above isn't said again
    const moved = (v) => v != null && Math.abs(v) >= 0.05;
    const bits = [
      p.noDamage ? '<span class="dim" title="Your main skill in Path of Building deals no damage. Set your damage skill as the main skill in PoB and import again.">no damage to compare</span>' : moved(p.dps && p.dps.pct) ? `${dmgName} ${pc(p.dps.pct)}` : '',
      moved(p.ehp && p.ehp.pct) ? `Effective HP ${pc(p.ehp.pct)}` : '',
      p.resFirst && p.resGain && !(opts.lossShown && p.resGain < 0) ? `<span title="Resistance points toward your cap (Priorities: cap resistances first)"><b class="${p.resGain > 0 ? 'pos' : 'neg'}">${p.resGain > 0 ? '+' : '−'}${Math.abs(p.resGain)}</b> res to cap</span>` : '',
    ].filter(Boolean);
    const head = bits.length ? `<span class="pob-tag" title="Calculated by Path of Building with your build">PoB</span>
      <span class="pob-main">${bits.join(' · ')}</span>` : opts.flask ? '' : `<span class="pob-tag" title="Calculated by Path of Building with your build">PoB</span> <span class="dim">No change to damage or effective HP</span>`;
    const res = (p.res || []).filter((r) => r.capped !== r.wasCapped || !r.capped || Math.round(r.from) !== Math.round(r.to))
      .filter((r) => !(opts.lossShown && ((r.wasCapped && !r.capped) || (p.resLoss || []).some((x) => x.el === r.el)))) // said in the loss line
      .map((r) => {
      const bad = r.wasCapped && !r.capped; const good = !r.wasCapped && r.capped;
      return `<span class="cc ${bad || (!r.capped && r.to < r.from) ? 'neg warn' : good || r.to > r.from ? 'pos' : 'dim'}">${esc(r.el)} res ${Math.round(r.from)}% → <b>${Math.round(r.to)}%</b>${bad ? ' ⚠ off the cap' : good ? ' ✓ capped' : !r.capped ? ' (under cap)' : ''}</span>`;
    }).join('');
    const hitLabel = p.dpsKey === 'MinionDPS' ? 'Minion hit' : 'Hit';
    const hit = p.hit && !p.noDamage && Math.abs(p.hit.delta) / Math.max(1, p.hit.from) >= 0.005
      ? `<span class="cc ${p.hit.delta > 0 ? 'pos' : 'neg'}" title="Average damage per hit of your main skill (Path of Building's Average Hit)">${hitLabel} ${n(p.hit.from)} → <b>${n(p.hit.to)}</b></span>` : '';
    // movement speed: every point is felt, a loss is flagged (Priorities: keep my movement speed)
    const spd = p.speed ? `<span class="cc ${p.speed.delta > 0 ? 'pos' : 'neg'}${p.speed.delta <= -3 ? ' warn' : ''}" title="Movement speed with this item, from Path of Building (base speed = 0%)">Speed ${p.speed.from}% → <b>${p.speed.to}%</b></span>` : '';
    const parts = [spd, hit, dl('ES', p.es), dl('Life', p.life), dl(p.game === 'poe1' ? 'Ward' : 'Runic Ward', p.ward), dl('Spirit', p.spirit), dl('Mana', p.mana), res].filter(Boolean);
    // resistance losses get their own banner, above everything else
    const lossBanner = opts.noBanner ? '' : window.resLossBanner(p.resLoss) + window.dmgLossBanner(p.dmgLoss);
    const capLine = p.resCapped && p.resCapped.length ? `<div class="res-cap">✓ Caps your ${esc(p.resCapped.join(' and ').toLowerCase())} resistance</div>` : '';
    const other = (p.breaks || []).filter((b) => !/res (drops off|goes further under)|^(Minion damage|Damage) drops/.test(b));
    const risk = other.length ? `<div class="risks">⚠ ${other.map(esc).join(' · ')}</div>` : '';
    return `${lossBanner}${capLine}${head ? `<div class="pob">${head}</div>` : ''}${risk}${parts.length ? `<div class="charch">${opts.compact ? parts.slice(0, 5).join('') : parts.join('')}</div>` : ''}`;
  };

  // Gear score block: "78 A · for your build · yours 56 (+22)" + why? details
  window.gearBlock = function (g, yours, idSuffix) {
    if (!g) return '';
    if (g.unique) return '<div class="gear dim">Gear score: uniques aren\'t rated (their mods are fixed).</div>';
    const diff = yours != null ? g.score - yours : null;
    const cmp = diff == null ? '' : ` · yours ${yours} <b class="${diff > 0 ? 'pos' : diff < 0 ? 'neg' : ''}">(${diff > 0 ? '+' : ''}${diff})</b>`;
    const contrib = (g.contributions || []).slice(0, 8).map((c) => `<div class="gc"><span>${esc(c.label)}${c.source === 'socket' ? ' (rune)' : ''}</span><span class="dim">${c.quality}% roll</span><b>+${c.points}</b></div>`).join('');
    const detail = `<div class="dim gs-one">How good this item is for your build in this slot (100 = about the best it can roll). Points per stat:</div>${contrib}${g.missing && g.missing.length ? `<div class="note">Missing: ${esc(g.missing.join(', '))}</div>` : ''}${g.wasted && g.wasted.length ? `<div class="dim">Not useful to your build: ${esc(g.wasted.join(', '))}</div>` : ''}${g.resNote ? `<div class="dim">${esc(g.resNote)}</div>` : ''}`;
    return `<div class="gear"><span class="gs g-${esc(g.grade)}" title="${esc(g.buildName || '')}">${g.score} ${esc(g.grade)}</span>
      <span>Gear score${cmp}</span> <button class="link gear-why" data-why="${idSuffix || 'x'}">why?</button></div>
      <div class="gear-detail hidden" data-whybox="${idSuffix || 'x'}">${detail}</div>`;
  };
  // The plain-language explanation of the gear score, shown in the results window,
  // the popup's "why?" and on the Build & stats page.
  window.gearExplainHtml = function (opts) {
    opts = opts || {};
    // PoE1 has no gear score: Path of Building's verdict is all there is
    if (opts.game === 'poe1') {
      return `<div class="gs-explain">
      <p><b>Path of Exile 1 items are judged by Path of Building</b> with your build: your passive tree, skill gems and Configuration.</p>
      <ul>
        <li><b>pts</b> is Path of Building's score: the % change to your damage and effective HP (weighted as set on Build &amp; stats), plus half a point per resistance point toward your cap.</li>
        <li><span class="vchip up">UPGRADE</span> clearly better · <span class="vchip up">SMALL UPGRADE</span> a little better · <span class="vchip same">SIDEGRADE</span> about the same · <span class="vchip down">DOWNGRADE</span> worse ·
          <span class="vchip risky">UPGRADE, BUT…</span> better, but it costs reservation, links or a resistance below the cap ·
          <span class="vchip down">LOSES RESISTANCE</span> a resistance drops off the cap · <span class="vchip down">LOSES DAMAGE</span> your damage drops. Both go to the bottom of the results.</li>
        <li>Rings are compared with your weakest ring, jewels in each of your sockets, flasks in your flask slots. Cluster and timeless jewels aren't judged yet.</li>
        ${opts.pobOn ? '' : '<li><b>No build loaded:</b> paste your Path of Building Community export on My gear, or items get no verdict.</li>'}
      </ul></div>`;
    }
    return `<div class="gs-explain">
      ${opts.pobOn ? '<p class="note">Your Path of Building build is loaded, so <b>verdicts come from Path of Building</b> (the change to your damage, effective HP and resistances). The gear score below is a rough guide shown alongside, and is used for anything PoB can\'t check (e.g. jewels).</p>' : ''}
      <p><b>Gear score (0–100)</b> is how good an item is <i>for your build, in that slot</i>. 100 is about the best that slot can roll for you: your build's most important stats there, at top rolls.</p>
      <ul>
        <li><b>How it's worked out:</b> every stat your build cares about counts by how important it is (Build &amp; stats page) × how good the roll is. A 50% roll of an important stat beats a perfect roll of a minor one.</li>
        <li><b>What doesn't count:</b> stats your build doesn't use, stats you've ignored, and resistance past your cap. Rune bonuses count half, because you can swap runes. Conditional mods (<i>"…if you've Hit Recently"</i>) count a bit less.</li>
        <li><b>Grades:</b> <span class="gs g-S">S</span> 85+ <span class="gs g-A">A</span> 70+ <span class="gs g-B">B</span> 55+ <span class="gs g-C">C</span> 40+ <span class="gs g-D">D</span> below. Uniques aren't rated.</li>
        <li><b>The verdict</b> compares it with what you wear in that slot (for rings, charms and jewels, your weakest one):
          <span class="vchip up">UPGRADE</span> +6 or more ·
          <span class="vchip up">SMALL UPGRADE</span> +3 to +5 ·
          <span class="vchip same">SIDEGRADE</span> within 2 ·
          <span class="vchip down">DOWNGRADE</span> −3 or worse ·
          <span class="vchip risky">UPGRADE, BUT…</span> better, but it costs Spirit or reservation, links, a resistance below the cap, or minion levels ·
          <span class="vchip down">LOSES RESISTANCE</span> a resistance drops off the cap, or further under it ·
          <span class="vchip down">LOSES DAMAGE</span> your damage drops (when <i>Never lose damage</i> is on); both go to the bottom of the results.</li>
        ${opts.pobOn
    ? `<li><b>The verdicts use your whole build.</b> Path of Building knows your passive tree, skill gems and Configuration, so the verdict and the PoB line under each listing show the real change to your damage, effective HP and resistances${opts.where ? `. The gear score is tuned on the ${opts.where}` : ''}.</li>`
    : `<li><b>It isn't a damage calculator.</b> It doesn't know your passive tree or skill gems. Check <b>If you equip it</b> under each listing for what changes on your character${opts.where ? `, and tune what each stat is worth on the ${opts.where}` : ''}. Add your Path of Building build on My gear for exact verdicts.</li>`}
      </ul></div>`;
  };

  // "Why this score?": points per stat for this item next to yours, so a +9 is easy to read.
  window.gearCompareHtml = function (g, ge) {
    if (!g) return '';
    const mine = new Map(); const theirs = new Map();
    const roll = new Map();
    for (const c of g.contributions || []) { mine.set(c.label, (mine.get(c.label) || 0) + c.points); roll.set(c.label, Math.max(roll.get(c.label) || 0, c.quality || 0)); }
    for (const c of (ge && ge.contributions) || []) theirs.set(c.label, (theirs.get(c.label) || 0) + c.points);
    const labels = [...new Set([...mine.keys(), ...theirs.keys()])]
      .map((l) => ({ l, a: mine.get(l) || 0, b: theirs.get(l) || 0 }))
      .sort((x, y) => Math.abs(y.a - y.b) - Math.abs(x.a - x.b) || y.a - x.a).slice(0, 10);
    const r1 = (v) => Math.round(v * 10) / 10;
    const rows = labels.map(({ l, a, b }) => {
      const d = r1(a - b);
      return `<tr><td>${esc(l)}${roll.get(l) ? ` <span class="dim">${roll.get(l)}% roll</span>` : ''}</td><td class="r">${r1(a) || '–'}</td>${ge ? `<td class="r dim">${r1(b) || '–'}</td><td class="r ${d > 0 ? 'pos' : d < 0 ? 'neg' : 'dim'}">${d > 0 ? '+' : ''}${d || '0'}</td>` : ''}</tr>`;
    }).join('');
    const scale = g.ideal ? ` Points are out of ${Math.round(g.ideal)} for a perfect item here, then scaled to 100.` : '';
    return `<div class="dim gs-one">How good this item is for your build in this slot (0–100).${scale}</div>
      <table class="gs-table"><tr><th>Stat</th><th class="r">This</th>${ge ? '<th class="r">Yours</th><th class="r">±</th>' : ''}</tr>${rows || '<tr><td class="dim" colspan="4">None of its stats count for your build in this slot.</td></tr>'}</table>
      ${g.missing && g.missing.length ? `<div class="note">Missing: ${esc(g.missing.join(', '))}</div>` : ''}
      ${g.wasted && g.wasted.length ? `<div class="dim">Not useful to your build: ${esc(g.wasted.join(', '))}</div>` : ''}
      ${g.resNote ? `<div class="dim">${esc(g.resNote)}</div>` : ''}
      <button class="link gs-help">What is the gear score?</button>`;
  };

  window.bindGearWhy = function (root) {
    root.querySelectorAll('.gs-help').forEach((b) => b.addEventListener('click', () => {
      if (window.showGearHelp) window.showGearHelp(); else if (window.api.openSettingsTab) window.api.openSettingsTab('build');
    }));
    root.querySelectorAll('.gear-why').forEach((b) => b.addEventListener('click', () => {
      const box = root.querySelector(`[data-whybox="${b.dataset.why}"]`);
      if (box) box.classList.toggle('hidden');
      if (window.__popupResize) window.__popupResize();
    }));
  };

  // Price with the other unit alongside: "180 ex (0.26 div)" / "3 div (2,089 ex)"
  window.dualPrice = function (amount, currency, divineRate) {
    const a = Number(amount);
    if (!divineRate || !Number.isFinite(a)) return '';
    if (currency === 'divine') return `${Math.round(a * divineRate).toLocaleString()} ex`;
    if (currency === 'exalted') return `${Math.round((a / divineRate) * 100) / 100} div`;
    return '';
  };

  // the number in carved type, the words after it in plain text ("+26.8%" + "for your build")
  const POB_TIP = "Path of Building's score for this item: the % change to your damage and effective HP (weighted as set on Build &amp; stats), plus half a point per resistance point toward your cap";
  window.POB_SCORE_TIP = POB_TIP;
  function scoreHtml(label) {
    if (!label) return '';
    const m = String(label).match(/^([+\-−]?[\d.,]+%?)\s*(.*)$/);
    const tip = / pts /.test(label) ? ` title="${POB_TIP}"` : '';
    return m ? `<span class="score"${tip}>${esc(m[1])}${m[2] ? ` <small>${esc(m[2])}</small>` : ''}</span>` : `<span class="score"${tip}>${esc(label)}</span>`;
  }

  function pointsLabel(r) {
    // a loss verdict with a positive score would read like an upgrade: the banner says what it costs
    if (r.scoreMode === 'pob') return r.delta == null || ((r.verdict === 'dmgloss' || r.verdict === 'resloss') && r.delta > 0) ? '' : `${r.delta > 0 ? '+' : ''}${r.delta} pts for your build`;
    if (r.scoreMode === 'gear') {
      if (r.delta == null) return '';
      return `${r.delta > 0 ? '+' : ''}${r.delta} gear score`;
    }
    if (r.delta == null || r.verdict === 'unjudged') return '';
    const pct = r.pct == null ? '' : ` (${fmt(r.pct)}%)`;
    return `${fmt(r.delta)}${pct}`;
  }

  // a poe.ninja price: "≈ 0.8 div (120 ex)", or just ex/chaos below a divine
  const nf = (v) => (v == null ? '' : Number(v).toLocaleString('en', { maximumFractionDigits: v >= 100 ? 0 : v >= 10 ? 1 : 2 }));
  function ninjaPrice(p, total) {
    if (!p) return '';
    const v = total ? p.total : p.each; const d = total ? p.totalDiv : p.eachDiv;
    const c = total ? p.totalChaos : p.eachChaos; const ch = c != null && c > 0 ? `${nf(c)} chaos` : '';
    if (d != null && d >= 1) return `≈ <b>${nf(d)} div</b>${v != null || ch ? ` <span class="dim">(${[v != null ? `${nf(v)} ${esc(p.unit)}` : '', ch].filter(Boolean).join(' · ')})</span>` : ''}`;
    return v != null ? `≈ <b>${nf(v)} ${esc(p.unit)}</b>${(d != null && d >= 0.01) || ch ? ` <span class="dim">(${[d != null && d >= 0.01 ? `${nf(d)} div` : '', ch].filter(Boolean).join(' · ')})</span>` : ''}` : '';
  }
  function trend(p) {
    if (!p || p.change == null) return '';
    const c = p.change; const cls = c > 2 ? 'pos' : c < -2 ? 'neg' : 'unweighted';
    return `<span class="chg ${cls}" title="Change over the last 7 days on poe.ninja">7 days ${c > 0 ? '+' : ''}${nf(c)}%</span>`;
  }
  // the last 7 days on poe.ninja as a small line (relative prices, 1 = today)
  window.sparkHtml = function (p, w, h) {
    const hst = p && Array.isArray(p.history) ? p.history : [];
    const pts = hst.map((v, i) => [i, v]).filter(([, v]) => v != null && Number.isFinite(v));
    if (pts.length < 2) return '';
    w = w || 120; h = h || 28;
    const lo = Math.min(...pts.map(([, v]) => v)); const hi = Math.max(...pts.map(([, v]) => v));
    const span = hi - lo || 1; const n = Math.max(hst.length - 1, 1);
    const xy = pts.map(([i, v]) => `${Math.round((i / n) * (w - 4) + 2)},${Math.round(h - 3 - ((v - lo) / span) * (h - 6))}`).join(' ');
    const up = pts[pts.length - 1][1] >= pts[0][1];
    const unit = (v) => (p.each != null ? `${nf(p.each * v)} ${p.unit}` : `${nf(v * 100)}%`);
    return `<svg class="spark ${up ? 'spark-up' : 'spark-down'}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Price over the last 7 days, from ${esc(unit(pts[0][1]))} to ${esc(unit(1))}"><title>Last 7 days on poe.ninja: ${esc(unit(lo))} to ${esc(unit(hi))}</title><polyline points="${xy}" fill="none" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  };
  window.ninjaLine = function (p, advice) {
    if (!p) return '';
    if (advice) return `<div class="ninja">${ninjaPrice(p)} <span class="adv-inline">· ${esc(advice)}</span> ${trend(p)}${window.sparkHtml(p, 56, 14)}${p.unsure ? ` <span class="dim">price of the ${esc(p.variant || 'most common')} version?</span>` : ''}</div>`;
    return `<div class="ninja"><span class="pob-tag" title="poe.ninja, ${esc(p.league || '')}">NINJA</span> ${ninjaPrice(p)} ${trend(p)}${window.sparkHtml(p, 56, 14)}${p.few ? ' <span class="dim" title="Few listed: the price is a rough guess">few listed</span>' : ''}${p.unsure ? ` <span class="dim" title="This unique comes in several versions and the app can't tell which one this is">price of the ${esc(p.variant || 'most common')} version?</span>` : ''}</div>`;
  };
  const linksHtml = (links) => (links || []).map((l) => `<button class="link info-link" data-url="${esc(l.url)}">${esc(l.label)}</button>`).join('');
  const bindLinks = (el) => el.querySelectorAll('.info-link').forEach((b) => b.addEventListener('click', () => window.api.openUrl(b.dataset.url)));

  // keep / sell / vendor, under the verdict
  const ADV = { keep: ['KEEP', 'up'], sell: ['SELL', 'sell'], vendor: ['VENDOR', 'same'], check: ['PRICE CHECK', 'risky'] };
  // selling helper: a price a little under poe.ninja and a price note to paste into a premium stash tab
  window.sellHtml = function (r) {
    if (!r.sellNote) return '';
    const a = window.keepSell && window.keepSell.advise(r);
    if (a && (a.action === 'vendor' || a.action === 'keep')) return '';
    return `<div class="sell-row"><span class="dim small">List it at</span> <b>${esc(r.sellNote.text)}</b> <button class="link" id="copySell" title="Copies &quot;${esc(r.sellNote.note)}&quot;: right-click the item in a premium stash tab and paste it into the note">Copy price note</button></div>`;
  };
  window.bindSell = function (el, r) {
    const b = el.querySelector('#copySell');
    if (b) b.addEventListener('click', () => { window.api.copyText(r.sellNote.note); b.textContent = 'Copied'; });
  };
  window.adviceHtml = function (r) {
    const a = window.keepSell && window.keepSell.advise(r);
    if (!a) return '<div class="advice" id="advice"></div>';
    const [t, c] = ADV[a.action];
    return `<div class="advice" id="advice"><span class="adv adv-${c}">${t}</span>${a.text ? ` <span class="dim">${esc(a.text)}</span>` : ''}</div>`;
  };
  // something that isn't gear (currency, a gem, a map, a divination card...): what it's worth
  window.renderPriceCard = function (el, r, opts) {
    opts = opts || {};
    const it = r.item || {};
    const p = r.ninja;
    const what = [p && p.gemLevel ? `level ${p.gemLevel}${p.gemQuality ? `, ${p.gemQuality}% quality` : ''}` : '', p && p.links ? `${p.links}-link` : '', p && p.mapTier ? `tier ${p.mapTier}` : '', p && p.variant && !p.gemLevel ? p.variant : ''].filter(Boolean).join(' · ');
    el.innerHTML = `<div class="card price-card">
        <div class="name ${esc((it.rarity || '').toLowerCase())}">${esc(it.name || '')}</div>
        <div class="meta">${esc(it.itemClass || '')}${p && p.stack > 1 ? ` · stack of ${nf(p.stack)}` : ''}</div>
        ${opts.closable ? '<button class="x" id="closeBtn" title="Close">×</button>' : ''}
        ${r.pricePending ? '<div class="note"><span class="spinner"></span> Getting the price from poe.ninja…</div>' : ''}
        ${p ? `<div class="price-big">${ninjaPrice(p)} <span class="dim">each</span></div>
          ${p.stack > 1 ? `<div>Stack: ${ninjaPrice(p, true)}</div>` : ''}
          ${window.sparkHtml(p, 200, 34) ? `<div class="spark-row">${window.sparkHtml(p, 200, 34)}<span class="dim small">last 7 days</span></div>` : ''}
          <div class="dim small">${trend(p)}${what ? ` · priced as ${esc(what)}` : ''}${p.few ? ' · few listed, so a rough guess' : ''}${p.unsure ? ` · several versions: this is the ${esc(p.variant || 'most common')} one's price` : ''} · poe.ninja${p.league ? `, ${esc(p.league)}` : ''}</div>` : ''}
        ${window.gemHtml(r)}
        ${p ? window.adviceHtml(r) : ''}
        ${window.sellHtml(r)}
        ${r.priceNote ? `<div class="note">${esc(r.priceNote)}</div>` : ''}
        ${/tablet/i.test(it.itemClass || '') ? '<div class="actions"><button class="find" id="tradeWorth" title="What tablets like this sell for on the trade site">What\'s it worth?</button></div><div class="note" id="findMsg"></div>' : ''}
        ${r.links && r.links.length ? `<div class="actions">${linksHtml(r.links)}</div>` : ''}
      </div>`;
    bindLinks(el);
    window.bindTradeWorth(el, it, opts);
    window.bindSell(el, r);
    const c = el.querySelector('#closeBtn');
    if (c) c.addEventListener('click', () => window.api.close());
  };
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m === 1 ? '1 min ago' : `${m} min ago`; };
  // "What's it worth?" on a waystone, map or tablet card: the trade site's price
  window.bindTradeWorth = function (el, it, opts) {
    const b = el.querySelector('#tradeWorth');
    if (!b) return;
    b.addEventListener('click', async () => {
      const msg = el.querySelector('#findMsg');
      b.disabled = true; msg.innerHTML = '<span class="spinner"></span> Checking prices…';
      if (opts && opts.onResize) opts.onResize();
      const res = await window.api.priceCheck(it.id ? { itemId: it.id } : '__last');
      b.disabled = false;
      window.showSearchResult(msg, res);
      if (opts && opts.onResize) opts.onResize();
    });
  };
  // how far to trust a price: a small chip, the reason in its tooltip
  const CONF = { solid: ['solid price', 'conf-solid'], rough: ['rough price', 'conf-rough'], guess: ['a guess', 'conf-guess'] };
  window.confHtml = function (c) {
    if (!c || !CONF[c.grade]) return '';
    const [t, cls] = CONF[c.grade];
    return ` <span class="conf ${cls}" title="${esc(c.grade === 'solid' ? 'Plenty of recent listings close to this item, at similar prices' : `Treat it as ${c.grade === 'rough' ? 'a rough figure' : 'a guess'}: ${c.why}`)}">${t}</span>`;
  };
  // the price hotkey (F3): the item's name and its price, nothing else
  window.renderQuickPrice = function (el, r, opts) {
    opts = opts || {};
    const it = r.item || {};
    const p = r.ninja; const t = r.trade;
    const base = it.baseType && it.baseType !== it.name ? it.baseType : it.itemClass || '';
    let body;
    if (r.pending) body = '<div class="dim"><span class="spinner"></span> Checking the price…</div>';
    else if (p) body = `<div class="price-answer"><b>${ninjaPrice(p)}</b></div><div class="dim small">${p.stack > 1 ? `stack: ${ninjaPrice(p, true)} · ` : ''}poe.ninja${p.league ? `, ${esc(p.league)}` : ''}</div>`;
    else if (t) body = `<div class="price-answer">≈ <b>${esc(t.typical)}</b>${window.confHtml(t.confidence)}</div><div class="dim small">${t.range ? `most ${esc(t.range)} · ` : ''}${esc(t.sellers || t.total)} seller${(t.sellers || t.total) === 1 ? '' : 's'} · ${esc(r.source || 'trade site')}${r.checkedAt ? ` · checked ${esc(ago(r.checkedAt))} <button class="link" id="qpRefresh">refresh</button>` : ''}</div>`;
    else body = `<div class="dim">${esc(r.error || 'No price found.')}</div>`;
    el.innerHTML = `<div class="card price-card quick-price">
        <div class="name ${esc((it.rarity || '').toLowerCase())}">${esc(it.name || '')}</div>
        ${base ? `<div class="meta">${esc(base)}</div>` : ''}
        ${opts.closable ? '<button class="x" id="closeBtn" title="Close">×</button>' : ''}
        ${body}
      </div>`;
    const c = el.querySelector('#closeBtn');
    if (c) c.addEventListener('click', () => window.api.close());
    const rf = el.querySelector('#qpRefresh');
    if (rf) rf.addEventListener('click', () => { rf.disabled = true; window.api.quickPriceRefresh(); });
  };
  // a gem: what the same gem in your build would do at this level and quality
  const pct = (v) => (v == null || Math.abs(v) < 0.05 ? null : `${v > 0 ? '+' : ''}${v}%`);
  const gemLq = (l, q) => `level ${l}${q ? ` / ${q}% quality` : ''}`;
  window.gemHtml = function (r) {
    if (r.gemPending) return '<div class="note"><span class="spinner"></span> Trying this gem in your build with Path of Building…</div>';
    if (r.gemError) return `<div class="note">Couldn't try this gem in your build (${esc(r.gemError)}).</div>`;
    if (!r.gem) return '';
    if (!r.gem.hits.length) return '<div class="dim small gem-check">This gem isn\'t in your Path of Building build (or it\'s switched off there).</div>';
    return `<div class="gem-check">${r.gem.hits.map((h) => {
      const same = h.level === h.newLevel && h.quality === h.newQuality;
      const ch = [pct(h.dps) && `DPS ${pct(h.dps)}`, pct(h.ehp) && `effective HP ${pct(h.ehp)}`].filter(Boolean).join(', ');
      const [t, c] = same ? ['SAME AS YOURS', 'same'] : h.verdict === 'upgrade' || h.verdict === 'small' ? ['UPGRADE', 'up'] : h.verdict === 'same' ? ['NO CHANGE', 'same'] : ['WORSE', 'down'];
      return `<div class="verdict ${c}"><span class="badge">${t}</span><span class="dim">in ${esc(h.group)}: yours is ${gemLq(h.level, h.quality)}${same ? '' : `, this one ${gemLq(h.newLevel, h.newQuality)}`}${ch && !same ? ` · ${esc(ch)}` : ''}</span></div>`;
    }).join('')}</div>`;
  };

  // a map or waystone: each mod and what it means for your build; click a mod to mark it
  const MAPV = { danger: ['DANGER', 'down'], warn: ['CAREFUL', 'risky'], ok: ['LOOKS FINE', 'up'] };
  const MAPICON = { danger: '☠', warn: '⚠', ok: '✓', info: '·' };
  const NEXT = { '': 'd', d: 'w', w: 'g', g: '' };
  window.renderMapCard = function (el, r, opts) {
    opts = opts || {};
    const it = r.item || {};
    const c = r.check || { rows: [] };
    // without a build only your own marks can say anything: no "looks fine" for mods nobody checked
    const [vt, vc] = r.noBuild && c.verdict === 'ok' && !(c.rows || []).some((m) => m.mark) ? ['NOT CHECKED', 'same'] : MAPV[c.verdict] || MAPV.ok;
    const tier = (it.lines || []).map((l) => l.text || '').find((t) => /^(Map|Waystone) Tier:/i.test(t));
    el.innerHTML = `<div class="card map-card">
        <div class="name ${esc((it.rarity || '').toLowerCase())}">${esc(it.name || '')}</div>
        <div class="meta">${esc(it.baseType && it.baseType !== it.name ? it.baseType + ' · ' : '')}${esc(tier || it.itemClass || '')}</div>
        ${opts.closable ? '<button class="x" id="closeBtn" title="Close">×</button>' : ''}
        <div class="verdict ${vc}"><span class="badge">${vt}</span>${c.all ? `<span class="dim">for your build: ${esc(c.all.text)}</span>` : ''}</div>
        ${r.pending ? '<div class="note"><span class="spinner"></span> Checking the mods with Path of Building…</div>' : ''}
        ${r.noBuild ? '<div class="dim small">Load your Path of Building build on My gear and each mod is worked out for your character.</div>' : ''}
        ${r.pobError ? `<div class="note">${esc(r.pobError)}</div>` : ''}
        ${c.summary && (c.summary.adds || c.summary.text) ? `<div class="small">${c.summary.adds ? `Adds <b>${esc(c.summary.adds)}</b>` : ''}${c.summary.adds && c.summary.text ? ': ' : ''}${c.summary.text ? `mods ${esc(c.summary.text)}` : ''}</div>` : ''}
        ${c.uses != null || (c.reward && c.reward.length) ? `<div class="dim small">${[c.uses != null ? `${c.uses} use${c.uses === 1 ? '' : 's'} left` : '', ...(c.reward || [])].filter(Boolean).map(esc).join(' · ')}</div>` : ''}
        <div class="map-mods">${(c.groups && c.groups.length > 1 ? c.groups : [{ rows: c.rows }]).map((g) => `${g.label ? `<div class="map-group">${esc(g.label)}</div>` : ''}${g.rows.map((m) => `<div class="map-mod lv-${esc(m.level)}" data-key="${esc(m.key)}" data-mark="${esc(m.mark || '')}" title="Click to mark this mod: dangerous → careful → fine → no mark">
            <span class="mi">${MAPICON[m.level] || '·'}</span><span class="mt">${esc(m.text)}${m.mark ? ' <small class="dim">(your mark)</small>' : ''}${m.note ? `<br><small class="${m.level === 'ok' ? 'dim' : ''}">${esc(m.note)}</small>` : ''}</span></div>`).join('')}`).join('') || '<div class="dim">No mods.</div>'}</div>
        ${c.extraLife ? `<div class="dim small">Monsters have about ${Math.round(c.extraLife)}% more life here: they take that much longer to kill.</div>` : ''}
        ${r.ninja ? window.ninjaLine(r.ninja) : ''}
        <div class="dim small">${c.calculated ? `${c.calculated} mod${c.calculated === 1 ? '' : 's'} worked out by Path of Building; ` : ''}click a mod to mark it dangerous, careful or fine for all your ${r.game === 'poe1' ? 'maps' : 'waystones and tablets'}.</div>
        <div class="actions"><button class="find" id="tradeWorth" title="What ${r.game === 'poe1' ? 'maps' : 'waystones'} like this sell for on the trade site">What's it worth?</button></div>
        <div class="note" id="findMsg"></div>
        <div class="sell-row"><button class="link" id="avoidBtn" title="Copies a search for the map device or stash that leaves out ${r.game === 'poe1' ? 'maps' : 'waystones'} with your dangerous mods">Copy a search that avoids dangerous mods</button><span class="dim small" id="avoidOut"></span></div>
        ${r.links && r.links.length ? `<div class="actions">${linksHtml(r.links)}</div>` : ''}
      </div>`;
    bindLinks(el);
    window.bindTradeWorth(el, it, opts);
    el.querySelectorAll('.map-mod').forEach((m) => m.addEventListener('click', () => window.api.mapMark(m.dataset.key, NEXT[m.dataset.mark || ''])));
    const av = el.querySelector('#avoidBtn');
    if (av) av.addEventListener('click', async () => {
      const res = await window.api.mapAvoid(c.rows.filter((m) => m.level === 'danger').map((m) => m.key));
      const out = el.querySelector('#avoidOut');
      out.textContent = res.text ? `Copied ${res.text}${res.left.length ? ` (${res.left.length} more didn't fit in the game's 50 letters)` : ''}. Paste it in the search box and check it highlights what you expect.` : 'Mark a mod as dangerous first (click it).';
      if (opts.onResize) opts.onResize();
    });
    const x = el.querySelector('#closeBtn');
    if (x) x.addEventListener('click', () => window.api.close());
  };

  // Popup / test view. Compact by default: item, verdict, gear score, top
  // changes and two buttons; "More" shows everything else.
  window.renderComparison = function (el, r, opts) {
    opts = opts || {};
    const ui = (r && r.ui) || {};
    document.body.classList.toggle('cb', !!ui.colorblind);
    if (r && r.kind === 'price') return window.renderPriceCard(el, r, opts);
    if (r && r.kind === 'quickprice') return window.renderQuickPrice(el, r, opts);
    if (r && r.kind === 'map' && window.renderMapCard) return window.renderMapCard(el, r, opts);
    if (!r || !r.ok) {
      el.innerHTML = `<div class="card ${r && r.loading ? 'loading' : ''}">${opts.closable ? '<button class="x" id="closeBtn" title="Close">×</button>' : ''}
        <div class="note">${r && r.loading ? '<span class="spinner"></span> ' : ''}${esc((r && r.reason) || 'Nothing to show.')}</div></div>`;
      const c0 = el.querySelector('#closeBtn');
      if (c0) c0.addEventListener('click', () => window.api.close());
      return;
    }
    const it = r.item;
    const unique = /unique/i.test(it.rarity || '');
    const checking = !!(r.pobPending && !r.pob && !r.isEquipped);
    const v = checking ? { text: 'CHECKING…', cls: 'same checking' } : VERDICT[r.verdict] || VERDICT.same;
    const rarity = (it.rarity || '').toLowerCase();
    const full = opts.expanded || ui.detail === 'full';
    const gearMode = r.scoreMode === 'gear' || r.scoreMode === 'pob';
    // jewels judged by PoB: the search is for your tree's sockets, starting from this jewel
    const target = it.slot === 'Jewel' && r.pob && r.pob.socket && it.id ? { itemId: it.id } : ['Ring', 'Charm', 'Jewel'].includes(it.slot) ? it.slot : r.targetSlot;
    const budget = r.budgetLabel ? ' ' + r.budgetLabel.replace(/ \(.*\)$/, '') : '';

    const rowCls = (row) => {
      const useful = gearMode ? row.useful > 0 : row.weight !== 0;
      if (!useful) return 'unweighted';
      return row.diff > 0 ? 'pos' : 'neg';
    };
    const top = r.rows.filter((row) => (gearMode ? row.useful > 0 : row.weight)).slice(0, 4)
      .map((row) => `<span class="chg ${rowCls(row)}">${esc(label(row.key, row.diff))}</span>`).join('');

    const rows = r.rows.map((row) => `<tr class="${rowCls(row)}">
        <td class="stat" title="${esc(row.key)}">${esc(label(row.key, row.diff))}
          <span class="fromto">${esc(fmt(row.oldValue).replace('+', ''))} → ${esc(fmt(row.newValue).replace('+', ''))}</span></td>
        ${gearMode ? '' : `<td class="w"><input class="weight" type="number" step="0.1" value="${row.weight || ''}" placeholder="0" data-key="${esc(row.key)}" title="Weight for this stat"></td>
        <td class="imp">${row.weight ? esc(fmt(row.impact)) : ''}</td>`}
        <td class="ig"><button class="ignore" data-key="${esc(row.key)}" title="Ignore this stat (hide it from the score and from searches)">⊘</button></td>
      </tr>`).join('');

    const g = r.gear;
    const yours = r.gearEquipped && r.gearEquipped.score != null ? r.gearEquipped.score : null;
    const gearChip = g && g.score != null ? `<span class="gs g-${esc(g.grade)}" title="Gear score for ${esc(g.buildName || 'your build')}">${g.score} ${esc(g.grade)}</span>` : '';
    const gearLine = !g || r.pob || checking ? '' : g.unrated === 'unidentified' ? '<div class="dim">Unidentified – identify it to see its gear score.</div>'
      : g.unique ? '' : `<div class="gear">${gearChip}<span>gear score${yours != null ? ` · yours ${yours}` : ''}</span> <button class="link gear-why" data-why="p">why?</button></div>
        <div class="gear-detail hidden" data-whybox="p">${window.gearCompareHtml(g, r.isEquipped ? null : r.gearEquipped)}</div>`;

    const emptySlot = !r.replacing.length && !r.isEquipped && it.slot !== 'Flask';
    const craft = it.affixes && it.affixes.known && !unique ? `<div class="craft">${it.affixes.openPrefix || it.affixes.openSuffix
      ? `Open: <b>${it.affixes.openPrefix}</b> prefix${it.affixes.openPrefix === 1 ? '' : 'es'}, <b>${it.affixes.openSuffix}</b> suffix${it.affixes.openSuffix === 1 ? '' : 'es'} – craftable`
      : 'All 6 affixes taken'}</div>` : '';

    const flask = it.slot === 'Flask'; // PoE1 flasks: no slot of their own in the app
    const primary = unique
      ? `<button class="find" id="priceFind">What's it worth?</button><button id="likeFind" title="This unique on the trade site, cheapest first">Find cheaper copies</button>`
      : `${r.replacing.length && !flask ? `<button class="find" id="quickFind" title="Listings that score higher for your build than your equipped ${esc(r.targetSlot)}">Find upgrades${esc(budget)}</button>`
        : `<button class="find" id="likeFind" title="Listings with this item's stats">Find items like this${esc(budget)}</button>`}
         <button id="priceFind" title="What similar items sell for">What's it worth?</button>
         <button class="link" id="pricePick" title="Choose which stats the price check matches, and their minimums">Price by chosen stats…</button>`;

    const lossRows = r.isEquipped ? [] : r.pob ? (r.pob.resLoss || []) : ((r.character && r.character.res) || []).filter((x) => x.from != null && x.delta < 0 && x.under && (x.el !== 'chaos' || !x.wasUnder));
    const dmgLoss = !r.isEquipped && r.pob ? r.pob.dmgLoss : null;
    const named = ['resloss', 'dmgloss'].includes(r.verdict);
    const lossBanner = window.resLossBanner(lossRows, { plain: named }) + window.dmgLossBanner(dmgLoss, { plain: named });
    // keep / sell / vendor next to the price when there is one; KEEP needs no words under an upgrade
    const adv = window.keepSell && window.keepSell.advise(r);
    const advWord = adv && r.ninja && (adv.action === 'sell' || adv.action === 'vendor') ? (adv.action === 'sell' ? 'worth selling' : 'not worth selling') : null;
    const adviceBlock = advWord || (adv && adv.action === 'keep' && !adv.text) ? '' : window.adviceHtml(r);
    el.innerHTML = `
      <div class="card ${lossRows.length || dmgLoss ? 'res-loss' : ''}">
        <div class="name ${esc(rarity)}">${esc(it.name || '')}</div>
        <div class="meta">${it.baseType && it.baseType !== it.name ? `${esc(it.baseType)} · ` : ''}${esc(it.itemClass || '')}${it.itemLevel ? ` · ilvl ${it.itemLevel}` : ''}</div>
        ${opts.closable ? '<button class="x" id="closeBtn" title="Close">×</button>' : ''}
        ${unique && !r.pob ? `<div class="verdict same"><span class="badge">UNIQUE</span>${r.replacing.length && !r.isEquipped ? `<span class="dim">vs ${esc(r.replacing.join(' + '))}</span>` : ''}</div>
          <div class="dim">${r.pobPending ? 'Checking with Path of Building…' : r.game === 'poe1' ? 'Load your Path of Building Community build on My gear to see what it does for your build – or check its price.' : "Uniques have fixed mods, so there's no gear score – check its price, or compare the changes below."}</div>`
          : `<div class="verdict ${v.cls}">
          <span class="badge">${v.text}</span>
          ${r.isEquipped || emptySlot || checking ? '' : scoreHtml(pointsLabel(r))}
          ${r.isEquipped ? '' : r.replacing.length ? `<span class="dim">vs ${esc(r.replacing.join(' + '))}</span>` : r.verdict === 'unjudged' ? '' : it.slot === 'Flask' ? (r.pobPending ? '<span class="dim">trying it in your flask slots</span>' : '') : `<span class="dim">${esc(r.targetSlot)} slot is empty</span>`}
        </div>`}
        ${lossBanner}
        ${r.ninja ? window.ninjaLine(r.ninja, advWord) : ''}
        ${adviceBlock}
        ${window.sellHtml(r)}
        ${gearLine}
        ${craft}
        ${r.flaskNote ? `<div class="dim small">${esc(r.flaskNote)}</div>` : ''}${r.limitNote ? `<div class="dim small">${esc(r.limitNote)}</div>` : ''}
        ${r.isEquipped ? `<div class="note">This is your equipped ${esc(r.targetSlot)}.</div>` : ''}
        ${top && !r.isEquipped ? `<div class="chgs">${top}</div>` : ''}
        ${r.unjudged && !r.pobNudge && !r.pob ? `<div class="note">${esc(r.unjudged)}</div>` : ''}
        ${r.pobNudge && !r.isEquipped ? (r.game === 'poe1'
    ? '<div class="note">PoE1 items are judged by Path of Building: paste your <b>Path of Building Community</b> export on <b>My gear</b> (this character is your PoE1 one).</div>'
    : '<div class="dim small">For exact verdicts, paste your Path of Building export on <b>My gear</b>.</div>') : ''}
        ${r.isEquipped ? '' : r.pob || r.pobPending || r.pobError ? window.pobBlock(r.pob, { pending: r.pobPending, error: r.pobError, compact: !full, noBanner: true, lossShown: true, flask: it.slot === 'Flask' }) : window.characterBlock(r.character, { compact: !full, risks: r.risks, noBanner: true })}
        ${r.notes.filter((n) => !/^Nothing saved/.test(n) || (!emptySlot && it.slot !== 'Flask')).filter((n) => full || /unidentified|two-handed|Two-handed/i.test(n)).map((n) => `<div class="note">${esc(n)}</div>`).join('')}
        ${emptySlot ? `<div class="actions">${equipButtons(r)}</div>` : ''}
        <div class="actions main-actions">${primary}</div>
        ${r.league ? `<div class="dim small league-line">League: <b>${esc(r.league)}</b> · <button class="link" id="leagueChange" title="Searches and prices use this league (each game has its own)">change</button></div>` : ''}
        <div class="price-pick hidden" id="pricePickBox"></div>
        <div class="note" id="findMsg"></div>
        <button class="link more" id="moreBtn">${full ? 'Less ▴' : 'More ▾'}</button>
        <div class="more-box ${full ? '' : 'hidden'}" id="moreBox">
          ${r.ignoring && r.ignoring.length ? `<div class="dim">Ignoring: ${esc(r.ignoring.join(', '))} <button class="link" id="ignoreChange">change</button></div>` : ''}
          ${!full ? r.notes.filter((n) => !/unidentified|two-handed/i.test(n) && !(it.slot === 'Flask' && /^Nothing saved/.test(n))).map((n) => `<div class="note">${esc(n)}</div>`).join('') : ''}
          ${(it.lines || []).some((l) => l.tier != null) ? `<div class="mods-tiers"><div class="dim small">Mods and tiers</div>${window.modsHtml(it.lines)}</div>` : ''}
          ${r.isEquipped ? '' : rows ? `<table class="rows"><thead><tr><th>Change</th>${gearMode ? '' : '<th>Weight</th><th>Score</th>'}<th></th></tr></thead><tbody>${rows}</tbody></table>`
            : '<div class="note">No stat differences.</div>'}
          ${r.isEquipped || emptySlot || it.slot === 'Flask' ? '' : `<div class="actions">${equipButtons(r)}</div>`}
          <div class="more-searches"><span class="dim small">More searches:</span>
            ${r.replacing.length && !r.isEquipped && !unique ? '<button class="link" id="likeFind2" title="Listings with the stats of the item you just copied">Like this item</button>' : ''}
            ${r.replacing.length && !unique ? `<button class="link" id="sameFind" title="Listings with every stat of your equipped item at your value or higher">As good as my ${esc(r.targetSlot || 'item')}</button>` : ''}
            ${r.replacing.length && !gearMode ? '<button class="link" id="weightFind" title="Listings that beat your equipped item by your stat weights">By my weights</button>' : ''}
            ${!unique && it.slot ? '<button class="link" id="craftFind" title="Bases with your key stats and an open affix to craft">Craftable bases</button>' : ''}
            <button class="link" id="customFind" title="Pick which of this item\'s stats to search for">Pick stats…</button>
          </div>
          <div class="actions">
            ${linksHtml(r.links)}
            ${opts.closable ? '<button class="link" id="settingsBtn">Settings</button>' : ''}
          </div>
        </div>
      </div>`;

    const resize = () => opts.onResize && opts.onResize();
    const msgEl = () => el.querySelector('#findMsg');
    const run = (btn, fn, busy) => btn && btn.addEventListener('click', async () => {
      btn.disabled = true; msgEl().innerHTML = `<span class="spinner"></span> ${busy}`;
      resize();
      const res = await fn();
      btn.disabled = false;
      window.showSearchResult(msgEl(), res);
      resize();
    });
    const ref = it.id ? { itemId: it.id } : '__last';
    run(el.querySelector('#quickFind'), () => window.api.quickFind(target, 'upgrade'), 'Searching the trade site…');
    run(el.querySelector('#sameFind'), () => window.api.quickFind(target, 'similar'), 'Searching the trade site…');
    run(el.querySelector('#weightFind'), () => window.api.quickFind(target, 'weights'), 'Searching the trade site…');
    run(el.querySelector('#likeFind'), () => window.api.quickFind(ref, 'similar'), 'Searching the trade site…');
    run(el.querySelector('#likeFind2'), () => window.api.quickFind(ref, 'similar'), 'Searching the trade site…');
    run(el.querySelector('#craftFind'), () => window.api.quickFind(ref, 'craft'), 'Looking for craftable bases…');
    // a price check also answers keep / sell / vendor
    const withWorth = (p) => p.then((res) => {
      if (res && res.ok && res.summary && res.summary.typicalEx != null) { r.worthEx = res.summary.typicalEx; const a = el.querySelector('#advice'); if (a) a.outerHTML = window.adviceHtml(r); }
      return res;
    });
    run(el.querySelector('#priceFind'), () => withWorth(window.api.priceCheck(ref)), 'Checking prices…');
    // "Choose stats…": tick the stats the price check should match, with their minimums
    const pp = el.querySelector('#pricePick');
    if (pp) pp.addEventListener('click', async () => {
      const box = el.querySelector('#pricePickBox');
      if (!box.classList.contains('hidden')) { box.classList.add('hidden'); resize(); return; }
      const f = await window.api.findRows(ref);
      const rows = ((f && f.rows) || []).filter((x) => x.source !== 'base' || /^\[(Base|Weapon)\]/.test(x.key));
      if (!rows.length) { msgEl().textContent = 'No stats to choose from.'; resize(); return; }
      // the trade site's totals: one "total elemental resistance" counts fire, cold, lightning and all-res mods alike
      const ele = { fire: 1, cold: 1, lightning: 1 };
      let resSum = 0; let resRows = 0;
      for (const x of rows) {
        const k = String(x.key); const v = Number(x.value) || 0;
        if (x.source === 'socket' || x.source === 'base') continue;
        if (/^\+?#% to all Elemental Resistances$/i.test(k)) { resSum += 3 * v; resRows++; continue; }
        const m = k.match(/^\+?#% to (Fire|Cold|Lightning)(?: and (Fire|Cold|Lightning))? Resistances?$/i);
        if (m && ele[m[1].toLowerCase()]) { resSum += (m[2] ? 2 : 1) * v; resRows++; x.inTotal = true; }
        if (/all Elemental Resistances/i.test(k)) x.inTotal = true;
      }
      if (resRows >= 2 && resSum > 0) rows.unshift({ key: 'Total elemental resistance', id: 'pseudo.pseudo_total_elemental_resistance', idType: 'pseudo', value: resSum, total: true });
      box.innerHTML = `<div class="dim small">Match these stats (at least the value shown):</div>
        <div class="pp-presets"><span class="dim small">Minimums:</span> <button class="link" data-pct="0.8">80%</button> <button class="link" data-pct="0.9">90%</button> <button class="link" data-pct="1">100%</button></div>
        ${rows.map((x, i) => `<label class="pp-row"><input type="checkbox" data-i="${i}" ${x.source === 'socket' || x.inTotal ? '' : 'checked'}> <span title="${esc(x.key)}">${x.total ? `<b>${esc(x.key)}</b> (%)` : `${esc(statName(x.key))}${/#%/.test(x.key) ? ' (%)' : ''}`}</span>
          <input type="number" class="num pp-min" data-i="${i}" value="${esc(Math.floor(Number(x.value) * 10) / 10)}" step="any"></label>`).join('')}
        <div class="actions"><button class="find" id="pricePickGo">Price with these</button></div>`;
      box.classList.remove('hidden');
      box.querySelectorAll('[data-pct]').forEach((b) => b.addEventListener('click', () => {
        rows.forEach((x, i) => { const inp = box.querySelector(`.pp-min[data-i="${i}"]`); if (inp) inp.value = Math.floor(Number(x.value) * Number(b.dataset.pct) * 10) / 10; });
      }));
      resize();
      run(box.querySelector('#pricePickGo'), () => {
        const picks = rows.map((x, i) => ({ x, on: box.querySelector(`input[type=checkbox][data-i="${i}"]`).checked, min: box.querySelector(`.pp-min[data-i="${i}"]`).value }))
          .filter((p) => p.on).map((p) => ({ key: p.x.key, min: p.min === '' ? null : Number(p.min), source: p.x.source, id: p.x.id, idType: p.x.idType }));
        if (!picks.length) return Promise.resolve({ ok: false, error: 'Tick at least one stat.' });
        return withWorth(window.api.priceCheck(ref, picks));
      }, 'Checking prices…');
    });
    window.__popupResize = opts.onResize || null;
    window.bindGearWhy(el);
    bindLinks(el);
    window.bindSell(el, r);
    const mb = el.querySelector('#moreBtn');
    if (mb) mb.addEventListener('click', () => {
      const box = el.querySelector('#moreBox');
      box.classList.toggle('hidden');
      mb.textContent = box.classList.contains('hidden') ? 'More ▾' : 'Less ▴';
      if (opts.onToggle) opts.onToggle(!box.classList.contains('hidden'));
      resize();
    });
    const cf = el.querySelector('#customFind');
    if (cf) cf.addEventListener('click', () => window.api.findUpgrade(ref));
    const lc = el.querySelector('#leagueChange');
    if (lc) lc.addEventListener('click', () => window.api.openSettingsTab && window.api.openSettingsTab('league'));
    const ic = el.querySelector('#ignoreChange');
    if (ic) ic.addEventListener('click', () => window.api.openSettingsTab && window.api.openSettingsTab('search'));
    el.querySelectorAll('button.ignore').forEach((b) => b.addEventListener('click', async () => {
      const st = await window.api.getState();
      const rules = (st.settings.ignoreStats || []).filter((x) => x.key !== b.dataset.key);
      rules.push({ key: b.dataset.key, mode: 'ignore' });
      await window.api.setIgnore(rules); // the popup re-renders itself
      if (opts.onChange) opts.onChange();
    }));
    el.querySelectorAll('input.weight').forEach((inp) => {
      inp.addEventListener('change', () => window.api.setWeight(inp.dataset.key, inp.value).then(() => opts.onChange && opts.onChange()));
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
    });
    el.querySelectorAll('button.equip').forEach((b) => {
      b.addEventListener('click', async () => {
        await window.api.equip(b.dataset.slot, it.id ? { itemId: it.id } : (opts.itemText || null));
        b.textContent = `Saved as ${b.dataset.slot} ✓`;
        b.disabled = true;
        if (opts.onChange) opts.onChange();
      });
    });
    const c = el.querySelector('#closeBtn');
    if (c) c.addEventListener('click', () => window.api.close());
    const s = el.querySelector('#settingsBtn');
    if (s) s.addEventListener('click', () => window.api.openSettings());
  };

})();
