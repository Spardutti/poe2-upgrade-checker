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

  // Gear score block: "78 A · for your build · yours 56 (+22)" + why? details
  window.gearBlock = function (g, yours, idSuffix) {
    if (!g) return '';
    if (g.unique) return '<div class="gear dim">Gear score: uniques aren\'t rated (their mods are fixed).</div>';
    const diff = yours != null ? g.score - yours : null;
    const cmp = diff == null ? '' : ` · yours ${yours} <b class="${diff > 0 ? 'pos' : diff < 0 ? 'neg' : ''}">(${diff > 0 ? '+' : ''}${diff})</b>`;
    const contrib = (g.contributions || []).slice(0, 8).map((c) => `<div class="gc"><span>${esc(c.label)}${c.source === 'socket' ? ' (rune)' : ''}</span><span class="dim">${c.quality}% roll</span><b>+${c.points}</b></div>`).join('');
    const detail = `${contrib}${g.missing && g.missing.length ? `<div class="note">Missing: ${esc(g.missing.join(', '))}</div>` : ''}${g.wasted && g.wasted.length ? `<div class="dim">Not useful to your build: ${esc(g.wasted.join(', '))}</div>` : ''}`;
    return `<div class="gear"><span class="gs g-${esc(g.grade)}" title="${esc(g.buildName || '')}">${g.score} ${esc(g.grade)}</span>
      <span>Gear score${cmp}</span> <button class="link gear-why" data-why="${idSuffix || 'x'}">why?</button></div>
      <div class="gear-detail hidden" data-whybox="${idSuffix || 'x'}">${detail}</div>`;
  };
  window.bindGearWhy = function (root) {
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

  function pointsLabel(r) {
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
    const gearMode = r.scoreMode === 'gear';
    const target = ['Ring', 'Charm', 'Jewel'].includes(it.slot) ? it.slot : r.targetSlot;
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
    const gearLine = !g ? '' : g.unrated === 'unidentified' ? '<div class="dim">Unidentified – identify it to see its gear score.</div>'
      : g.unique ? '' : `<div class="gear">${gearChip}<span>gear score${yours != null ? ` · yours ${yours}` : ''}</span> <button class="link gear-why" data-why="p">why?</button></div>
        <div class="gear-detail hidden" data-whybox="p">${(g.contributions || []).slice(0, 8).map((c) => `<div class="gc"><span>${esc(c.label)}${c.source === 'socket' ? ' (rune)' : ''}</span><span class="dim">${c.quality}% roll</span><b>+${c.points}</b></div>`).join('')}
          ${g.missing && g.missing.length ? `<div class="note">Missing: ${esc(g.missing.join(', '))}</div>` : ''}
          ${g.wasted && g.wasted.length ? `<div class="dim">Not useful to your build: ${esc(g.wasted.join(', '))}</div>` : ''}
          ${g.resNote ? `<div class="dim">${esc(g.resNote)}</div>` : ''}</div>`;

    const emptySlot = !r.replacing.length && !r.isEquipped;
    const craft = it.affixes && it.affixes.known && !unique ? `<div class="craft">${it.affixes.openPrefix || it.affixes.openSuffix
      ? `Open: <b>${it.affixes.openPrefix}</b> prefix${it.affixes.openPrefix === 1 ? '' : 'es'}, <b>${it.affixes.openSuffix}</b> suffix${it.affixes.openSuffix === 1 ? '' : 'es'} – craftable`
      : 'All 6 affixes taken'}</div>` : '';

    const primary = unique
      ? `<button class="find" id="priceFind">What's it worth?</button><button id="likeFind" title="This unique on the trade site, cheapest first">Find cheaper copies</button>`
      : `${r.replacing.length ? `<button class="find" id="quickFind" title="Listings with the same stats as your equipped ${esc(r.targetSlot)}, at your values or higher">Find upgrades${esc(budget)}</button>`
        : `<button class="find" id="likeFind" title="Listings with this item's stats">Find items like this${esc(budget)}</button>`}
         <button id="priceFind" title="What similar items sell for">What's it worth?</button>`;

    el.innerHTML = `
      <div class="card">
        ${opts.closable ? '<button class="x" id="closeBtn" title="Close">×</button>' : ''}
        <div class="name ${esc(rarity)}">${esc(it.name || '')}</div>
        <div class="meta">${it.baseType && it.baseType !== it.name ? `${esc(it.baseType)} · ` : ''}${esc(it.itemClass || '')}${it.itemLevel ? ` · ilvl ${it.itemLevel}` : ''}</div>
        ${unique ? `<div class="verdict same"><span class="badge">UNIQUE</span>${r.replacing.length && !r.isEquipped ? `<span class="dim">vs ${esc(r.replacing.join(' + '))}</span>` : ''}</div>
          <div class="dim">Uniques have fixed mods, so there's no gear score – check its price, or compare the changes below.</div>`
          : `<div class="verdict ${v.cls}">
          <span class="badge">${v.text}</span>
          ${r.isEquipped || emptySlot ? '' : `<span class="score">${esc(pointsLabel(r))}</span>`}
          ${r.isEquipped ? '' : r.replacing.length ? `<span class="dim">vs ${esc(r.replacing.join(' + '))}</span>` : `<span class="dim">${esc(r.targetSlot)} slot is empty</span>`}
        </div>`}
        ${gearLine}
        ${craft}
        ${r.isEquipped ? `<div class="note">This is your equipped ${esc(r.targetSlot)}.</div>` : ''}
        ${top && !r.isEquipped ? `<div class="chgs">${top}</div>` : ''}
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
            ${r.replacing.length ? '<button class="link" id="weightFind" title="Listings that beat your equipped item by your stat weights">By my weights</button>' : ''}
            ${!unique && it.slot ? '<button class="link" id="craftFind" title="Bases with your key stats and an open affix to craft">Craftable bases</button>' : ''}
            <button class="link" id="customFind" title="Pick which of this item\'s stats to search for">Custom search…</button>
            ${opts.closable && window.api.stashAddFromPopup ? '<button class="link" id="stashAdd" title="Count this item in your stash value">Add to stash value</button>' : ''}
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
    run(el.querySelector('#quickFind'), () => window.api.quickFind(target, 'similar'), 'Searching the trade site…');
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
    const sa = el.querySelector('#stashAdd');
    if (sa) sa.addEventListener('click', async () => {
      sa.disabled = true;
      const res = await window.api.stashAddFromPopup(ref, 1);
      const m = msgEl();
      if (!res || !res.ok) m.textContent = (res && res.error) || "Couldn't add it.";
      else if (!res.priced) m.textContent = "Added to stash value without a price. Click What's it worth? first, or type a price on the Stash value tab.";
      else m.textContent = `Added to stash value at ${res.item.div >= 1 ? res.item.div.toFixed(1) + ' div' : (ui.divineRate ? Math.round(res.item.div * ui.divineRate) + ' ex' : res.item.div.toFixed(2) + ' div')} (${res.basis === 'ninja' ? 'poe.ninja, follows the market' : 'your price check'}).`;
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

  // Popup after a stash scan.
  window.renderStashToast = function (el, r, opts) {
    opts = opts || {};
    const rate = r.divineRate;
    const div = (v) => { if (v == null) return '–'; const a = Math.abs(v); if (rate && a < 0.5) return `${Math.round(v * rate)} ex`; return `${a >= 100 ? Math.round(v) : a >= 10 ? v.toFixed(1) : v.toFixed(2)} div`; };
    const sg = (v) => `${v >= 0 ? '+' : '−'}${div(Math.abs(v))}`;
    const close = opts.closable ? '<button class="x" id="closeBtn" title="Close">×</button>' : '';
    if (r.loading || !r.ok) {
      el.innerHTML = `<div class="card st-toast ${r.loading ? 'loading' : ''}">${close}<div class="note">${r.loading ? '<span class="spinner"></span> ' : ''}${esc(r.reason || '')}</div>
        ${!r.loading ? '<div class="dim small">Open a specialty tab (Currency, Essence, Runes…) in Windowed Fullscreen and try again.</div>' : ''}</div>`;
    } else if (r.note) {
      el.innerHTML = `<div class="card st-toast">${close}<div class="name">${esc(r.label)}</div><div class="note">${esc(r.reason)}</div>
        <div class="dim">Stash total: <b>${esc(div(r.total))}</b></div></div>`;
    } else {
      const ch = (r.changes || []).map((c) => `<div class="line"><span><span class="${c.delta > 0 ? 'up' : 'down'}">${c.delta > 0 ? '+' : '−'}${Math.abs(c.delta)}</span> ${esc(c.name)}</span><span class="dim">${c.div != null ? esc(sg(c.div)) : ''}</span></div>`).join('');
      const top = (r.top || []).map((t) => `<div class="line"><span>${esc(t.name)} <span class="dim">×${t.count}</span></span><span class="dim">${esc(div(t.value))}</span></div>`).join('');
      el.innerHTML = `<div class="card st-toast">${close}
        <div class="name">${esc(r.label)} tab</div>
        <div class="big">${esc(div(r.value))}</div>
        <div class="dim">${r.first ? 'First scan of this tab' : r.delta ? `${esc(sg(r.delta))} since last scan` : 'No change since last scan'} · stash total <b>${esc(div(r.total))}</b></div>
        ${ch ? `<div class="chgs">${ch}</div>` : top ? `<div class="chgs">${top}</div>` : ''}
        ${r.unreadable && r.unreadable.length ? `<div class="note">${r.unreadable.length} count${r.unreadable.length === 1 ? '' : 's'} unreadable (kept the last value): ${esc(r.unreadable.slice(0, 3).join(', '))}${r.unreadable.length > 3 ? '…' : ''}. Hover it and press Ctrl+C to fix.</div>` : ''}
        ${r.unpriced ? `<div class="dim small">${r.unpriced} item type${r.unpriced === 1 ? '' : 's'} have no poe.ninja price.</div>` : ''}
        <div class="actions"><button class="link" id="stOpen">Stash value…</button></div></div>`;
    }
    const c = el.querySelector('#closeBtn'); if (c) c.addEventListener('click', () => window.api.close());
    const o = el.querySelector('#stOpen'); if (o) o.addEventListener('click', () => window.api.openSettingsTab('stash'));
  };
})();
