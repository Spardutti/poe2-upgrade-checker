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
    if (!key.includes('#')) return `${fmt(diff)} ${key}`;
    let first = true;
    // "+# to x" style keys: put the signed diff in the first #, leave other #s as "…"
    return key.replace(/#/g, () => { if (first) { first = false; return fmt(diff); } return '…'; })
      .replace(/^\+\+/, '+').replace(/^\+-/, '-');
  }

  const VERDICT = {
    upgrade: { text: 'UPGRADE', cls: 'up' },
    small: { text: 'SMALL UPGRADE', cls: 'up' },
    risky: { text: 'UPGRADE, BUT…', cls: 'risky' },
    resloss: { text: 'LOSES RESISTANCE', cls: 'down' },
    dmgloss: { text: 'LOSES DAMAGE', cls: 'down' },
    downgrade: { text: 'DOWNGRADE', cls: 'down' },
    same: { text: 'SIDEGRADE', cls: 'same' },
    new: { text: 'EMPTY SLOT', cls: 'new' },
    equipped: { text: 'EQUIPPED', cls: 'same' },
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
      if (res.mode === 'price' && res.summary) t = `Worth about ${res.summary.typical} (cheapest ${res.summary.cheapest}, ${res.total} similar listed). `;
      if (res.mode === 'price' && res.level > 0) t += ` Compared with ${res.levelLabel}.`;
      if (res.mode === 'craft' && res.keyStats) t += ` Rare bases with ${res.keyStats.join(' + ')} and an open affix to craft.`;
      if (res.mode === 'similar' && res.of) {
        t += res.unique ? ` Same unique${res.need ? `, ${res.need} of ${res.of} mods at ${res.levelLabel}` : ''}.` : ` At least ${res.need} of your ${res.of} stats at ${res.levelLabel}.`;
        if (res.level > 0) t += ' (Loosened: nothing matched your exact values.)';
      }
      if (res.mode === 'gear') t += res.level === 1 ? ' No clear upgrade listed; these are a little better than yours.' : res.level > 1 ? ` Nothing beats yours yet; these come close (${res.levelLabel}).` : ` Clearly better for your build than yours${res.score != null ? ` (gear score ${res.score})` : ''} – best for your build first.`;
      if (res.fallback) t += ' The direct search failed, so a pre-filled link was used – see the log.';
    }
    if (res.skipped && res.skipped.length) t += ` Left out rune bonuses: ${res.skipped.length}.`;
    if (res.ignored && res.ignored.length) t += ` Ignored: ${res.ignored.length} stat${res.ignored.length === 1 ? '' : 's'}.`;
    if (res.excluded) t += ' Listings with your excluded stats are hidden.';
    if (res.unmatched && res.unmatched.length) t += ` Not searchable: ${res.unmatched.join(', ')}.`;
    el.textContent = t;
    if (res.url && !res.opened) {
      const a = document.createElement('button');
      a.className = 'link'; a.textContent = 'Open on trade site anyway';
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
    if (ch.overall && ch.overall.delta) items.push({ cls: ch.overall.delta > 0 ? 'pos' : 'neg', html: `Overall gear score ${ch.overall.from} → <b>${ch.overall.to}</b>` });
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
  window.resLossBanner = function (rows) {
    if (!rows || !rows.length) return '';
    const txt = rows.map((r) => {
      const el = r.el || String(r.label || '').replace(/ res$/, '');
      const max = r.max || r.cap || 75;
      const from = Math.round(r.from); const to = Math.round(r.to);
      return `<b>${esc(el)}</b> ${Math.min(from, max)}% → <b>${to}%</b> <span>(${to - Math.min(from, max)} ${from >= max ? 'off the cap' : 'further under the cap'})</span>`;
    }).join(' · ');
    return `<div class="res-loss-banner">⚠ LOSES RESISTANCE: ${txt}</div>`;
  };
  // the same for an item that costs a big part of your damage (e.g. a ring without your minion mods)
  window.dmgLossBanner = function (d) {
    if (!d) return '';
    const n = (v) => (v >= 1000 ? Math.round(v).toLocaleString('en') : Math.round(v));
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
    const dmgName = p.dpsKey === 'MinionDPS' ? 'Minion DPS' : 'DPS';
    const head = `<span class="pob-tag" title="Calculated by Path of Building with your build">PoB</span>
      <span class="pob-main">${dmgName} ${pc(p.dps && p.dps.pct)} · Effective HP ${pc(p.ehp && p.ehp.pct)}${p.resFirst && p.resGain ? ` · <span title="Resistance points toward your cap (Priorities: cap resistances first)">res toward cap <b class="${p.resGain > 0 ? 'pos' : 'neg'}">${p.resGain > 0 ? '+' : '−'}${Math.abs(p.resGain)}</b></span>` : ''}</span>`;
    const res = (p.res || []).filter((r) => r.capped !== r.wasCapped || !r.capped || Math.round(r.from) !== Math.round(r.to)).map((r) => {
      const bad = r.wasCapped && !r.capped; const good = !r.wasCapped && r.capped;
      return `<span class="cc ${bad || (!r.capped && r.to < r.from) ? 'neg warn' : good || r.to > r.from ? 'pos' : 'dim'}">${esc(r.el)} res ${Math.round(r.from)}% → <b>${Math.round(r.to)}%</b>${bad ? ' ⚠ off the cap' : good ? ' ✓ capped' : !r.capped ? ' (under cap)' : ''}</span>`;
    }).join('');
    const parts = [dl('ES', p.es), dl('Life', p.life), dl('Spirit', p.spirit), dl('Mana', p.mana), res].filter(Boolean);
    // resistance losses get their own banner, above everything else
    const lossBanner = opts.noBanner ? '' : window.resLossBanner(p.resLoss) + window.dmgLossBanner(p.dmgLoss);
    const capLine = p.resCapped && p.resCapped.length ? `<div class="res-cap">✓ Caps your ${esc(p.resCapped.join(' and ').toLowerCase())} resistance</div>` : '';
    const other = (p.breaks || []).filter((b) => !/res (drops off|goes further under)|^(Minion damage|Damage) drops/.test(b));
    const risk = other.length ? `<div class="risks">⚠ ${other.map(esc).join(' · ')}</div>` : '';
    return `${lossBanner}${capLine}<div class="pob">${head}</div>${risk}${parts.length ? `<div class="charch">${opts.compact ? parts.slice(0, 5).join('') : parts.join('')}</div>` : ''}`;
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
          <span class="vchip risky">UPGRADE, BUT…</span> better, but it costs Spirit, drops a resistance below the cap, or loses minion levels.</li>
        <li><b>It isn't a damage calculator.</b> It doesn't know your passive tree or skill gems. Check <b>If you equip it</b> under each listing for what changes on your character${opts.where ? `, and tune what each stat is worth on the ${opts.where}` : ''}.</li>
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
  function scoreHtml(label) {
    if (!label) return '';
    const m = String(label).match(/^([+\-−]?[\d.,]+%?)\s*(.*)$/);
    return m ? `<span class="score">${esc(m[1])}${m[2] ? ` <small>${esc(m[2])}</small>` : ''}</span>` : `<span class="score">${esc(label)}</span>`;
  }

  function pointsLabel(r) {
    // a loss verdict with a positive score would read like an upgrade: the banner says what it costs
    if (r.scoreMode === 'pob') return r.delta == null || ((r.verdict === 'dmgloss' || r.verdict === 'resloss') && r.delta > 0) ? '' : `${r.delta > 0 ? '+' : ''}${r.delta}% for your build`;
    if (r.scoreMode === 'gear') {
      if (r.delta == null) return '';
      return `${r.delta > 0 ? '+' : ''}${r.delta} gear score`;
    }
    const pct = r.pct == null ? '' : ` (${fmt(r.pct)}%)`;
    return `${fmt(r.delta)}${pct}`;
  }

  // Popup / test view. Compact by default: item, verdict, gear score, top
  // changes and two buttons; "More" shows everything else.
  window.renderComparison = function (el, r, opts) {
    opts = opts || {};
    const ui = (r && r.ui) || {};
    document.body.classList.toggle('cb', !!ui.colorblind);
    if (!r || !r.ok) {
      el.innerHTML = `<div class="card ${r && r.loading ? 'loading' : ''}">${opts.closable ? '<button class="x" id="closeBtn" title="Close">×</button>' : ''}
        <div class="note">${r && r.loading ? '<span class="spinner"></span> ' : ''}${esc((r && r.reason) || 'Nothing to show.')}</div></div>`;
      const c0 = el.querySelector('#closeBtn');
      if (c0) c0.addEventListener('click', () => window.api.close());
      return;
    }
    const it = r.item;
    const unique = /unique/i.test(it.rarity || '');
    const v = VERDICT[r.verdict] || VERDICT.same;
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
    const gearLine = !g || r.pob ? '' : g.unrated === 'unidentified' ? '<div class="dim">Unidentified – identify it to see its gear score.</div>'
      : g.unique ? '' : `<div class="gear">${gearChip}<span>gear score${yours != null ? ` · yours ${yours}` : ''}</span> <button class="link gear-why" data-why="p">why?</button></div>
        <div class="gear-detail hidden" data-whybox="p">${window.gearCompareHtml(g, r.isEquipped ? null : r.gearEquipped)}</div>`;

    const emptySlot = !r.replacing.length && !r.isEquipped;
    const craft = it.affixes && it.affixes.known && !unique ? `<div class="craft">${it.affixes.openPrefix || it.affixes.openSuffix
      ? `Open: <b>${it.affixes.openPrefix}</b> prefix${it.affixes.openPrefix === 1 ? '' : 'es'}, <b>${it.affixes.openSuffix}</b> suffix${it.affixes.openSuffix === 1 ? '' : 'es'} – craftable`
      : 'All 6 affixes taken'}</div>` : '';

    const primary = unique
      ? `<button class="find" id="priceFind">What's it worth?</button><button id="likeFind" title="This unique on the trade site, cheapest first">Find cheaper copies</button>`
      : `${r.replacing.length ? `<button class="find" id="quickFind" title="Listings that score higher for your build than your equipped ${esc(r.targetSlot)}">Find upgrades${esc(budget)}</button>`
        : `<button class="find" id="likeFind" title="Listings with this item's stats">Find items like this${esc(budget)}</button>`}
         <button id="priceFind" title="What similar items sell for">What's it worth?</button>`;

    const lossRows = r.isEquipped ? [] : r.pob ? (r.pob.resLoss || []) : ((r.character && r.character.res) || []).filter((x) => x.from != null && x.delta < 0 && x.under && (x.el !== 'chaos' || !x.wasUnder));
    const dmgLoss = !r.isEquipped && r.pob ? r.pob.dmgLoss : null;
    const lossBanner = window.resLossBanner(lossRows) + window.dmgLossBanner(dmgLoss);
    el.innerHTML = `
      <div class="card ${lossRows.length || dmgLoss ? 'res-loss' : ''}">
        ${opts.closable ? '<button class="x" id="closeBtn" title="Close">×</button>' : ''}
        <div class="name ${esc(rarity)}">${esc(it.name || '')}</div>
        <div class="meta">${it.baseType && it.baseType !== it.name ? `${esc(it.baseType)} · ` : ''}${esc(it.itemClass || '')}${it.itemLevel ? ` · ilvl ${it.itemLevel}` : ''}</div>
        ${unique && !r.pob ? `<div class="verdict same"><span class="badge">UNIQUE</span>${r.replacing.length && !r.isEquipped ? `<span class="dim">vs ${esc(r.replacing.join(' + '))}</span>` : ''}</div>
          <div class="dim">${r.pobPending ? 'Checking with Path of Building…' : "Uniques have fixed mods, so there's no gear score – check its price, or compare the changes below."}</div>`
          : `<div class="verdict ${v.cls}">
          <span class="badge">${v.text}</span>
          ${r.isEquipped || emptySlot ? '' : scoreHtml(pointsLabel(r))}
          ${r.isEquipped ? '' : r.replacing.length ? `<span class="dim">vs ${esc(r.replacing.join(' + '))}</span>` : `<span class="dim">${esc(r.targetSlot)} slot is empty</span>`}
        </div>`}
        ${lossBanner}
        ${gearLine}
        ${craft}
        ${r.isEquipped ? `<div class="note">This is your equipped ${esc(r.targetSlot)}.</div>` : ''}
        ${top && !r.isEquipped ? `<div class="chgs">${top}</div>` : ''}
        ${r.pobNudge && !r.isEquipped ? '<div class="dim small">For exact verdicts, paste your Path of Building export on <b>My gear</b>.</div>' : ''}
        ${r.isEquipped ? '' : r.pob || r.pobPending || r.pobError ? window.pobBlock(r.pob, { pending: r.pobPending, error: r.pobError, compact: !full, noBanner: true }) : window.characterBlock(r.character, { compact: !full, risks: r.risks, noBanner: true })}
        ${r.notes.filter((n) => !/^Nothing saved/.test(n) || !emptySlot).filter((n) => full || /unidentified|two-handed|Two-handed/i.test(n)).map((n) => `<div class="note">${esc(n)}</div>`).join('')}
        ${emptySlot ? `<div class="actions">${equipButtons(r)}</div>` : ''}
        <div class="actions main-actions">${primary}</div>
        <div class="note" id="findMsg"></div>
        <button class="link more" id="moreBtn">${full ? 'Less ▴' : 'More ▾'}</button>
        <div class="more-box ${full ? '' : 'hidden'}" id="moreBox">
          ${r.ignoring && r.ignoring.length ? `<div class="dim">Ignoring: ${esc(r.ignoring.join(', '))} <button class="link" id="ignoreChange">change</button></div>` : ''}
          ${!full ? r.notes.filter((n) => !/unidentified|two-handed/i.test(n)).map((n) => `<div class="note">${esc(n)}</div>`).join('') : ''}
          ${r.isEquipped ? '' : rows ? `<table class="rows"><thead><tr><th>Change</th>${gearMode ? '' : '<th>Weight</th><th>Score</th>'}<th></th></tr></thead><tbody>${rows}</tbody></table>`
            : '<div class="note">No stat differences.</div>'}
          ${r.isEquipped || emptySlot ? '' : `<div class="actions">${equipButtons(r)}</div>`}
          <div class="actions">
            ${r.replacing.length && !r.isEquipped && !unique ? '<button class="link" id="likeFind2" title="Listings with the stats of the item you just copied">Items like this one</button>' : ''}
            ${r.replacing.length && !unique ? '<button class="link" id="sameFind" title="Listings with every stat of your equipped item at your value or higher">Same stats or better</button>' : ''}
            ${r.replacing.length && !gearMode ? '<button class="link" id="weightFind" title="Listings that beat your equipped item by your stat weights">By my weights</button>' : ''}
            ${!unique && it.slot ? '<button class="link" id="craftFind" title="Bases with your key stats and an open affix to craft">Craftable bases</button>' : ''}
            <button class="link" id="customFind" title="Pick which of this item\'s stats to search for">Custom search…</button>
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
    run(el.querySelector('#priceFind'), () => window.api.priceCheck(ref), 'Checking prices…');
    window.__popupResize = opts.onResize || null;
    window.bindGearWhy(el);
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
