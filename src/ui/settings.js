'use strict';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let state = null;

document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
}));

async function load() {
  state = await window.api.getState();
  renderSlots();
  renderWeights();
  $('#weightsJson').value = JSON.stringify(state.weights, null, 2);
  $('#autoHide').value = state.settings.autoHideSeconds;
  $('#paused').checked = !!state.settings.paused;
  loadBudget();
  renderIgnore();
  renderSaved();
  $('#buildSel').innerHTML = (state.builds || []).map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('') + '<option value="off">None – score by my own stat weights</option>';
  $('#buildSel').value = state.settings.build || state.defaultBuild;
  // "By my weights" only makes sense when you score by stat weights (build turned off)
  $('#findQuick').classList.toggle('hidden', state.settings.build !== 'off');
  const bd = (state.builds || []).find((b) => b.id === $('#buildSel').value);
  $('#buildHelp').textContent = bd ? bd.summary + ' Ignored stats (Find upgrades page) are left out of the score.' : 'Gear score is turned off.';
  $('#popupPosition').value = state.settings.popupPosition || 'cursor';
  $('#uiScale').value = String(state.settings.uiScale || 1);
  $('#popupDetail').value = state.settings.popupDetail || 'compact';
  $('#colorblind').checked = !!state.settings.colorblind;
  document.body.classList.toggle('cb', !!state.settings.colorblind);
  if (document.activeElement !== $('#resultsHotkey')) $('#resultsHotkey').value = state.settings.resultsHotkey || 'Ctrl+Shift+D';
  renderSetup();
  renderProfiles();
  renderResists();
  renderBuildEditor();
  $('#startWithWindows').checked = !!state.settings.startWithWindows;
  if (state.platform === 'linux') { $('#startWithLabel').textContent = 'Start when I log in'; if (state.dataDir) $('#dataDirText').textContent = state.dataDir; }
  $('#openSettingsOnStart').checked = state.settings.openSettingsOnStart !== false;
  $('#advancedCopy').checked = !!state.settings.advancedCopy;
  $('#watchClipboard').checked = state.settings.watchClipboard !== false;
  const hs = state.hotkeyStatus || {};
  if (document.activeElement !== $('#hotkey')) $('#hotkey').value = state.settings.hotkey || 'F2';
  $('#hotkeyMsg').textContent = hs.ok ? `Active: ${hs.accelerator}` : (hs.error || 'Hotkey not registered.');
  $('#hotkeyLine').innerHTML = hs.ok
    ? `In game: hover an item and press <b>${esc(hs.accelerator)}</b>.<br>You can close this window; the app keeps running in the tray.`
    : `<span class="note">Hotkey isn't working: ${esc(hs.error || 'not registered')} – change it in Settings.</span>`;
  renderPob(false);
  renderAccount();
  renderModeHints();
}

function summary(item) {
  const top = (item.lines || []).filter((l) => l.key).slice(0, 4).map((l) => l.text).join(' · ');
  return top;
}

function renderGearSummary() {
  const gs = state.gearScores || {};
  const main = state.mainSlots || [];
  const rated = Object.entries(gs).filter(([slot, g]) => g && g.score != null && (!main.length || main.includes(slot)));
  if (!rated.length || state.settings.build === 'off') { $('#gearSummary').innerHTML = ''; return; }
  const avg = Math.round(rated.reduce((a, [, g]) => a + g.score, 0) / rated.length);
  const grade = avg >= 85 ? 'S' : avg >= 70 ? 'A' : avg >= 55 ? 'B' : avg >= 40 ? 'C' : 'D';
  const weakest = rated.slice().sort((a, b) => a[1].score - b[1].score).slice(0, 3);
  const build = (state.builds || []).find((b) => b.id === (state.settings.build || state.defaultBuild));
  $('#gearSummary').innerHTML = `<div class="gear"><span class="gs g-${grade}">${avg} ${grade}</span> <b>Overall gear score</b> <span class="dim">for ${esc(build ? build.name : 'your build')}${state.pobOn ? ' – a rough guide; verdicts come from Path of Building' : ''}</span></div>
    <div>Upgrade first: ${weakest.map(([slot, g]) => `<button class="link" data-quick2="${esc(slot)}">${esc(slot)} (${g.score})</button>`).join(' · ')}
    <span class="note" id="gearSumMsg"></span></div>`;
  document.querySelectorAll('[data-quick2]').forEach((b) => b.addEventListener('click', async () => {
    $('#gearSumMsg').textContent = ` Searching upgrades for ${b.dataset.quick2}…`;
    window.showSearchResult($('#gearSumMsg'), await window.api.quickFind(b.dataset.quick2, 'upgrade'));
  }));
}

function renderSlots() {
  renderGearSummary();
  const gs = state.gearScores || {};
  const main = state.mainSlots || state.slots;
  const extras = state.slots.filter((s) => !main.includes(s));
  const showExtras = extras.filter((s) => state.equipped[s]);
  const extraOpen = window.__extraOpen != null ? window.__extraOpen : showExtras.length > 0;
  const row = (s) => {
    const it = state.equipped[s];
    const g = gs[s];
    const gcell = !it ? '' : !g ? '' : g.score == null ? `<span class="dim">${g.unique ? 'unique' : g.unrated === 'unidentified' ? 'unidentified' : 'not rated'}</span>`
      : `<span class="gs g-${esc(g.grade)}" title="${esc((g.missing || []).length ? 'Missing: ' + g.missing.join(', ') : '')}">${g.score} ${esc(g.grade)}</span>`;
    return `<tr class="slotrow"><td>${esc(s)}</td><td>${gcell}</td>
      <td>${it ? `<b>${esc(it.name)}</b> <span class="dim">${esc(it.baseType !== it.name ? it.baseType : '')}</span><div class="dim">${esc(summary(it))}</div>`
        : '<span class="empty">not set</span>'}</td>
      <td class="nowrap">${it ? `<button data-quick="${esc(s)}">Find upgrades</button>
        <button data-custom="${esc(s)}">Custom…</button>
        <button data-clear="${esc(s)}">Clear</button>` : ''}${it && it.fromPob ? '<div class="dim small">from PoB</div>' : ''}</td></tr>`;
  };
  $('#slots').innerHTML = '<tr><th>Slot</th><th>Gear score</th><th>Item</th><th></th></tr>' + main.map(row).join('')
    + `<tr><td colspan="4"><button class="link" id="extraToggle">${extraOpen ? '▾' : '▸'} Weapon swap, flasks, charms &amp; jewels (${showExtras.length} saved)</button></td></tr>`
    + (extraOpen ? extras.map(row).join('') : '')
    + '<tr><td colspan="4" class="note" id="gearMsg"></td></tr>';
  $('#extraToggle').addEventListener('click', () => { window.__extraOpen = !extraOpen; renderSlots(); });
  document.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', async () => {
    await window.api.clearSlot(b.dataset.clear); load();
  }));
  // the answer shows right under the button you clicked (the table's last row is often off screen)
  document.querySelectorAll('[data-quick]').forEach((b) => b.addEventListener('click', async () => {
    document.querySelectorAll('.slot-msg').forEach((x) => x.remove());
    const msg = document.createElement('div'); msg.className = 'note slot-msg'; msg.textContent = 'Searching the trade site…';
    b.parentNode.appendChild(msg);
    document.querySelectorAll('[data-quick]').forEach((x) => { x.disabled = true; });
    try { window.showSearchResult(msg, await window.api.quickFind(b.dataset.quick, 'upgrade')); } finally {
      document.querySelectorAll('[data-quick]').forEach((x) => { x.disabled = false; });
    }
  }));
  document.querySelectorAll('[data-custom]').forEach((b) => b.addEventListener('click', () => openFind(b.dataset.custom)));
}

// ---------- Find upgrade tab ----------

let tradeInfo = null;
let findRows = []; // { key, current, keep, min, max }

let rowsEdited = false;
let recent = [];
const toTarget = (v) => (v && v.startsWith('item:') ? { itemId: v.slice(5) } : v);
const fromTarget = (t) => (t && typeof t === 'object' && t.itemId ? 'item:' + t.itemId : t);

function showTab(name) {
  // switch tabs without firing the tab button's click handler
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
}

async function ensureTradeInfo(force) {
  if (tradeInfo && !force) return tradeInfo;
  $('#findMsg').textContent = 'Loading trade site data…';
  tradeInfo = await window.api.tradeData(!!force);
  if (!tradeInfo.ok) {
    $('#findMsg').textContent = 'Could not reach the trade site: ' + tradeInfo.error;
    const failed = tradeInfo; tradeInfo = null; // try again next time
    return failed;
  }
  $('#findMsg').textContent = '';
  const saved = state && state.settings.league;
  const leagues = tradeInfo.leagues.length ? tradeInfo.leagues : ['Standard'];
  $('#findLeague').innerHTML = leagues.map((l) => `<option ${l === saved ? 'selected' : ''}>${esc(l)}</option>`).join('');
  $('#tradeStats').innerHTML = tradeInfo.statTexts.map((t) => `<option value="${esc(t)}">`).join('');
  return tradeInfo;
}

async function fillFindSlots(selected) {
  recent = await window.api.recentItems();
  const opts = state.slots.filter((s) => state.equipped[s])
    .map((s) => `<option value="${esc(s)}">Equipped ${esc(s)} – ${esc(state.equipped[s].name)}</option>`);
  recent.forEach((r, i) => opts.push(`<option value="item:${esc(r.id)}">${i === 0 ? 'Just copied' : 'Copied'}: ${esc(r.name)} (${esc(r.itemClass)})</option>`));
  $('#findSlot').innerHTML = opts.join('') || '<option value="">Nothing saved or copied yet</option>';
  let want = fromTarget(selected);
  if (want === '__last') want = recent[0] ? 'item:' + recent[0].id : '';
  if (want && [...$('#findSlot').options].some((o) => o.value === want)) $('#findSlot').value = want;
}

async function buildFindRows() {
  rowsEdited = false;
  $('#findNotice').textContent = '';
  const { item: it, rows } = await window.api.findRows(toTarget($('#findSlot').value));
  if (!it) {
    $('#findItem').textContent = 'No item here yet. Save your equipped gear first (My gear page), or copy an item in game.';
    findRows = [];
  } else {
    $('#findItem').innerHTML = `<b>${esc(it.name)}</b> ${esc(it.baseType !== it.name ? it.baseType : '')} <span class="dim">(${esc(it.itemClass)}${it.rarity ? ', ' + esc(it.rarity) : ''})</span>`;
    const scale = Number($('#minScale').value) || 1;
    findRows = rows.map((x) => ({
      key: x.key, source: x.source, current: x.value,
      // runes/enchants are unticked: a buyer can socket those themselves
      ignored: isIgnoredKey(x.key),
      keep: x.source !== 'socket' && !isIgnoredKey(x.key) && !/Runic Ward|Attacks per Second|Critical Hit/.test(x.key),
      min: scaledMin(x.key, x.value, scale), max: '',
    }));
    const order = { base: 0, mod: 1, implicit: 2, socket: 3 };
    findRows.sort((a, b) => (order[a.source] - order[b.source]) || a.key.localeCompare(b.key));
  }
  renderFindRows();
}

function scaledMin(key, value, scale) {
  if (value == null || value === '') return '';
  const f = key.startsWith('[') ? 0.9 * scale : scale;
  const v = value * f;
  if (value < 0) return Math.round(v * 100) / 100;
  if (value >= 1 && v < 1) return 1;
  return value >= 3 ? Math.floor(v) : Math.round(v * 100) / 100;
}

function renderFindRows() {
  $('#findStats').innerHTML = '<tr><th>Keep</th><th>Stat</th><th>Yours</th><th>Min</th><th>Max</th></tr>' + findRows.map((r, i) => `
    <tr>
      <td><input type="checkbox" data-i="${i}" data-f="keep" ${r.keep ? 'checked' : ''}></td>
      <td>${esc(r.key)}${r.current == null ? ` <span class="dim">(added${r.idType ? ', ' + esc({ pseudo: 'total', augment: 'rune' }[r.idType] || r.idType) : ''})</span>` : r.ignored ? ' <span class="dim">(ignored)</span>' : r.source === 'socket' ? ' <span class="dim">(rune)</span>' : r.source === 'implicit' ? ' <span class="dim">(implicit)</span>' : ''}</td>
      <td class="dim">${r.current == null ? '' : esc(r.current)}</td>
      <td><input type="number" data-i="${i}" data-f="min" value="${esc(r.min)}"></td>
      <td><input type="number" data-i="${i}" data-f="max" value="${esc(r.max)}"></td>
    </tr>`).join('');
  document.querySelectorAll('#findStats input').forEach((inp) => inp.addEventListener('change', () => {
    const r = findRows[Number(inp.dataset.i)];
    rowsEdited = true;
    if (inp.dataset.f === 'keep') r.keep = inp.checked; else r[inp.dataset.f] = inp.value;
  }));
}

async function openFind(target) {
  showTab('find');
  state = await window.api.getState();
  await ensureTradeInfo(false);
  $('#findStatus').value = state.settings.status || 'available';
  await fillFindSlots(target || $('#findSlot').value || (state.slots.find((s) => state.equipped[s])) || '__last');
  await buildFindRows();
}

function searchExtra() {
  return { league: $('#findLeague').value || undefined, status: $('#findStatus').value };
}

$('#findSlot').addEventListener('change', buildFindRows);
$('#minScale').addEventListener('change', () => {
  const scale = Number($('#minScale').value) || 1;
  findRows.forEach((r) => { if (r.current != null) r.min = scaledMin(r.key, r.current, scale); });
  renderFindRows();
});
$('#tickAll').addEventListener('click', () => { findRows.forEach((r) => { r.keep = true; }); rowsEdited = true; renderFindRows(); });
$('#tickNone').addEventListener('click', () => { findRows.forEach((r) => { r.keep = false; }); rowsEdited = true; renderFindRows(); });
$('#tradeRefresh').addEventListener('click', async () => { await ensureTradeInfo(true); });
$('#addTradeBtn').addEventListener('click', () => {
  const key = $('#addTradeStat').value.trim();
  if (!key) return;
  findRows.push({ key, current: null, keep: true, min: $('#addTradeMin').value, max: '' });
  rowsEdited = true;
  $('#addTradeStat').value = ''; $('#addTradeMin').value = '';
  renderFindRows();
});
async function runFind(fn, msgSel) {
  const msg = $(msgSel || '#findMsg');
  await window.api.setSetting('budget', readBudget());
  $('#findMsg').textContent = ''; $('#findMsg2').textContent = '';
  msg.textContent = 'Searching the trade site…';
  const btns = [...document.querySelectorAll('.find-actions button, #findSearch')];
  btns.forEach((b) => { b.disabled = true; });
  try { window.showSearchResult(msg, await fn()); } finally {
    btns.forEach((b) => { b.disabled = false; });
  }
}
$('#findSearch').addEventListener('click', () => runFind(() => {
  const picks = findRows.filter((r) => r.keep).map((r) => ({ key: r.key, min: r.min, max: r.max, source: r.source, id: r.id, idType: r.idType }));
  if (!picks.length) return Promise.resolve({ ok: false, error: 'Tick at least one stat first.' });
  return window.api.tradeSearch({
    target: toTarget($('#findSlot').value), picks, budget: readBudget(),
    matchBase: $('#findSameBase').checked, ...searchExtra(),
  });
}, '#findMsg2'));
$('#findGear').addEventListener('click', () => runFind(() => window.api.quickFind(toTarget($('#findSlot').value), 'upgrade', searchExtra())));
$('#findSimilar').addEventListener('click', () => runFind(() => window.api.quickFind(toTarget($('#findSlot').value), 'similar', searchExtra())));
$('#findQuick').addEventListener('click', () => runFind(() => window.api.quickFind(toTarget($('#findSlot').value), 'weights', searchExtra())));
$('#findStatus').addEventListener('change', () => window.api.setSetting('status', $('#findStatus').value));
$('#findLeague').addEventListener('change', () => window.api.setSetting('league', $('#findLeague').value));
document.querySelector('.tabs button[data-tab="find"]').addEventListener('click', () => openFind(null));
window.api.onFindUpgrade((target) => { load().then(() => openFind(target)); });

// A new item was copied: keep the Find tab in step with it.
window.api.onItemCopied(async (info) => {
  const wasLatest = !$('#findSlot').value || (recent[0] && $('#findSlot').value === 'item:' + recent[0].id);
  state = await window.api.getState();
  const keepSel = $('#findSlot').value;
  await fillFindSlots(wasLatest && !rowsEdited ? { itemId: info.id } : keepSel);
  if (!document.querySelector('#tab-find').classList.contains('active')) return;
  if (wasLatest && !rowsEdited) { await buildFindRows(); return; }
  $('#findNotice').innerHTML = `You copied <b>${esc(info.name)}</b>. `;
  const b = document.createElement('button');
  b.className = 'link'; b.textContent = 'Show it';
  b.addEventListener('click', async () => { $('#findSlot').value = 'item:' + info.id; await buildFindRows(); });
  $('#findNotice').appendChild(b);
});

function renderWeights() {
  const filter = $('#filter').value.trim().toLowerCase();
  const only = $('#onlyWeighted').checked;
  const keys = Array.from(new Set([...Object.keys(state.weights), ...state.seenStats]));
  keys.sort((a, b) => (state.weights[b] ? 1 : 0) - (state.weights[a] ? 1 : 0) || a.localeCompare(b));
  const rows = keys
    .filter((k) => !filter || k.toLowerCase().includes(filter))
    .filter((k) => !only || state.weights[k])
    .map((k) => `<tr><td>${esc(k)}</td><td><input type="number" step="0.1" data-key="${esc(k)}" value="${state.weights[k] || ''}" placeholder="0"></td></tr>`)
    .join('');
  $('#weights').innerHTML = '<tr><th>Stat (# = the number)</th><th>Weight</th></tr>' + (rows || '<tr><td colspan="2" class="dim">No stats match.</td></tr>');
  document.querySelectorAll('#weights input').forEach((inp) => inp.addEventListener('change', async () => {
    await window.api.setWeight(inp.dataset.key, inp.value);
    state = await window.api.getState();
    $('#weightsJson').value = JSON.stringify(state.weights, null, 2);
  }));
}

$('#filter').addEventListener('input', renderWeights);
$('#onlyWeighted').addEventListener('change', renderWeights);
$('#resetWeights').addEventListener('click', async () => { await window.api.resetWeights(); load(); });
$('#addStat').addEventListener('click', async () => {
  const key = ($('#filter').value || '').trim();
  if (!key) { $('#filter').placeholder = 'Type the stat here first, e.g. #% increased Spell Damage'; $('#filter').focus(); return; }
  await window.api.setWeight(key, 1);
  load();
});
$('#exportW').addEventListener('click', () => { $('#weightsJson').value = JSON.stringify(state.weights, null, 2); });
$('#importW').addEventListener('click', async () => {
  try {
    const obj = JSON.parse($('#weightsJson').value);
    await window.api.replaceWeights(obj);
    $('#importMsg').textContent = 'Imported.';
    load();
  } catch (e) { $('#importMsg').textContent = 'That isn\'t valid JSON.'; }
});

$('#testBtn').addEventListener('click', async () => {
  const text = $('#testText').value;
  const r = await window.api.evaluateText(text);
  window.renderComparison($('#testResult'), r, { itemText: text, onChange: () => { load(); $('#testBtn').click(); } });
});

$('#autoHide').addEventListener('change', () => window.api.setSetting('autoHideSeconds', Math.max(2, Number($('#autoHide').value) || 12)));
$('#paused').addEventListener('change', () => window.api.setSetting('paused', $('#paused').checked));

window.api.onChanged(load);
load();

// ---------- hotkey capture ----------
function toAccelerator(e) {
  const k = e.key;
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return null;
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let key;
  if (/^F\d{1,2}$/.test(k)) key = k;
  else if (k.length === 1 && /[a-z0-9]/i.test(k)) key = k.toUpperCase();
  else if (e.code && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (e.code && /^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (k === ' ') key = 'Space';
  else key = { Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', '`': '`' }[k];
  if (!key) return null;
  if (!parts.length && !/^F\d/.test(key)) return null; // plain letters would block typing everywhere
  return [...parts, key].join('+');
}
$('#hotkey').addEventListener('keydown', (e) => {
  e.preventDefault();
  const acc = toAccelerator(e);
  if (acc) { $('#hotkey').value = acc; $('#hotkeyMsg').textContent = 'Click Save to use it.'; }
  else if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) $('#hotkeyMsg').textContent = 'Use a modifier (Ctrl/Alt) plus a key, or an F-key.';
});
$('#hotkeySave').addEventListener('click', async () => {
  const res = await window.api.setHotkey($('#hotkey').value.trim());
  await load();
  $('#hotkeyMsg').textContent = res.ok ? `Saved. Active: ${res.accelerator}.${res.warning ? ' ' + res.warning : ''}` : res.error;
});
$('#advancedCopy').addEventListener('change', () => window.api.setSetting('advancedCopy', $('#advancedCopy').checked));
$('#watchClipboard').addEventListener('change', () => window.api.setSetting('watchClipboard', $('#watchClipboard').checked));
$('#testPopup').addEventListener('click', () => window.api.testPopup());
$('#openLog').addEventListener('click', () => window.api.openLog());

// ---------- budget ----------
function readBudget() {
  const n = (id) => { const v = Number($(id).value.trim()); return $(id).value.trim() && v > 0 ? v : null; };
  let min = n('#budgetMin'); let max = n('#budgetMax');
  if (min == null && max == null) return null;
  if (min != null && max != null && min > max) [min, max] = [max, min];
  return { min, max, currency: $('#budgetCurrency').value, divineRate: $('#divineRate').value ? Number($('#divineRate').value) : null };
}
function budgetHelp() {
  const b = readBudget();
  $('#rateWrap').classList.toggle('hidden', $('#budgetCurrency').value !== 'divine');
  if (!b) { $('#budgetHelp').textContent = 'No price limits. They apply to every trade search.'; return; }
  const name = { divine: 'div', exalted: 'ex', chaos: 'chaos' }[b.currency];
  const range = b.min != null && b.max != null ? `between ${b.min} and ${b.max} ${name}` : b.max != null ? `up to ${b.max} ${name}` : `at least ${b.min} ${name}`;
  let t;
  const f = (x) => Number(x).toLocaleString();
  // matches trade.priceFilter: the trade site's own "exalted equivalent" is far off the market rate
  if (b.currency === 'divine' && b.max != null && b.max <= 2 && b.divineRate) t = `Listings priced in exalts, ${range} (${b.min != null ? f(Math.ceil(b.min * b.divineRate)) + '–' : 'up to '}${f(Math.floor(b.max * b.divineRate))} ex at today's rate). At these prices almost everything is listed in exalts.`;
  else if (b.currency === 'divine') t = `Listings priced in Divine Orbs, ${range}. (Items priced only in exalts aren't included – at these prices almost everything is listed in divines.)`;
  else if (b.currency === 'exalted') t = `Listings priced in Exalted Orbs, ${range}.`;
  else t = `Only listings priced in Chaos Orbs, ${range}.`;
  if (b.min != null) t += ' Cheaper junk is filtered out.';
  $('#budgetHelp').textContent = t;
}
function loadBudget() {
  const b = state.settings.budget;
  if (document.activeElement && document.activeElement.closest && document.activeElement.closest('.filterbar')) return;
  $('#budgetMax').value = b && b.max != null ? b.max : '';
  $('#budgetMin').value = b && b.min != null ? b.min : '';
  $('#budgetCurrency').value = (b && b.currency) || 'divine';
  const auto = state.settings.autoRate !== false;
  $('#autoRate').checked = auto;
  $('#divineRate').readOnly = auto;
  $('#divineRate').value = auto ? (state.settings.divineRate || '') : ((b && b.divineRate) || state.settings.divineRate || '');
  budgetHelp();
}
function ago(t) {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}
async function showRate(force) {
  if (!$('#autoRate').checked) { $('#rateStatus').textContent = 'Using your own rate.'; return; }
  $('#rateStatus').textContent = 'Getting the latest Divine price from poe.ninja…';
  const r = await window.api.getRate(!!force);
  if (r.rate) { $('#divineRate').value = r.rate; budgetHelp(); }
  $('#rateStatus').textContent = r.ok
    ? `1 Divine ≈ ${r.rate} Exalted (${r.league || 'current league'}, poe.ninja, ${ago(r.at)}). Updates every hour.`
    : `Couldn't get the rate from poe.ninja (${r.error}).` + (r.rate ? ` Using the last known rate, ${r.rate} ex.` : ' Untick Auto and type the rate in.');
}
async function saveBudget() {
  budgetHelp();
  const b = readBudget();
  await window.api.setSetting('budget', b);
  if ($('#divineRate').value) await window.api.setSetting('divineRate', Number($('#divineRate').value));
}
['#budgetMin', '#budgetMax', '#budgetCurrency', '#divineRate'].forEach((id) => $(id).addEventListener('change', saveBudget));
$('#budgetMax').addEventListener('input', budgetHelp);
$('#budgetMin').addEventListener('input', budgetHelp);
$('#budgetClear').addEventListener('click', () => { $('#budgetMax').value = ''; $('#budgetMin').value = ''; saveBudget(); });

$('#autoRate').addEventListener('change', async () => {
  await window.api.setSetting('autoRate', $('#autoRate').checked);
  $('#divineRate').readOnly = $('#autoRate').checked;
  showRate(false);
});
$('#rateRefresh').addEventListener('click', () => showRate(true));
document.querySelector('.tabs button[data-tab="find"]').addEventListener('click', () => showRate(false));
window.api.onFindUpgrade(() => showRate(false));

// ---------- ignored stats ----------
function ignoreRulesNow() { return (state && state.settings.ignoreStats) || []; }
function presetTest(id, key) {
  const t = {
    res: /^#% to (Fire|Cold|Lightning|Chaos) Resistance$/, eleres: /^#% to (Fire|Cold|Lightning) Resistance$/,
    chaosres: /^#% to Chaos Resistance$/, attributes: /^# to (Strength|Dexterity|Intelligence)$/,
    life: /^# to maximum Life$/, mana: /^# to maximum Mana$/,
  }[id];
  return !!(t && t.test(key));
}
// same normal form as src/core/statnorm.js
const normStat = (t) => String(t).toLowerCase().replace(/\+/g, '').replace(/\b(total|to)\b/g, ' ').replace(/\s*\(local\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
function isIgnoredKey(key) { return ignoreRulesNow().some((r) => (r.id ? presetTest(r.id, key) : (r.key === key || normStat(r.key) === normStat(key)))); }

function renderIgnore() {
  const rules = ignoreRulesNow();
  const presetRows = (state.ignorePresets || []).map((p) => {
    const r = rules.find((x) => x.id === p.id);
    return `<tr><td><label><input type="checkbox" data-preset="${esc(p.id)}" ${r ? 'checked' : ''}> ${esc(p.label)}</label></td>
      <td><select data-mode="${esc(p.id)}" ${r ? '' : 'disabled'}>
        <option value="ignore" ${r && r.mode !== 'exclude' ? 'selected' : ''}>Ignore</option>
        <option value="exclude" ${r && r.mode === 'exclude' ? 'selected' : ''}>Exclude listings with it</option>
      </select></td><td></td></tr>`;
  });
  const keyRows = rules.filter((r) => r.key).map((r) => `<tr><td>${esc(r.key)}</td>
      <td><select data-keymode="${esc(r.key)}">
        <option value="ignore" ${r.mode !== 'exclude' ? 'selected' : ''}>Ignore</option>
        <option value="exclude" ${r.mode === 'exclude' ? 'selected' : ''}>Exclude listings with it</option>
      </select></td><td><button data-unignore="${esc(r.key)}">Remove</button></td></tr>`);
  $('#ignoreList').innerHTML = presetRows.join('') + keyRows.join('');
  $('#ignoreStatsList').innerHTML = (state.seenStats || []).filter((k) => !k.startsWith('[')).map((k) => `<option value="${esc(k)}">`).join('');
  document.querySelectorAll('#ignoreList [data-preset]').forEach((cb) => cb.addEventListener('change', () => {
    const id = cb.dataset.preset;
    const next = ignoreRulesNow().filter((r) => r.id !== id);
    if (cb.checked) next.push({ id, mode: document.querySelector(`[data-mode="${id}"]`).value || 'ignore' });
    saveIgnore(next);
  }));
  document.querySelectorAll('#ignoreList [data-mode]').forEach((sel) => sel.addEventListener('change', () => {
    saveIgnore(ignoreRulesNow().map((r) => (r.id === sel.dataset.mode ? { ...r, mode: sel.value } : r)));
  }));
  document.querySelectorAll('#ignoreList [data-keymode]').forEach((sel) => sel.addEventListener('change', () => {
    saveIgnore(ignoreRulesNow().map((r) => (r.key === sel.dataset.keymode ? { ...r, mode: sel.value } : r)));
  }));
  document.querySelectorAll('#ignoreList [data-unignore]').forEach((b) => b.addEventListener('click', () => {
    saveIgnore(ignoreRulesNow().filter((r) => r.key !== b.dataset.unignore));
  }));
}

async function saveIgnore(rules) {
  const saved = await window.api.setIgnore(rules);
  state.settings.ignoreStats = saved;
  renderIgnore();
  // keep the custom search rows in step (without losing other edits)
  findRows.forEach((r) => {
    const ig = isIgnoredKey(r.key);
    if (ig && !r.ignored) r.keep = false;
    if (!ig && r.ignored && r.source !== 'socket') r.keep = true;
    r.ignored = ig;
  });
  renderFindRows();
}

$('#ignoreAddBtn').addEventListener('click', () => {
  const key = $('#ignoreAdd').value.trim();
  if (!key) return;
  $('#ignoreAdd').value = '';
  if (ignoreRulesNow().some((r) => r.key === key)) return;
  saveIgnore([...ignoreRulesNow(), { key, mode: 'ignore' }]);
});

// ---------- stat database picker hooks ----------
window.__ignoreRules = () => ignoreRulesNow();
window.__saveIgnore = (rules) => saveIgnore(rules);
window.__weights = () => (state && state.weights) || {};
window.__afterWeight = async () => { state = await window.api.getState(); renderWeights(); };
function currentFindClass() {
  const sel = $('#findSlot') && $('#findSlot').value;
  if (!sel) return null;
  if (sel.startsWith('item:')) { const r = recent.find((x) => 'item:' + x.id === sel); return r && r.itemClass; }
  return state.equipped[sel] && state.equipped[sel].itemClass;
}
$('#addBrowse').addEventListener('click', () => window.openStatPicker({
  mode: 'search', itemClass: currentFindClass(),
  onPick: ({ text, id, kind, min }) => {
    findRows.push({ key: text, id, idType: kind, current: null, keep: true, min, max: '' });
    rowsEdited = true;
    renderFindRows();
  },
}));
$('#ignoreBrowse').addEventListener('click', () => window.openStatPicker({ mode: 'ignore', itemClass: currentFindClass() }));
$('#weightBrowse').addEventListener('click', () => window.openStatPicker({ mode: 'weight', query: $('#filter').value.trim() }));

// ---------- options: results & startup ----------

$('#startWithWindows').addEventListener('change', () => window.api.setSetting('startWithWindows', $('#startWithWindows').checked));
$('#openSettingsOnStart').addEventListener('change', () => window.api.setSetting('openSettingsOnStart', $('#openSettingsOnStart').checked));

// ---------- saved searches ----------
async function renderSaved() {
  const list = await window.api.savedList();
  const ago2 = (t) => (t ? ago(t) : '');
  $('#savedList').innerHTML = list.length ? '<tr><th>Search</th><th>Listings last time</th><th></th></tr>' + list.map((x) => `<tr>
      <td><b>${esc(x.name)}</b><div class="dim">${esc(x.league)}${x.itemClass ? ' · ' + esc(x.itemClass) : ''}</div></td>
      <td>${x.lastTotal != null ? esc(x.lastTotal) : '?'} <span class="dim">${esc(ago2(x.lastRun))}</span><div class="note" data-savedmsg="${esc(x.id)}"></div></td>
      <td class="nowrap"><label class="small"><input type="checkbox" data-alert="${esc(x.id)}" ${x.alert ? 'checked' : ''}> Alert</label> <button class="primary gilded" data-run="${esc(x.id)}">Run</button> <button data-del="${esc(x.id)}">Delete</button></td></tr>`).join('')
    : '<tr><td class="dim">No saved searches yet.</td></tr>';
  document.querySelectorAll('[data-run]').forEach((b) => b.addEventListener('click', async () => {
    const msg = document.querySelector(`[data-savedmsg="${b.dataset.run}"]`);
    msg.textContent = 'Searching…'; b.disabled = true;
    const r = await window.api.savedRun(b.dataset.run);
    b.disabled = false;
    if (!r.ok) { msg.textContent = r.error || 'Search failed.'; return; }
    const diff = r.prev != null && r.total != null ? r.total - r.prev : null;
    msg.textContent = r.total === 0 ? 'Nothing listed right now.' : `${r.total} listed${diff != null ? ` (${diff >= 0 ? '+' : ''}${diff} since last time)` : ''}.`;
    setTimeout(renderSaved, 1500);
  }));
  document.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => { await window.api.savedDelete(b.dataset.del); renderSaved(); }));
  document.querySelectorAll('[data-alert]').forEach((cb) => cb.addEventListener('change', async () => {
    await window.api.savedAlert(cb.dataset.alert, cb.checked);
    if (cb.checked && !Number($('#alertEvery').value)) { $('#alertEvery').value = '10'; await window.api.setSetting('alertEvery', 10); }
    renderAlertStatus();
  }));
  renderAlertStatus();
}
window.api.onSavedChanged(renderSaved);

// ---------- suggested weights ----------
$('#suggestBtn').addEventListener('click', async () => {
  const list = await window.api.suggestWeights();
  const box = $('#suggestBox');
  box.classList.remove('hidden');
  if (!list.length) { box.innerHTML = '<div class="note">Save your equipped gear first (My gear page) – the suggestions come from it.</div>'; return; }
  box.innerHTML = `<div class="help">Based on your equipped gear: each stat's typical roll is worth about 30 points, more if several of your items have it. You can tweak any number afterwards.</div>
    <table class="list"><tr><th>Stat</th><th>On items</th><th>Typical roll</th><th>Now</th><th>Suggested</th></tr>
    ${list.map((x) => `<tr><td>${esc(x.key)}</td><td>${x.slots}</td><td>${x.avg}</td><td class="dim">${state.weights[x.key] || '–'}</td><td><b>${x.weight}</b></td></tr>`).join('')}</table>
    <div class="row"><button class="primary" id="sugReplace">Use these weights</button><button id="sugMerge">Only add missing ones</button><button id="sugCancel">Cancel</button><span class="note" id="sugMsg"></span></div>`;
  $('#sugCancel').addEventListener('click', () => box.classList.add('hidden'));
  $('#sugReplace').addEventListener('click', async () => {
    const obj = {}; list.forEach((x) => { obj[x.key] = x.weight; });
    const backup = { ...state.weights };
    await window.api.replaceWeights(obj); await load();
    $('#sugMsg').innerHTML = 'Weights replaced. ';
    const u = document.createElement('button'); u.className = 'link'; u.textContent = 'Undo';
    u.addEventListener('click', async () => { await window.api.replaceWeights(backup); await load(); $('#sugMsg').textContent = 'Your previous weights are back.'; });
    $('#sugMsg').appendChild(u);
  });
  $('#sugMerge').addEventListener('click', async () => {
    const obj = { ...state.weights }; list.forEach((x) => { if (!obj[x.key]) obj[x.key] = x.weight; });
    await window.api.replaceWeights(obj); await load();
    $('#sugMsg').textContent = 'Added the missing weights; your existing ones were kept.';
  });
});

$('#buildSel').addEventListener('change', async () => { await window.api.setSetting('build', $('#buildSel').value); await load(); });

// ---------- popup / display options ----------
['popupPosition', 'uiScale', 'popupDetail'].forEach((k) => $('#' + k).addEventListener('change', async () => {
  const v = k === 'uiScale' ? Number($('#' + k).value) : $('#' + k).value;
  await window.api.setSetting(k, v);
  if (k === 'popupPosition') window.api.testPopup();
}));
$('#colorblind').addEventListener('change', async () => { await window.api.setSetting('colorblind', $('#colorblind').checked); document.body.classList.toggle('cb', $('#colorblind').checked); });
$('#resultsHotkey').addEventListener('keydown', (e) => {
  e.preventDefault();
  const acc = toAccelerator(e);
  if (acc) { $('#resultsHotkey').value = acc; $('#resultsHotkeyMsg').textContent = 'Click Save to use it.'; }
});
$('#resultsHotkeySave').addEventListener('click', async () => {
  await window.api.setSetting('resultsHotkey', $('#resultsHotkey').value.trim());
  const st = await window.api.getState();
  $('#resultsHotkeyMsg').textContent = st.resultsHotkeyOk === false ? `Saved, but ${$('#resultsHotkey').value.trim()} couldn't be registered – another app may use it.` : 'Saved.';
});
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => document.querySelector(`.tabs button[data-tab="${b.dataset.goto}"]`).click()));
window.api.onSettingsTab((tab) => {
  // price range, sellers and ignored stats now live on the Find upgrades page
  const focus = tab === 'search' ? '#ignoreCard' : null;
  if (tab === 'search') tab = 'find';
  const b = document.querySelector(`.tabs button[data-tab="${tab}"]`);
  if (b) b.click();
  if (focus) setTimeout(() => { const el = $(focus); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 150);
});

// Find tab extra buttons
$('#findCraft').addEventListener('click', () => runFind(() => window.api.quickFind(toTarget($('#findSlot').value), 'craft', searchExtra())));
$('#findPrice').addEventListener('click', () => runFind(() => window.api.priceCheck(toTarget($('#findSlot').value))));

// ---------- setup checklist + guide ----------
const SETUP_SLOTS = ['Weapon', 'Offhand', 'Helmet', 'Body Armour', 'Gloves', 'Boots', 'Belt', 'Amulet', 'Ring 1', 'Ring 2'];
function renderSetup() {
  const have = SETUP_SLOTS.filter((s) => state.equipped[s]);
  const box = $('#setupBox');
  if (have.length >= SETUP_SLOTS.length || state.settings.setupHidden) { box.innerHTML = ''; return; }
  const hk = (state.hotkeyStatus && state.hotkeyStatus.accelerator) || state.settings.hotkey || 'F2';
  box.innerHTML = `<div class="setup-head"><b>Set up your gear: ${have.length} of ${SETUP_SLOTS.length} slots saved</b>
      <div class="progress"><span id="setupBar"></span></div></div>
    <div class="help">In game, open your character screen (C), hover each item and press <b>${esc(hk)}</b>, then click <b>Set as …</b> in the popup. Or import everything from Path of Building below.</div>
    <div class="slotchips">${SETUP_SLOTS.map((s) => `<span class="chip ${state.equipped[s] ? 'done' : ''}">${state.equipped[s] ? '✓' : '○'} ${esc(s)}</span>`).join('')}</div>
    <div class="row"><button class="link" id="setupHide">Hide this</button></div>`;
  $('#setupBar').style.width = `${Math.round((have.length / SETUP_SLOTS.length) * 100)}%`; // CSSOM is fine under the CSP
  $('#setupHide').addEventListener('click', async () => { await window.api.setSetting('setupHidden', true); load(); });
}

let wizStep = 0;
const WIZ = [
  {
    title: 'Welcome to PoE2 Upgrade Checker',
    body: () => `<p>Hover any item in game and press your hotkey: a popup tells you if it's an <b>upgrade for your build</b> – worked out by Path of Building with your own build – and finds better items on the trade site in one click.</p>
      <p class="help">This guide takes about a minute. You can run it again from <b>My gear → Setup guide</b>.</p>
      <p class="help"><b>Game setting:</b> set PoE2 to <b>Windowed Fullscreen</b> (Options → Graphics), or the popup can't show over the game.</p>`,
  },
  {
    title: '1. Your build',
    body: () => `<p><b>Best:</b> paste your <b>Path of Building</b> export (PoB2: Import/Export Build → Generate) or a pobb.in link. The app then judges every item with Path of Building's own calculations for <i>your</i> build – any class, any skill – and loads your gear.</p>
      <div class="row"><input id="wizPob" class="grow" placeholder="https://pobb.in/…  or  eNrt…"><button id="wizPobBtn" class="primary">Import</button></div><div class="note" id="wizPobMsg"></div>
      <p class="help">No PoB? Pick the closest profile for a rough gear score instead, and save your gear in the next steps:</p>
      <div class="row"><select id="wizBuild">${(state.builds || []).map((b) => `<option value="${esc(b.id)}" ${b.id === (state.settings.build || state.defaultBuild) ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}<option value="off">None – score by my own stat weights</option></select></div>
      <p class="help" id="wizBuildHelp"></p>`,
    after: () => {
      const u = () => { const b = (state.builds || []).find((x) => x.id === $('#wizBuild').value); $('#wizBuildHelp').textContent = b ? b.summary : 'You set stat weights yourself in Build & stats.'; };
      u();
      $('#wizBuild').addEventListener('change', async () => { await window.api.setSetting('build', $('#wizBuild').value); u(); });
      $('#wizPobBtn').addEventListener('click', async () => { $('#wizPobMsg').textContent = 'Importing… (the first time, Path of Building takes a few seconds to start)'; const r = await window.api.importPob($('#wizPob').value.trim()); $('#wizPobMsg').textContent = r.ok ? r.message : r.error; if (r.ok) { await load(); state = await window.api.getState(); $('#wizBuild').value = state.settings.build; u(); } });
    },
  },
  {
    title: '2. Your hotkey',
    body: () => `<p>Your check-item hotkey is <b>${esc((state.hotkeyStatus && state.hotkeyStatus.accelerator) || state.settings.hotkey || 'F2')}</b>${state.hotkeyStatus && state.hotkeyStatus.ok ? ' and it\'s working.' : ' – <span class="note">it isn\'t registered, change it in Settings.</span>'}</p>
      <p>Where should the popup appear?</p><div class="row"><select id="wizPos"><option value="cursor">Next to the mouse</option><option value="left">Left side of the screen</option><option value="right">Right side of the screen</option><option value="top">Top of the screen</option></select> <button id="wizTest">Show a test popup</button></div>
      <p class="help">If it covers the game's item tooltip, pick a side of the screen.</p>`,
    after: () => { $('#wizPos').value = state.settings.popupPosition || 'cursor'; $('#wizPos').addEventListener('change', async () => { await window.api.setSetting('popupPosition', $('#wizPos').value); }); $('#wizTest').addEventListener('click', () => window.api.testPopup()); },
  },
  {
    title: '3. Your gear',
    body: () => `<p>${Object.keys(state.equipped || {}).length ? `You have <b>${Object.keys(state.equipped).length}</b> items saved.` : 'Save what you\'re wearing so the app can compare.'} In game, hover each equipped item, press the hotkey and click <b>Set as …</b> in the popup. Items you copy in game replace Path of Building's, so the app uses exactly what you wear.</p>
      <p class="help">The <b>My gear</b> tab shows a checklist. Also type your resistances from the character sheet there.</p>`,
  },
  {
    title: "4. You're set",
    body: () => `<p>Try it: hover an item in game and press the hotkey.</p>
      <ul><li><b>Find upgrades</b> searches the trade site and shows listings scored for your build.</li><li><b>What's it worth?</b> prices loot.</li><li>Set your price range and stats to ignore on the <b>Find upgrades</b> page.</li></ul>`,
  },
];
function renderWiz() {
  const st = WIZ[wizStep];
  $('#wizTitle').textContent = st.title;
  $('#wizBody').innerHTML = st.body();
  $('#wizStep').textContent = `${wizStep + 1} / ${WIZ.length}`;
  $('#wizBack').disabled = wizStep === 0;
  $('#wizNext').textContent = wizStep === WIZ.length - 1 ? 'Done' : 'Next';
  if (st.after) st.after();
}
function openWizard() { wizStep = 0; $('#wizard').classList.remove('hidden'); renderWiz(); }
async function closeWizard() { $('#wizard').classList.add('hidden'); await window.api.setSetting('wizardDone', true); load(); }
$('#wizNext').addEventListener('click', () => { if (wizStep === WIZ.length - 1) closeWizard(); else { wizStep++; renderWiz(); } });
$('#wizBack').addEventListener('click', () => { if (wizStep > 0) { wizStep--; renderWiz(); } });
$('#wizClose').addEventListener('click', closeWizard);
$('#wizardBtn').addEventListener('click', openWizard);
window.api.getState().then((st) => { if (!st.settings.wizardDone && !Object.keys(st.equipped || {}).length) openWizard(); });

// ---------- characters ----------
async function renderProfiles() {
  const list = state.profiles || [];
  $('#profileSel').innerHTML = list.map((p) => `<option value="${esc(p.id)}" ${p.active ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  $('#profileDelete').disabled = list.length < 2;
}
$('#profileSel').addEventListener('change', async () => { await window.api.switchProfile($('#profileSel').value); await load(); });
$('#profileNew').addEventListener('click', async () => {
  const name = await askText('Name for the new character', 'e.g. Witch league starter');
  if (!name) return;
  const copy = await askYesNo('Start from a copy of this character\'s settings (build, weights, ignored stats)? Gear is copied too – you can replace it.');
  await window.api.createProfile(name, copy);
  await load();
});
$('#profileRename').addEventListener('click', async () => {
  const cur = (state.profiles || []).find((p) => p.active);
  const name = await askText('Rename character', cur ? cur.name : '');
  if (name) { await window.api.renameProfile(cur.id, name); await load(); }
});
$('#profileDelete').addEventListener('click', async () => {
  const cur = (state.profiles || []).find((p) => p.active);
  if (cur && await askYesNo(`Delete "${cur.name}" and its saved gear? This can't be undone.`)) { await window.api.deleteProfile(cur.id); await load(); }
});

// tiny in-page dialogs (window.prompt isn't available in Electron)
function dialog(html, onOk) {
  return new Promise((resolve) => {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="modal-box wizard-box">${html}<div class="row wiz-nav"><span class="grow"></span><button data-no>Cancel</button><button class="primary" data-ok>OK</button></div></div>`;
    document.body.appendChild(m);
    const done = (v) => { m.remove(); resolve(v); };
    m.querySelector('[data-no]').addEventListener('click', () => done(null));
    m.querySelector('[data-ok]').addEventListener('click', () => done(onOk(m)));
    const inp = m.querySelector('input'); if (inp) { inp.focus(); inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(onOk(m)); if (e.key === 'Escape') done(null); }); }
  });
}
function askText(title, value) { return dialog(`<h2>${esc(title)}</h2><input class="grow wide" value="${esc(value || '')}">`, (m) => m.querySelector('input').value.trim() || null); }
function askYesNo(text) { return dialog(`<p>${esc(text)}</p>`, () => true).then((v) => !!v); }

// ---------- Path of Building ----------
$('#pobImport').addEventListener('click', async () => {
  $('#pobMsg').textContent = 'Importing…';
  const r = await window.api.importPob($('#pobInput').value.trim());
  $('#pobMsg').textContent = r.ok ? r.message : r.error;
  if (r.ok) { $('#pobInput').value = ''; await load(); renderPob(false); }
});
const kfmt = (v) => (v == null ? '–' : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e4 ? Math.round(v / 1000) + 'k' : Math.round(v).toLocaleString('en'));
async function renderPob(load) {
  const el = $('#pobStatus');
  renderPriorities();
  $('#pobUse').checked = state.settings.usePob !== false;
  // the slider goes from Damage (left) to Survivability (right): its value is the survivability share
  $('#pobBalance').value = Math.round((1 - (state.settings.pobDamageWeight == null ? 0.6 : state.settings.pobDamageWeight)) * 100);
  const st = await window.api.pobStatus(!!load);
  $('#pobControls').classList.toggle('hidden', !(st.available && st.hasBuild));
  if (!st.available) { el.innerHTML = '<div class="note">The Path of Building engine isn\'t included in this copy of the app – items are judged by the gear score instead.</div>'; return; }
  if (!st.hasBuild) { el.innerHTML = '<div class="note">No build yet: paste your PoB export above so items are judged by Path of Building.</div>'; return; }
  if (!st.enabled) { el.innerHTML = '<div class="dim">Turned off – items are judged by the gear score.</div>'; return; }
  if (st.error) { el.innerHTML = `<div class="note">Path of Building: ${esc(st.error)}</div>`; return; }
  const m = st.summary;
  if (!m) {
    // start it in the background the first time you look, so the status is right without a click
    if (!window.__pobAutoLoad) { window.__pobAutoLoad = true; el.innerHTML = '<div class="dim"><span class="spinner"></span> Starting Path of Building…</div>'; renderPob(true); return; }
    el.innerHTML = '<div class="dim">Build saved. Path of Building starts the first time an item is checked. <button class="link" id="pobLoad">Check it now</button></div>'; const b = $('#pobLoad'); if (b) b.addEventListener('click', () => { el.innerHTML = '<div class="dim"><span class="spinner"></span> Starting Path of Building…</div>'; renderPob(true); }); return;
  }
  const res = (m.res || []).filter((r) => r.value != null && !(m.ci && r.el === 'Chaos')).map((r) => `${esc(r.el)} ${Math.round(r.value)}%${r.total > r.value ? ` <span class="dim">(${Math.round(r.total)})</span>` : ''}`).join(' · ');
  $('#prChaos').disabled = !!m.ci || !$('#prRes').checked;
  if (m.ci) { $('#prChaos').checked = false; $('#prChaos').parentNode.title = 'Chaos Inoculation: you are immune to chaos damage, so chaos resistance is ignored'; }
  el.innerHTML = `<div class="pob"><span class="pob-tag">PoB</span> <b>${esc(m.ascendancy || m.className || '')}</b> level ${esc(m.level)}${m.mainSkill ? ` · ${esc(m.mainSkill)}` : ''}${m.ci ? ' · <span title="Life is 1 in your build: chaos resistance is ignored everywhere">Chaos Inoculation</span>' : ''}</div>
    <div class="dim">${m.dpsKey === 'MinionDPS' ? 'Minion DPS' : 'DPS'} <b>${kfmt(m.dps)}</b> · Effective HP <b>${kfmt(m.ehp)}</b> · ES <b>${kfmt(m.es)}</b> · Spirit free <b>${m.spiritFree == null ? '–' : Math.round(m.spiritFree)}</b> of ${m.spirit == null ? '–' : Math.round(m.spirit)}</div>
    <div class="dim">Resistances: ${res}</div>
    ${m.overridden && m.overridden.length ? `<div class="dim">Using your in-game copies for: ${esc(m.overridden.join(', '))}</div>` : ''}
    ${m.mismatch.map((x) => `<div class="note">⚠ ${esc(x)}</div>`).join('')}`;
}
// what "Better for my build" does depends on the build: PoB judges, or the gear score, or off
function renderModeHints() {
  const off = state.settings.build === 'off';
  const fg = $('#findGear');
  if (fg) {
    fg.classList.toggle('hidden', off && !state.pobOn);
    fg.title = state.pobOn ? 'Path of Building builds the search from your build, then checks every listing with it' : 'Listings that score higher for your build (gear score)';
  }
  document.querySelectorAll('.gs-fallback-note').forEach((e) => e.classList.toggle('hidden', !state.pobOn));
  // stat weights are only used when you score by your own weights
  const wc = $('#weightsCard'); if (wc) wc.classList.toggle('hidden', state.settings.build !== 'off');
  $('#gsExplain').innerHTML = window.gearExplainHtml({ where: 'gear score editor on this page', pobOn: state.pobOn });
}
function renderPriorities() {
  const p = state.priorities || {};
  $('#prRes').checked = !!p.resFirst; $('#prChaos').checked = !!p.chaos; $('#prChaos').disabled = !p.resFirst;
  $('#prSpirit').checked = !!p.spirit; $('#prAttrs').checked = !!p.attrs; $('#prDmg').checked = !!p.keepDmg;
  $('#prNote').textContent = p.resFirst
    ? 'Resistances first: each resistance point an item adds toward your cap counts +0.5% on its score (losing them costs the same), and Find upgrades searches for the resistances you still need.'
    : 'Resistances count through effective HP like everything else.';
}
['#prRes', '#prChaos', '#prDmg', '#prSpirit', '#prAttrs'].forEach((id) => $(id).addEventListener('change', async () => {
  state.priorities = await window.api.setPriorities({ resFirst: $('#prRes').checked, chaos: $('#prChaos').checked, keepDmg: $('#prDmg').checked, spirit: $('#prSpirit').checked, attrs: $('#prAttrs').checked });
  renderPriorities();
}));
$('#pobUse').addEventListener('change', async () => { await window.api.pobEnable($('#pobUse').checked); state = await window.api.getState(); renderPob(false); });
$('#pobBalance').addEventListener('change', async () => { await window.api.setSetting('pobDamageWeight', 1 - Number($('#pobBalance').value) / 100); state = await window.api.getState(); });


// ---------- resistances ----------
function renderResists() {
  const r = state.liveResists || state.settings.resists || {};
  const set = (id, v) => { if (document.activeElement !== $(id)) $(id).value = v == null ? '' : v; };
  set('#resFire', r.fire); set('#resCold', r.cold); set('#resLightning', r.lightning); set('#resChaos', r.chaos); set('#resCap', r.cap); set('#resBuffer', r.buffer);
  const rec = state.settings.resists;
  const when = rec && rec.at ? new Date(rec.at).toLocaleDateString() : '';
  $('#resSource').textContent = !rec ? '' : rec.source === 'pob'
    ? `From Path of Building${when ? ` (${when})` : ''}, adjusted for gear you've changed since. PoB can count charms and buffs that aren't always on – check them against your character sheet and type the real numbers here.`
    : `From your character sheet${when ? ` (${when})` : ''}, adjusted for gear you've changed since.`;
}
['#resFire', '#resCold', '#resLightning', '#resChaos', '#resCap', '#resBuffer'].forEach((id) => $(id).addEventListener('change', async () => {
  const v = (x) => $(x).value.trim();
  const saved = await window.api.setResists({ fire: v('#resFire'), cold: v('#resCold'), lightning: v('#resLightning'), chaos: v('#resChaos'), cap: v('#resCap'), buffer: v('#resBuffer') });
  $('#resMsg').textContent = saved ? 'Saved.' : 'Cleared – resistance caps are ignored.';
  state = await window.api.getState(); renderSlots();
}));

// ---------- gear score editor ----------
function renderBuildEditor() {
  const stats = state.buildStats || [];
  const tw = state.settings.buildTweaks || {};
  if (state.settings.build === 'off' || !stats.length) { $('#buildEditor').innerHTML = '<tr><td class="dim">Pick a build above to edit its gear score.</td></tr>'; return; }
  const opts = [0, 0.5, 1, 1.5, 2, 3];
  $('#buildEditor').innerHTML = '<tr><th>Stat</th><th>Counts on (importance)</th><th>How much it matters</th></tr>' + stats.map((x) => {
    const cur = tw[x.label] != null ? Number(tw[x.label]) : 1;
    return `<tr><td>${esc(x.label)}</td><td class="dim small">${esc(x.where)}</td>
      <td><select data-tweak="${esc(x.label)}">${opts.map((o) => `<option value="${o}" ${o === cur ? 'selected' : ''}>${o === 0 ? 'Off' : o + '×'}</option>`).join('')}</select></td></tr>`;
  }).join('');
  document.querySelectorAll('[data-tweak]').forEach((sel) => sel.addEventListener('change', async () => {
    const t = { ...(state.settings.buildTweaks || {}) };
    if (Number(sel.value) === 1) delete t[sel.dataset.tweak]; else t[sel.dataset.tweak] = Number(sel.value);
    await window.api.setSetting('buildTweaks', t);
    $('#buildMsg').textContent = 'Saved – gear scores updated.';
    await load();
  }));
}
$('#buildTweaksReset').addEventListener('click', async () => { await window.api.setSetting('buildTweaks', {}); $('#buildMsg').textContent = 'Back to the build defaults.'; await load(); });

// ---------- alerts ----------
async function renderAlertStatus() {
  const st = await window.api.alertsStatus();
  if (document.activeElement !== $('#alertEvery')) $('#alertEvery').value = String(st.every || 0);
  $('#alertStatus').textContent = !st.every ? 'Alerts are off.' : st.lastRun ? `Last checked ${ago(st.lastRun)}.` : 'Checks start within a minute.';
}
$('#alertEvery').addEventListener('change', async () => { await window.api.setSetting('alertEvery', Number($('#alertEvery').value)); renderAlertStatus(); });

// ---------- account ----------
async function renderAccount() {
  const st = await window.api.accountStatus();
  $('#signStatus').textContent = st.signedIn ? 'Signed in.' : 'Not signed in.';
  $('#signOut').disabled = !st.signedIn;
}
$('#signIn').addEventListener('click', async () => { $('#signStatus').textContent = 'Sign in in the window that opened…'; await window.api.signIn(); renderAccount(); });
$('#signOut').addEventListener('click', async () => { await window.api.signOut(); renderAccount(); });
renderAccount();

// ---------- updates ----------
async function renderUpdate(st) {
  st = st || await window.api.updateStatus();
  const v = `Version ${st.current}`;
  const msg = {
    dev: `${v}. Running from source (start.bat), so updates don't apply – pull the new files instead.`,
    portable: `${v}. The portable .exe can't update itself – install the Setup version from the releases page to get updates.`,
    unavailable: `${v}. The updater isn't installed in this copy.`,
    idle: `${v}.`,
    checking: `${v}. Checking…`,
    latest: `${v}. You're up to date.`,
    available: `${v}. Version ${st.version} is available.`,
    downloading: `${v}. Downloading ${st.version}${st.progress != null ? ` (${st.progress}%)` : ''}…`,
    ready: `${v}. Version ${st.version} is ready.`,
    error: `${v}. Couldn't check: ${st.error || 'unknown error'}`,
  }[st.state] || v;
  $('#updStatus').textContent = msg;
  const noUpd = ['dev', 'portable', 'unavailable'].includes(st.state);
  $('#updCheck').disabled = noUpd || st.state === 'checking';
  $('#autoUpdate').disabled = noUpd;
  const act = $('#updAction');
  act.classList.toggle('hidden', !['available', 'ready'].includes(st.state));
  act.textContent = st.state === 'ready' ? 'Restart & update' : 'Download';
}
$('#updCheck').addEventListener('click', async () => { $('#updStatus').textContent = 'Checking…'; renderUpdate(await window.api.updateCheck()); });
$('#updAction').addEventListener('click', async () => {
  const st = await window.api.updateStatus();
  if (st.state === 'ready') window.api.updateInstall(); else renderUpdate(await window.api.updateDownload());
});
(async () => {
  const s = (await window.api.getState()).settings || {};
  $('#autoUpdate').checked = s.autoUpdate !== false;
  $('#autoUpdate').addEventListener('change', () => window.api.setSetting('autoUpdate', $('#autoUpdate').checked));
})();
window.api.onUpdateChanged(() => renderUpdate());
renderUpdate();

// ---------- gear score explanation ----------
$('#gsExplain').innerHTML = window.gearExplainHtml({ where: 'gear score editor on this page' });
window.showGearHelp = () => {
  document.querySelector('.tabs button[data-tab="build"]').click();
  setTimeout(() => $('#gsExplainCard').scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
};
document.querySelectorAll('.page-head .gs-help').forEach((b) => b.addEventListener('click', () => window.showGearHelp()));
