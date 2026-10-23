'use strict';
/* global window, document */

// Where to spend: every slot searched within your budget and checked with your build, ranked by
// how much each upgrade gives you per divine; plus pairs of items that cap your resistances.
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const n1 = (v) => (v == null || !Number.isFinite(Number(v)) ? '–' : (Math.round(v * 10) / 10).toLocaleString('en'));
  const div = (v) => (v == null ? '' : v >= 10 ? `${Math.round(v)} div` : `${Math.round(v * 100) / 100} div`);
  const body = () => $('#spendBody');
  let running = false;

  function render(run, msg) {
    if (!run) { if (msg) body().innerHTML = `<div class="card-p note">${esc(msg)}</div>`; return; }
    const rows = run.rows || [];
    const gs = run.mode === 'gear'; // without Path of Building: gear score points instead of % for your build
    const gain = (v) => (gs ? `+${n1(v)} gear score` : `+${n1(v)}%`);
    const per = (v) => (gs ? `${n1(v)} pts` : `${n1(v)}%`);
    const withBest = rows.filter((r) => r.best);
    const top = withBest[0];
    const when = run.at ? new Date(run.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const headline = top
      ? `<div class="card-p spend-top"><h3>Best value: ${esc(top.slot)}</h3>
          <p><b>${esc(top.best.name)}</b> for ${esc(top.best.price)}: <b class="pos">${gain(top.best.gain)}</b> for your build${top.best.perDiv != null ? ` · <b>${per(top.best.perDiv)} per divine</b>` : ''}.</p>
          ${withBest[1] ? `<p class="dim">Next: ${esc(withBest[1].slot)} (${gain(withBest[1].best.gain)} for ${esc(withBest[1].best.price)})${withBest[2] ? `, then ${esc(withBest[2].slot)} (${gain(withBest[2].best.gain)} for ${esc(withBest[2].best.price)})` : ''}.</p>` : ''}
        </div>`
      : '<div class="card-p note">Nothing in your price range is an upgrade for your build. Try a higher maximum on Find upgrades.</div>';
    const row = (r) => {
      const b = r.best; const big = r.biggest && r.biggest !== b && r.biggest.name !== (b && b.name) ? r.biggest : null;
      const what = r.error ? `<span class="neg">${esc(r.error)}</span>`
        : b ? `<b>${esc(b.name)}</b> <span class="dim">${esc(b.base || '')}</span><br><span class="pos">${gain(b.gain)}</span> for ${esc(b.price)}${b.risks && b.risks.length ? ` <span class="warn" title="${esc(b.risks.join('; '))}">⚠ ${esc(b.risks[0])}</span>` : ''}${big ? `<br><span class="dim">Biggest gain: ${gain(big.gain)} for ${esc(big.price)} (${esc(big.name)})</span>` : ''}`
          : r.none ? '<span class="dim">Nothing listed in your price range.</span>' : '<span class="dim">Nothing listed in your price range beats what you wear.</span>';
      return `<tr><td><b>${esc(r.slot)}</b>${r.current ? `<br><span class="dim small">${esc(r.current)}</span>` : ''}</td>
        <td>${what}</td><td class="num">${b && b.perDiv != null ? `<b>${per(b.perDiv)}</b>` : '–'}</td>
        <td>${r.total ? `<button class="link spend-open" data-slot="${esc(r.slot)}">${r.total} listed</button>` : ''}</td></tr>`;
    };
    const pairs = run.pairs || [];
    const pairHtml = run.short && run.short.length ? `<div class="card-p"><h3>Cap your resistances (${esc(run.short.join(', '))} short)</h3>
        ${pairs.length ? `<table class="kv">${pairs.map((p) => `<tr><td>${p.all ? '<b class="pos">All capped</b>' : `Caps ${esc(p.capped.join(', '))}`}</td>
          <td><b>${esc(p.a.slot)}</b>: ${esc(p.a.name)} (${esc(p.a.price)})<br><b>${esc(p.b.slot)}</b>: ${esc(p.b.name)} (${esc(p.b.price)})</td>
          <td class="num">${p.priceDiv != null ? esc(div(p.priceDiv)) : ''}${p.gain ? `<br><span class="${p.gain > 0 ? 'pos' : 'neg'}">${p.gain > 0 ? '+' : ''}${n1(p.gain)}%</span>` : ''}</td></tr>`).join('')}</table>
          <p class="dim small">Each pair was checked together with Path of Building: wearing both caps these resistances without losing damage. Prices are what they're listed for now.</p>`
          : '<p class="dim">No two of the listings found cap your missing resistances together. A single item from the table above, or a higher price range, may.</p>'}</div>` : '';
    body().innerHTML = `${msg ? `<div class="card-p note">${esc(msg)}</div>` : ''}${headline}
      <div class="card-p"><h3>Every slot</h3><table class="kv spend"><tr><th>Slot</th><th>Best value in your price range</th><th>Per divine</th><th></th></tr>${rows.map(row).join('')}</table>
      <p class="dim small">${esc(run.league || '')}${run.budget ? ` · ${esc(run.budget)}` : ''}${when ? ` · checked at ${esc(when)}` : ''} · ${gs ? 'Gear score points gained over what you wear (no Path of Building build loaded, so no resistance pairs)' : '"+%" is how much better your build is by Path of Building (damage and effective HP, as in the popup)'}, checked on the first 10 listings of each search.${run.stopped ? ` Stopped early: ${esc(run.stopped)}` : ''}</p></div>
      ${pairHtml}`;
    body().querySelectorAll('.spend-open').forEach((b) => b.addEventListener('click', async () => { b.disabled = true; await window.api.spendOpen(b.dataset.slot); b.disabled = false; }));
  }

  $('#spendRun').addEventListener('click', async () => {
    if (running) return;
    running = true; $('#spendRun').disabled = true;
    body().innerHTML = '<div class="card-p"><span class="spinner"></span> <span id="spendProg">Starting…</span></div>';
    try {
      const r = await window.api.spendRun();
      if (!r || !r.ok) render(null, (r && r.error) || 'Something went wrong.');
      else render(r);
    } catch (err) { render(null, err.message); }
    running = false; $('#spendRun').disabled = false;
  });
  window.api.onSpendProgress((p) => {
    const el = $('#spendProg');
    if (!el || !p) return;
    el.textContent = p.finished ? 'Done.' : p.pairs ? 'Trying pairs of items for your resistances…' : `Searching ${p.slot} (${p.done + 1} of ${p.total})… the trade site allows only a few searches a minute.`;
  });
  // the last run for this game, when you open the page
  document.querySelector('.tabs button[data-tab="spend"]').addEventListener('click', async () => {
    if (running) return;
    const r = await window.api.spendGet();
    if (r) render(r);
  });
  if (window.api.onGameChanged) window.api.onGameChanged(() => { if (!running) body().innerHTML = '<div class="card-p dim">Press <b>Find where to spend</b> for this game\'s character.</div>'; });
})();
