'use strict';

// Stat database picker: every stat the trade site knows, searchable, with
// "seen on <item type>" counts from the items you've copied. Opened in one of
// three modes: 'search' (add to custom search), 'ignore', 'weight'.

(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const itemKey = (t) => String(t).replace(/\+#/g, '#').replace(/\s*\(Local\)\s*$/i, '').trim();
  const LIMIT = 150;
  let cat = null;
  let mode = 'search';
  let onPick = null;

  const TITLES = {
    search: 'Add a stat to the custom search',
    ignore: 'Ignore or exclude stats',
    weight: 'Set stat weights',
  };

  async function load() {
    if (cat) return cat;
    $('#pickerInfo').textContent = 'Loading the trade site stat list…';
    const r = await window.api.statsCatalog();
    if (!r.ok) { $('#pickerInfo').textContent = r.error; return null; }
    cat = r;
    return cat;
  }

  function fillSeen(preferClass) {
    const opts = ['<option value="">Any item type</option>', '<option value="__any">Seen on my items</option>']
      .concat(cat.classes.map((c) => `<option value="${esc(c)}">Seen on ${esc(c)}</option>`));
    $('#pickerSeen').innerHTML = opts.join('');
    $('#pickerSeen').value = preferClass && cat.classes.includes(preferClass) ? preferClass : '';
  }

  function seenCount(e, cls) {
    if (!cls) return Object.values(e.seen).reduce((a, b) => a + b, 0);
    if (cls === '__any') return Object.values(e.seen).reduce((a, b) => a + b, 0);
    return e.seen[cls] || 0;
  }

  function render() {
    if (!cat) return;
    const words = $('#pickerSearch').value.toLowerCase().split(/\s+/).filter(Boolean);
    const kind = $('#pickerKind').value;
    const cls = $('#pickerSeen').value;
    let list = cat.entries.filter((e) => {
      if (kind && !e.kinds[kind]) return false;
      if (mode === 'weight' && Object.keys(e.kinds).every((k) => k === 'pseudo')) return false;
      if (cls && seenCount(e, cls) === 0) return false;
      const t = e.text.toLowerCase();
      return words.every((w) => t.includes(w));
    });
    list.sort((a, b) => seenCount(b, cls) - seenCount(a, cls) || a.text.localeCompare(b.text));
    const total = list.length;
    list = list.slice(0, LIMIT);
    const clsLabel = cls === '__any' ? 'your items' : cls;
    $('#pickerInfo').textContent = `${total} stat${total === 1 ? '' : 's'}${total > LIMIT ? ` – showing the first ${LIMIT}, type more to narrow it down` : ''}.`
      + (cat.classes.length ? '' : ' Tip: copy a few items in game and you can filter by "Seen on <item type>".');
    const rules = (window.__ignoreRules && window.__ignoreRules()) || [];
    const weights = (window.__weights && window.__weights()) || {};
    $('#pickerList').innerHTML = list.map((e, i) => {
      // the kinds that matter most; fractured/crafted/enchant only when the filter asks for them
      const main = ['pseudo', 'explicit', 'implicit', 'augment', 'desecrated'];
      const shown = Object.keys(e.kinds).filter((k) => main.includes(k) || k === kind);
      const kinds = (shown.length ? shown : Object.keys(e.kinds)).map((k) => `<span class="kind k-${esc(k)}">${esc(cat.kindLabel[k] || k)}</span>`).join('');
      const seenAll = seenCount(e, '__any');
      const seen = seenAll ? `<span class="seen" title="${esc(Object.entries(e.seen).map(([c, n]) => `${c}: ${n}`).join(', '))}">seen ${cls && cls !== '__any' ? `${seenCount(e, cls)}× on ${esc(clsLabel)}` : `${seenAll}×`}</span>` : '';
      let action = '';
      if (mode === 'search') {
        const ks = Object.keys(e.kinds);
        const def = ks.includes('pseudo') ? 'pseudo' : ks.includes('explicit') ? 'explicit' : ks[0];
        action = `${ks.length > 1 ? `<select data-kind="${i}">${ks.map((k) => `<option value="${esc(k)}" ${k === def ? 'selected' : ''}>${esc(cat.kindLabel[k] || k)}</option>`).join('')}</select>` : ''}
          <input type="number" class="num" data-min="${i}" placeholder="min">
          <button data-add="${i}" class="primary">Add</button>`;
      } else if (mode === 'ignore') {
        const r = rules.find((x) => x.key && x.key === e.text);
        action = r ? `<span class="dim">${r.mode === 'exclude' ? 'Excluded' : 'Ignored'}</span> <button data-unrule="${i}">Undo</button>`
          : `<button data-ignore="${i}">Ignore</button><button data-exclude="${i}">Exclude listings</button>`;
      } else {
        const w = weights[itemKey(e.text)];
        action = `<input type="number" step="0.1" class="num" data-w="${i}" value="${w || ''}" placeholder="0"><button data-setw="${i}">Set</button>`;
      }
      return `<div class="pick-row"><div class="pick-text">${esc(e.text)}<div class="pick-meta">${kinds}${seen}</div></div><div class="pick-act">${action}</div></div>`;
    }).join('') || '<div class="dim">No stats match.</div>';

    const get = (i) => list[Number(i)];
    $('#pickerList').querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
      const e = get(b.dataset.add);
      const sel = $('#pickerList').querySelector(`[data-kind="${b.dataset.add}"]`);
      const kind = sel ? sel.value : Object.keys(e.kinds)[0];
      const min = $('#pickerList').querySelector(`[data-min="${b.dataset.add}"]`).value;
      onPick && onPick({ text: e.text, id: e.kinds[kind], kind, min });
      b.textContent = 'Added ✓';
    }));
    const setRule = (i, m) => {
      const e = get(i);
      const cur = (window.__ignoreRules() || []).filter((x) => x.key !== e.text);
      if (m) cur.push({ key: e.text, mode: m });
      return window.__saveIgnore(cur).then(render);
    };
    $('#pickerList').querySelectorAll('[data-ignore]').forEach((b) => b.addEventListener('click', () => setRule(b.dataset.ignore, 'ignore')));
    $('#pickerList').querySelectorAll('[data-exclude]').forEach((b) => b.addEventListener('click', () => setRule(b.dataset.exclude, 'exclude')));
    $('#pickerList').querySelectorAll('[data-unrule]').forEach((b) => b.addEventListener('click', () => setRule(b.dataset.unrule, null)));
    $('#pickerList').querySelectorAll('[data-setw]').forEach((b) => b.addEventListener('click', async () => {
      const e = get(b.dataset.setw);
      const v = $('#pickerList').querySelector(`[data-w="${b.dataset.setw}"]`).value;
      await window.api.setWeight(itemKey(e.text), v);
      if (window.__afterWeight) await window.__afterWeight();
      b.textContent = 'Saved ✓';
    }));
  }

  let timer = null;
  $('#pickerSearch').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(render, 120); });
  $('#pickerKind').addEventListener('change', render);
  $('#pickerSeen').addEventListener('change', render);
  $('#pickerClose').addEventListener('click', () => $('#picker').classList.add('hidden'));
  $('#picker').addEventListener('click', (e) => { if (e.target.id === 'picker') $('#picker').classList.add('hidden'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#picker').classList.add('hidden'); });

  // opts: { mode, itemClass, query, onPick }
  window.openStatPicker = async function (opts) {
    mode = opts.mode || 'search';
    onPick = opts.onPick || null;
    $('#pickerTitle').textContent = TITLES[mode];
    $('#picker').classList.remove('hidden');
    $('#pickerSearch').value = opts.query || '';
    $('#pickerKind').value = '';
    if (!(await load())) return;
    fillSeen(opts.itemClass);
    render();
    $('#pickerSearch').focus();
  };
  window.__pickerRefresh = () => { cat = null; };
})();
