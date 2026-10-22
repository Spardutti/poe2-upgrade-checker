'use strict';
const root = document.getElementById('root');

// Measure synchronously: requestAnimationFrame doesn't run while the window is
// hidden, which is what stopped the popup from ever showing a second time.
const report = () => window.api.resize(Math.ceil(root.getBoundingClientRect().height) + 8);

// A re-render of the same item (settings changed, Path of Building answered) keeps
// what you had open: More ▾ and any search message. A new item starts fresh.
let shownId = null;
let expanded = false;
window.api.onResult((r) => {
  const id = r && r.item ? r.item.id || r.item.name : null;
  const same = id && id === shownId;
  const msg = same ? root.querySelector('#findMsg') : null;
  const msgHtml = msg ? msg.innerHTML : '';
  if (!same) expanded = false;
  shownId = id;
  try {
    window.renderComparison(root, r, { closable: true, onResize: report, expanded, onToggle: (open) => { expanded = open; } });
    const m2 = root.querySelector('#findMsg');
    if (m2 && msgHtml) m2.innerHTML = msgHtml;
  } catch (err) {
    root.innerHTML = '<div class="card"><div class="note"></div></div>';
    root.querySelector('.note').textContent = 'Popup error: ' + err.message;
  }
  report();
});

// mouseenter/mouseleave don't fire on `document`; use the <html> element.
document.documentElement.addEventListener('mouseenter', () => window.api.hover(true));
document.documentElement.addEventListener('mouseleave', () => window.api.hover(false));

// Esc closes the popup only when you've clicked into it (the game keeps Esc otherwise).
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.api.close(); });
