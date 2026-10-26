'use strict';
const root = document.getElementById('root');

// Measure synchronously: requestAnimationFrame doesn't run while the window is
// hidden, which is what stopped the popup from ever showing a second time.
// the whole page (card, margins and all), so nothing is cut off at any text size
const report = () => { const b = root.getBoundingClientRect(); const m = parseFloat(getComputedStyle(document.body).marginBottom) || 0; window.api.resize(Math.ceil(root.offsetTop + b.height + m) + 6); };

// A re-render of the same item (settings changed, Path of Building answered) keeps
// what you had open: More ▾ and any search message (renderComparison shows it again, with
// working buttons). A new item starts fresh.
let shownId = null;
let expanded = false;
window.api.onResult((r) => {
  const id = r && r.item ? r.item.id || r.item.name : null;
  const same = id && id === shownId;
  if (!same) expanded = false;
  shownId = id;
  try {
    window.renderComparison(root, r, { closable: true, onResize: report, expanded, onToggle: (open) => { expanded = open; } });
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
