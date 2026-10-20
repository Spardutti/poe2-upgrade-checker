'use strict';
/* global $, esc, toAccelerator */

// Stash value tab: total, chart, per-tab breakdown, listings, other items, change feed.

let st = null;
let stRange = 168; // hours shown in the chart (0 = all)
const openTabs = new Set();

function fmtDiv(v) {
  if (v == null || !Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  const n = a >= 1000 ? Math.round(v).toLocaleString() : a >= 100 ? Math.round(v).toString() : a >= 10 ? v.toFixed(1) : a >= 0.1 ? v.toFixed(2) : v.toFixed(3);
  return `${n} div`;
}
function fmtEx(v) {
  if (!st || !st.divineRate || v == null) return '';
  const ex = v * st.divineRate;
  return `${Math.abs(ex) >= 1000 ? Math.round(ex).toLocaleString() : Math.abs(ex) >= 10 ? Math.round(ex) : ex.toFixed(1)} ex`;
}
// small values read better in exalts
function fmtSmart(v) {
  if (v == null) return '–';
  if (st && st.divineRate && Math.abs(v) < 0.5) return fmtEx(v);
  return fmtDiv(v);
}
const signed = (v, f = fmtDiv) => (v == null ? '–' : `${v >= 0 ? '+' : '−'}${f(Math.abs(v))}`);
function ago(t) {
  if (!t) return 'never';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now'; if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

async function stLoad() {
  st = await window.api.stashStatus();
  stRender();
}

function stRender() {
  if (!st) return;
  $('#stTotal').textContent = fmtDiv(st.total);
  const sub = [];
  if (st.divineRate) sub.push(`≈ ${fmtEx(st.total)}`);
  sub.push(st.pricesCount ? `prices: poe.ninja${st.league ? ` · ${st.league}` : ''}${st.pricesAt ? ` · ${ago(st.pricesAt)}` : ''}` : 'prices not loaded yet');
  if (st.unpriced) sub.push(`${st.unpriced} item type${st.unpriced === 1 ? '' : 's'} without a price`);
  $('#stSub').textContent = sub.join('  ·  ');
  const k = [];
  const s = st.session;
  if (s) k.push(['This session', signed(s.gained, fmtSmart), s.perHour != null ? `${signed(s.perHour, fmtSmart)} / hour` : 'per hour after 10 min', s.gained]);
  if (st.day != null) k.push(['Last 24 hours', signed(st.day, fmtSmart), '', st.day]);
  $('#stKpis').innerHTML = k.map(([a, b, c, v]) => `<div class="kpi"><div class="dim small">${esc(a)}</div><div class="kpi-v ${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${esc(b)}</div><div class="dim small">${esc(c)}</div></div>`).join('');
  $('#stHowTo').innerHTML = st.hotkey
    ? `or press <b>${esc(st.hotkey)}</b> in game with a specialty stash tab open${st.hotkeyOk ? '' : ' <span class="down">(hotkey is taken by another app – change it below)</span>'}`
    : 'Scan hotkey is off (set one below).';
  if (!$('#stHotkey').value) $('#stHotkey').value = st.hotkey || '';
  if (document.activeElement !== $('#stAccount')) $('#stAccount').value = st.account || '';
  stChart();
  stTabs();
  stListed();
  stItems();
  stFeed();
}

// ---------- chart ----------
function stChart() {
  const svg = $('#stChart');
  const W = 640; const H = 150; const P = { l: 4, r: 4, t: 10, b: 16 };
  const now = Date.now();
  let pts = (st.history || []).filter(([t]) => !stRange || t >= now - stRange * 3600000);
  if (pts.length && pts[pts.length - 1][0] < now - 60000) pts = [...pts, [now, st.total]];
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const ns = 'http://www.w3.org/2000/svg';
  const el = (name, attrs) => { const e = document.createElementNS(ns, name); for (const [a, v] of Object.entries(attrs)) e.setAttribute(a, v); svg.appendChild(e); return e; };
  if (pts.length < 2) {
    const t = el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'st-empty' });
    t.textContent = 'Your net worth over time shows here after a couple of scans.';
    $('#stChartNote').textContent = '';
    return;
  }
  const t0 = pts[0][0]; const t1 = pts[pts.length - 1][0];
  let lo = Math.min(...pts.map((p) => p[1])); let hi = Math.max(...pts.map((p) => p[1]));
  if (hi - lo < 1e-6) { hi += 1; lo = Math.max(0, lo - 1); }
  const pad = (hi - lo) * 0.08; lo = Math.max(0, lo - pad); hi += pad;
  const X = (t) => P.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - P.l - P.r);
  const Y = (v) => P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b);
  // step line: the total holds until the next reading
  let d = `M${X(pts[0][0]).toFixed(1)},${Y(pts[0][1]).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) d += ` H${X(pts[i][0]).toFixed(1)} V${Y(pts[i][1]).toFixed(1)}`;
  for (const f of [0.25, 0.5, 0.75]) el('line', { x1: P.l, x2: W - P.r, y1: P.t + f * (H - P.t - P.b), y2: P.t + f * (H - P.t - P.b), class: 'st-grid' });
  el('path', { d: `${d} V${H - P.b} H${X(pts[0][0]).toFixed(1)} Z`, class: 'st-area' });
  el('path', { d, class: 'st-line' });
  const last = pts[pts.length - 1];
  el('circle', { cx: X(last[0]), cy: Y(last[1]), r: 3.5, class: 'st-dot' });
  const lab = (x, y, txt, anchor) => { const t = el('text', { x, y, 'text-anchor': anchor, class: 'st-axis' }); t.textContent = txt; };
  const day = (t) => new Date(t).toLocaleString(undefined, t1 - t0 > 2 * 86400000 ? { month: 'short', day: 'numeric' } : { hour: '2-digit', minute: '2-digit' });
  lab(P.l + 2, H - 3, day(t0), 'start'); lab(W - P.r - 2, H - 3, day(t1), 'end');
  const first = pts[0][1];
  $('#stChartNote').textContent = `Low ${fmtDiv(Math.min(...pts.map((p) => p[1])))} · high ${fmtDiv(Math.max(...pts.map((p) => p[1])))} · net change ${signed(last[1] - first)} (includes newly scanned tabs)`;
}
document.querySelectorAll('#stRange button').forEach((b) => b.addEventListener('click', () => {
  stRange = Number(b.dataset.range);
  document.querySelectorAll('#stRange button').forEach((x) => x.classList.toggle('active', x === b));
  stChart();
}));

// ---------- tabs ----------
function stTabs() {
  const tbl = $('#stTabs');
  if (!st.tabs.length) {
    tbl.innerHTML = '<tr><td class="dim">No tabs scanned yet. In game: open your Currency tab, then press the scan hotkey.</td></tr>';
    return;
  }
  const total = st.tabs.filter((t) => !t.hidden).reduce((a, t) => a + t.value, 0) || 1;
  let html = '<tr><th>Tab</th><th class="r">Value</th><th class="r">Share</th><th>Scanned</th><th></th></tr>';
  for (const t of st.tabs) {
    const stale = t.ageH != null && t.ageH > 24;
    const warn = [];
    if (t.unreadable.length) warn.push(`${t.unreadable.length} unreadable`);
    if (t.unpriced.length) warn.push(`${t.unpriced.length} no price`);
    html += `<tr class="${t.hidden ? 'muted' : ''}">
      <td><button class="link st-open" data-tab="${esc(t.id)}">${openTabs.has(t.id) ? '▾' : '▸'} ${esc(t.label)}</button>${warn.length ? ` <span class="chip warn">${esc(warn.join(', '))}</span>` : ''}</td>
      <td class="r"><b>${fmtDiv(t.value)}</b></td>
      <td class="r"><span class="bar"><span class="bar-in" data-w="${t.hidden ? 0 : Math.round((100 * t.value) / total)}"></span></span> ${t.hidden ? '–' : Math.round((100 * t.value) / total) + '%'}</td>
      <td class="${stale ? 'down' : 'dim'}" title="${esc(new Date(t.scannedAt).toLocaleString())}">${esc(ago(t.scannedAt))}${stale ? ' – rescan' : ''}</td>
      <td class="r nowrap"><button class="link" data-hide="${esc(t.id)}">${t.hidden ? 'Count it' : "Don't count"}</button> <button class="link" data-rm="${esc(t.id)}">Remove</button></td></tr>`;
    if (openTabs.has(t.id)) {
      html += `<tr class="st-detail"><td colspan="5"><table class="rows inner"><tr><th>Item</th><th class="r">Count</th><th class="r">Each</th><th class="r">Value</th></tr>${t.lines.map((l) => `<tr class="${t.unreadable.includes(l.name) ? 'warnrow' : ''}">
          <td>${esc(l.name)}${l.conf === 'low' ? ' <span class="chip">few listings</span>' : ''}${t.unreadable.includes(l.name) ? ' <span class="chip warn">unreadable – check</span>' : ''}</td>
          <td class="r"><input class="num st-count" type="number" min="0" value="${l.count}" data-tab="${esc(t.id)}" data-name="${esc(l.name)}"></td>
          <td class="r dim">${l.unit == null ? 'no price' : fmtSmart(l.unit)}</td><td class="r">${l.value == null ? '–' : fmtSmart(l.value)}</td></tr>`).join('')}
          ${t.unreadable.filter((n) => !t.lines.some((l) => l.name === n)).map((n) => `<tr class="warnrow"><td>${esc(n)} <span class="chip warn">unreadable</span></td><td class="r"><input class="num st-count" type="number" min="0" placeholder="?" data-tab="${esc(t.id)}" data-name="${esc(n)}"></td><td></td><td></td></tr>`).join('')}
        </table><div class="dim small">Fix a count by typing it here, or hover the stack in game and press Ctrl+C.</div></td></tr>`;
    }
  }
  tbl.innerHTML = html;
  tbl.querySelectorAll('.bar-in').forEach((b) => { b.style.width = `${b.dataset.w}%`; });
  tbl.querySelectorAll('.st-open').forEach((b) => b.addEventListener('click', () => { const id = b.dataset.tab; if (openTabs.has(id)) openTabs.delete(id); else openTabs.add(id); stTabs(); }));
  tbl.querySelectorAll('[data-hide]').forEach((b) => b.addEventListener('click', async () => { const t = st.tabs.find((x) => x.id === b.dataset.hide); await window.api.stashHide(b.dataset.hide, !t.hidden); }));
  tbl.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', async () => { await window.api.stashRemoveTab(b.dataset.rm); }));
  tbl.querySelectorAll('.st-count').forEach((i) => i.addEventListener('change', async () => { if (i.value !== '') await window.api.stashSetCount(i.dataset.tab, i.dataset.name, Number(i.value)); }));
}

// ---------- listings ----------
function stListed() {
  const L = st.listings;
  const tbl = $('#stListed');
  $('#stHideListings').checked = !!(st.hiddenListings);
  if (!L || !L.lines.length) {
    tbl.innerHTML = `<tr><td class="dim">${st.account ? 'No listings loaded. Click Refresh listings.' : 'Enter your account name (as shown on the trade site, e.g. Name#1234) to include items you have listed.'}</td></tr>`;
    return;
  }
  const rows = L.lines.slice(0, 15).map((l) => `<tr><td>${esc(l.name)}${l.stackSize > 1 ? ` <span class="dim">×${l.stackSize}</span>` : ''}${l.stash ? ` <span class="dim small">in ${esc(l.stash)}</span>` : ''}</td>
    <td class="r dim">${esc(l.priceText || '')}</td><td class="r">${fmtSmart(l.value)}</td><td class="dim small">${l.basis === 'market' ? 'market price' : l.basis === 'asking' ? 'your price' : 'no price'}</td></tr>`).join('');
  tbl.innerHTML = `<tr><th>Item</th><th class="r">Listed at</th><th class="r">Counted as</th><th></th></tr>${rows}
    <tr><td class="dim" colspan="2">${L.count} listing${L.count === 1 ? '' : 's'}${L.skipped ? ` · ${L.skipped} skipped (already in a scanned tab)` : ''}${L.lines.length > 15 ? ` · showing top 15` : ''}</td><td class="r"><b>${fmtDiv(L.value)}</b></td><td></td></tr>`;
}
$('#stListings').addEventListener('click', async () => {
  const acct = $('#stAccount').value.trim();
  await window.api.setSetting('stashAccount', acct);
  $('#stListMsg').textContent = 'Loading your listings…';
  const r = await window.api.stashListings();
  $('#stListMsg').textContent = r.ok ? `${r.count} listing${r.count === 1 ? '' : 's'} loaded${r.truncated ? ` (first 100 of ${r.total})` : ''}.` : r.error;
});
$('#stAccount').addEventListener('change', () => window.api.setSetting('stashAccount', $('#stAccount').value.trim()));
$('#stHideListings').addEventListener('change', () => window.api.stashHide('__listings', $('#stHideListings').checked));

// ---------- other items ----------
function stItems() {
  const I = st.items;
  const tbl = $('#stItems');
  if (!I.lines.length) { tbl.innerHTML = '<tr><td class="dim">Nothing added yet.</td></tr>'; return; }
  tbl.innerHTML = `<tr><th>Item</th><th class="r">Qty</th><th class="r">Each (div)</th><th class="r">Value</th><th></th></tr>${I.lines.map((l) => `<tr>
    <td><span class="${esc(String(l.rarity || '').toLowerCase())}">${esc(l.name)}</span>${l.priceFrom === 'ninja' ? ' <span class="chip">poe.ninja</span>' : l.priceFrom === 'trade' ? ' <span class="chip">price check</span>' : ''}${l.div == null && l.priceFrom !== 'ninja' ? ' <span class="chip warn">set a price</span>' : ''}</td>
    <td class="r"><input class="num st-iq" type="number" min="1" value="${l.qty}" data-id="${esc(l.id)}"></td>
    <td class="r"><input class="num st-id" type="number" min="0" step="0.01" value="${l.priceFrom === 'ninja' ? (l.unit || 0).toFixed(2) : l.div == null ? '' : l.div}" ${l.priceFrom === 'ninja' ? 'title="Following poe.ninja. Type a price to set your own."' : ''} data-id="${esc(l.id)}"></td>
    <td class="r">${fmtSmart(l.value)}</td><td class="r"><button class="link" data-irm="${esc(l.id)}">Remove</button></td></tr>`).join('')}
    <tr><td class="dim" colspan="3">${I.lines.length} item${I.lines.length === 1 ? '' : 's'}</td><td class="r"><b>${fmtDiv(I.value)}</b></td><td></td></tr>`;
  tbl.querySelectorAll('.st-iq').forEach((i) => i.addEventListener('change', () => window.api.stashUpdateItem(i.dataset.id, { qty: Number(i.value) })));
  tbl.querySelectorAll('.st-id').forEach((i) => i.addEventListener('change', () => window.api.stashUpdateItem(i.dataset.id, { div: i.value === '' ? null : Number(i.value) })));
  tbl.querySelectorAll('[data-irm]').forEach((b) => b.addEventListener('click', () => window.api.stashRemoveItem(b.dataset.irm)));
}
$('#stAdd').addEventListener('click', async () => {
  const name = $('#stNewName').value.trim();
  if (!name) { $('#stNewName').focus(); return; }
  await window.api.stashAddItem({ name, qty: Number($('#stNewQty').value) || 1, div: $('#stNewDiv').value === '' ? null : Number($('#stNewDiv').value), priceFrom: 'manual' });
  $('#stNewName').value = ''; $('#stNewDiv').value = ''; $('#stNewQty').value = '1';
});

// ---------- feed ----------
function stFeed() {
  const f = st.feed || [];
  if (!f.length) { $('#stFeed').innerHTML = '<div class="dim">Changes between scans show up here, e.g. "+3 Divine Orb".</div>'; return; }
  $('#stFeed').innerHTML = f.slice(0, 40).map((c) => `<div class="feed-row"><span class="dim small">${esc(ago(c.t))}</span>
    <span class="${c.delta > 0 ? 'up' : 'down'}">${c.delta > 0 ? '+' : '−'}${Math.abs(c.delta).toLocaleString()}</span> ${esc(c.name)}
    <span class="dim">${c.div != null ? `(${signed(c.div, fmtSmart)})` : ''}${c.manual ? ' · edited' : ''}</span></div>`).join('');
}

// ---------- actions ----------
async function stDoScan(o) {
  $('#stMsg').textContent = 'Reading your screen… (the tab must be open in game)';
  const r = await window.api.stashScan(o);
  $('#stMsg').textContent = r.ok
    ? `${r.label}: ${fmtDiv(r.value)}${r.first ? ' (first scan of this tab)' : r.delta ? ` · ${signed(r.delta)} since last scan` : ' · no change'}${r.unreadable.length ? ` · ${r.unreadable.length} count${r.unreadable.length === 1 ? '' : 's'} unreadable` : ''}`
    : r.reason;
}
$('#stScan').addEventListener('click', () => stDoScan());
$('#stRecal').addEventListener('click', () => stDoScan({ recalibrate: true }));
$('#stPrices').addEventListener('click', async () => {
  $('#stOptMsg').textContent = 'Loading prices…';
  const r = await window.api.stashPrices();
  $('#stOptMsg').textContent = r.ok ? `${r.count} prices loaded${r.failed.length ? ` (couldn't load: ${r.failed.join(', ')})` : ''}.` : `Couldn't load prices: ${r.error}`;
});
$('#stSession').addEventListener('click', () => window.api.stashResetSession());
$('#stCsv').addEventListener('click', async () => { const r = await window.api.stashExportCsv(); if (r.ok) { $('#stOptMsg').textContent = 'Saved.'; window.api.showFile(r.file); } });
$('#stDebug').addEventListener('click', async () => {
  const r = await window.api.stashSaveDebug();
  $('#stOptMsg').textContent = r.ok ? 'Saved. Send this picture if the reader gets a tab wrong.' : r.error;
  if (r.ok) window.api.showFile(r.file);
});
$('#stHotkey').addEventListener('keydown', (e) => {
  e.preventDefault();
  const acc = toAccelerator(e);
  if (acc) { $('#stHotkey').value = acc; $('#stHotkeyMsg').textContent = 'Click Save to use it.'; }
});
$('#stHotkeySave').addEventListener('click', async () => {
  const r = await window.api.stashSetHotkey($('#stHotkey').value.trim());
  $('#stHotkeyMsg').textContent = r.ok ? `Saved: ${r.accelerator || 'off'}` : `That hotkey is taken${r.error ? ` (${r.error})` : ''}.`;
  stLoad();
});
$('#stHotkeyOff').addEventListener('click', async () => { await window.api.stashSetHotkey(''); $('#stHotkey').value = ''; $('#stHotkeyMsg').textContent = 'Scan hotkey off.'; stLoad(); });

window.api.onStashChanged(() => stLoad());
document.querySelector('.tabs button[data-tab="stash"]').addEventListener('click', () => stLoad());
setInterval(() => { if (document.querySelector('#tab-stash').classList.contains('active')) stLoad(); }, 60000);
stLoad();
