'use strict';
const root = document.getElementById('root');

// Measure synchronously: requestAnimationFrame doesn't run while the window is
// hidden, which is what stopped the popup from ever showing a second time.
const report = () => window.api.resize(Math.ceil(root.getBoundingClientRect().height) + 8);

window.api.onResult((r) => {
  try {
    if (r && r.kind === 'stash') window.renderStashToast(root, r, { closable: true });
    else window.renderComparison(root, r, { closable: true, onResize: report });
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
