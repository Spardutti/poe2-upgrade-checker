'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 1) => { const r = Math.round(n * 10 ** d) / 10 ** d; return (r > 0 ? '+' : '') + r; };
let data = null;

function label(key, diff) {
  let first = true;
  const t = key.includes('#') ? key.replace(/#/g, () => { if (first) { first = false; return fmt(diff); } return '…'; }) : `${fmt(diff)} ${key}`;
  return t.replace(/^\+\+/, '+').replace(/^\+-/, '-');
}

const VERDICT = {
  upgrade: ['UPGRADE', 'up'], downgrade: ['DOWNGRADE', 'down'], same: ['SIDEGRADE', 'same'],
  new: ['EMPTY SLOT', 'new'], equipped: ['EQUIPPED', 'same'],
};

function dual(p) {
  const a = Number(p.amount); const d = data.divineRate;
  if (p.currency === 'divine') return `≈ ${Math.round(a * d).toLocaleString('en')} ex`;
  if (p.currency === 'exalted') return `≈ ${Math.round((a / d) * 100) / 100} div`;
  return '';
}

const num = (v) => (v == null || Number.isNaN(Number(v)) ? -1e9 : Number(v)); // 0 is a real value

function sorted(list) {
  const mode = $('#sort').value;
  const by = {
    upgrade: (a, b) => num(b.compare && b.compare.delta) - num(a.compare && a.compare.delta),
    value: (a, b) => ((b.valuePerDiv != null ? b.valuePerDiv : -1e9) - (a.valuePerDiv != null ? a.valuePerDiv : -1e9)),
    price: (a, b) => ((a.priceEx != null ? a.priceEx : 1e15) - (b.priceEx != null ? b.priceEx : 1e15)),
    gear: (a, b) => ((b.gear && b.gear.score != null ? b.gear.score : -1) - (a.gear && a.gear.score != null ? a.gear.score : -1)),
    site: () => 0,
  }[mode];
  let out = list.map((x, i) => ({ ...x, _i: i }));
  if ($('#onlyUp').checked) out = out.filter((x) => x.compare && (x.compare.verdict === 'upgrade' || x.compare.verdict === 'new'));
  return out.sort((a, b) => by(a, b) || a._i - b._i);
}

function card(x) {
  const it = x.item;
  const c = x.compare;
  const [vt, vc] = c ? (VERDICT[c.verdict] || VERDICT.same) : ['?', 'same'];
  const lines = (it ? it.lines : []).filter((l) => l.tag !== 'info');
  const mods = lines.map((l) => `<div class="mod ${esc(l.tag)}">${esc(l.text)}</div>`).join('');
  const gearMode = c && c.scoreMode === 'gear';
  const rows = c ? c.rows.filter((r) => r.diff).slice(0, 6).map((r) => {
    const useful = gearMode ? r.useful > 0 : !!r.weight;
    const cls = !useful ? 'unweighted' : (gearMode ? r.diff > 0 : r.impact > 0) ? 'pos' : 'neg';
    return `<span class="chg ${cls}">${esc(label(r.key, r.diff))}</span>`;
  }).join('') : '';
  const value = x.valuePerDiv != null && c && c.delta > 0 ? `<span class="value" title="${gearMode ? 'Gear score points gained' : 'Upgrade score'} per divine spent">${fmt(x.valuePerDiv, 1)} / div</span>` : '';
  return `<article class="listing">
    <div class="l-top">
      <div>
        <div class="name ${esc(((it && it.rarity) || '').toLowerCase())}">${esc(it ? it.name : 'Unreadable listing')}</div>
        <div class="dim">${esc(it && it.baseType !== it.name ? it.baseType : '')}${it && it.itemLevel ? ` · ilvl ${it.itemLevel}` : ''}</div>
      </div>
      <div class="l-price">
        <div class="price">${esc(x.priceText)}</div>
        ${x.price && data.divineRate ? `<div class="dim">${esc(dual(x.price))}</div>` : ''}
        <div class="dim">${x.instant ? 'Instant buyout' : `${x.online ? '<span class="dot on"></span>online' : '<span class="dot"></span>offline'} · ${esc(x.seller)}`}</div>
      </div>
    </div>
    ${c ? `<div class="verdict ${vc}"><span class="badge">${vt}</span><span class="score">${c.verdict === 'new' || c.delta == null ? '' : gearMode ? `${esc(fmt(c.delta, 0))} <small>gear score</small>` : esc(fmt(c.delta))}${!gearMode && c.pct != null && c.verdict !== 'equipped' ? ` <small>(${esc(fmt(c.pct))}%)</small>` : ''}</span>${value}<span class="dim">vs ${esc((c.replacing || []).join(' + ') || c.targetSlot)}</span></div>` : ''}
    ${x.gear && x.gear.score != null ? `<div class="gear"><span class="gs g-${esc(x.gear.grade)}">${x.gear.score} ${esc(x.gear.grade)}</span> <span>Gear score${x.gearEquipped != null ? ` · yours ${x.gearEquipped} <b class="${x.gear.score > x.gearEquipped ? 'pos' : x.gear.score < x.gearEquipped ? 'neg' : ''}">(${x.gear.score - x.gearEquipped > 0 ? '+' : ''}${x.gear.score - x.gearEquipped})</b>` : ''}</span>${x.gear.missing && x.gear.missing.length ? ` <span class="dim">missing ${esc(x.gear.missing.join(', '))}</span>` : ''}</div>` : ''}
    ${rows ? `<div class="chgs">${rows}</div>` : ''}
    <details><summary>Item mods</summary>${mods}</details>
    <div class="actions">
      ${x.instant && x.hideoutToken && data.signedIn ? `<button class="primary" data-hideout="${esc(x.id)}" title="Asks the trade site to take you to the seller's hideout (you're signed in)">Travel to hideout</button>` : ''}
      ${x.whisper ? `<button class="primary" data-whisper="${esc(x.id)}" title="Copies the seller's whisper – paste it in game chat with Enter, Ctrl+V">Copy whisper</button>` : `<button class="primary" data-site="1" title="Instant buyout listings are bought on the trade site">Buy on trade site</button>${x.pos ? ` <span class="dim">it's #${x.pos} on the trade site page</span>` : ''}`}
    </div>
  </article>`;
}

function render() {
  if (!data) return;
  $('#title').textContent = data.title;
  $('#sub').textContent = `${data.league} · ${data.total} listing${data.total === 1 ? '' : 's'} · showing ${data.shown}${data.divineRate ? ` · 1 div ≈ ${data.divineRate} ex` : ''}`;
  $('#note').textContent = data.note || '';
  if (data.priceSummary) {
    $('#priceBanner').classList.remove('hidden');
    $('#priceBanner').innerHTML = `Cheapest <b>${esc(data.priceSummary.cheapest)}</b> · typical <b>${esc(data.priceSummary.typical)}</b> <span class="dim">(from ${data.priceSummary.count} priced listings)</span>`;
  } else $('#priceBanner').classList.add('hidden');
  $('#save').textContent = data.saved ? '★ Saved' : '☆ Save search';
  $('#save').disabled = !!data.saved;
  const list = sorted(data.listings);
  $('#list').innerHTML = list.map(card).join('') || '<div class="note">No listings match these filters.</div>';
  $('#more').classList.toggle('hidden', !data.more);
  document.querySelectorAll('[data-whisper]').forEach((b) => b.addEventListener('click', () => {
    const x = data.listings.find((l) => l.id === b.dataset.whisper);
    window.api.copyText(x.whisper);
    b.textContent = 'Copied – paste in game chat';
  }));
  document.querySelectorAll('[data-site]').forEach((b) => b.addEventListener('click', () => window.api.openUrl(data.url)));
  document.querySelectorAll('[data-hideout]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = 'Asking the trade site…';
    const r = await window.api.hideout(b.dataset.hideout);
    b.disabled = false;
    b.textContent = r.ok ? 'Sent – check the game' : 'Travel to hideout';
    if (!r.ok) { const n = document.createElement('span'); n.className = 'note'; n.textContent = ' ' + r.error; b.after(n); }
  }));
}

window.api.onResults((d) => {
  data = d;
  // price checks read best cheapest-first; upgrade searches best-upgrade-first
  $('#sort').value = d.mode === 'price' ? 'price' : 'upgrade';
  render();
  window.scrollTo(0, 0);
});
$('#sort').addEventListener('change', render);
$('#onlyUp').addEventListener('change', render);
$('#site').addEventListener('click', () => data && window.api.openUrl(data.url));
$('#save').addEventListener('click', async () => {
  const r = await window.api.saveSearch(data.title);
  if (r && r.ok) { data.saved = true; render(); }
});
$('#more').addEventListener('click', async () => {
  $('#more').disabled = true; $('#moreMsg').textContent = 'Loading…';
  const d = await window.api.resultsMore();
  $('#more').disabled = false;
  if (d && d.error) { $('#moreMsg').textContent = d.error; return; }
  $('#moreMsg').textContent = '';
  if (d) { data = d; render(); }
});
window.api.onChanged(async () => { const d = await window.api.resultsRescore(); if (d) { data = d; render(); } });

// Esc hides the results window; bring it back with the results hotkey (Ctrl+Shift+D) or a new search.
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.api.hideResults(); });
