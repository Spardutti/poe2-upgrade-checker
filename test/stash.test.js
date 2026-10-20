'use strict';
// Stash screen reader on synthetic screenshots built from the real frame crops and digit
// glyphs, at several resolutions and UI scales.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const V = require('../src/stash/vision');

const A = path.join(__dirname, '../src/stash/assets');
const frames = JSON.parse(fs.readFileSync(path.join(A, 'frames.json')));
const digitsRaw = JSON.parse(fs.readFileSync(path.join(A, 'digits.json')));
const layouts = JSON.parse(fs.readFileSync(path.join(A, 'layouts.json')));
const assets = { frames, layouts, digits: V.loadDigits(digitsRaw) };

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// Draw a tab at 2560x1440 reference size, then resample to (W,H) with UI scale u.
function synth(name, seed, W, H, u = 1) {
  const r = rng(seed);
  const RW = 2560; const RH = 1440;
  const ref = new Uint8ClampedArray(RW * RH * 3);
  for (let i = 0; i < ref.length; i++) ref[i] = 25 + Math.floor(r() * 35);
  const L = layouts.find((l) => l.name === name);
  const f = name === 'essence' ? frames.essence : frames.currency;
  const S = f.w; const truth = {};
  const put = (x, y, v) => { if (x < 0 || y < 0 || x >= RW || y >= RH) return; const p = (y * RW + x) * 3; ref[p] = v[0]; ref[p + 1] = v[1]; ref[p + 2] = v[2]; };
  const counts = [0, 0, 1, 3, 7, 12, 45, 99, 120, 808, 1234, 5000];
  for (const [rx, ry] of L.signature) {
    const x = 40 + rx; const y = 180 + ry;
    const col = [40 + r() * 160, 40 + r() * 160, 40 + r() * 160];
    for (let yy = 0; yy < S; yy++) for (let xx = 0; xx < S; xx++) {
      const ring = xx < 12 || yy < 12 || xx >= S - 12 || yy >= S - 12;
      const v = f.data[yy * S + xx];
      const d = Math.hypot(xx - S / 2 - 6, yy - S / 2 - 6) < S / 4;
      put(x + xx, y + yy, ring ? [v, v, v] : d ? col : [8, 8, 8]);
    }
    const n = counts[Math.floor(r() * counts.length)];
    const nm = L.slots[`${rx},${ry}`];
    if (nm) truth[nm] = (truth[nm] || 0) + n;
    if (n > 0) {
      let cx = x + 13;
      for (const ch of String(n)) {
        const g = digitsRaw[ch];
        // glyph template 14x22 -> 12x20 on screen
        for (let yy = 0; yy < 20; yy++) for (let xx = 0; xx < 12; xx++) {
          const v = g.data[Math.floor((yy * 22) / 20) * 14 + Math.floor((xx * 14) / 12)];
          if (v > 110) put(cx + xx, y + 13 + yy, [235, 235, 235]);
        }
        cx += 14;
      }
    }
  }
  // resample: output pixel (x,y) <- reference (x/(k), y/(k)) with box filter, k = H/1440*u
  const k = (H / RH) * u;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const x0 = x / k; const y0 = y / k; const x1 = (x + 1) / k; const y1 = (y + 1) / k;
    let a = 0; let b = 0; let c = 0; let n = 0;
    if (x0 >= RW || y0 >= RH) { out[(y * W + x) * 4 + 3] = 255; continue; }
    for (let yy = Math.floor(y0); yy < Math.min(RH, Math.ceil(y1)); yy++) {
      const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
      for (let xx = Math.floor(x0); xx < Math.min(RW, Math.ceil(x1)); xx++) {
        const w = wy * (Math.min(xx + 1, x1) - Math.max(xx, x0));
        const p = (yy * RW + xx) * 3; a += ref[p] * w; b += ref[p + 1] * w; c += ref[p + 2] * w; n += w;
      }
    }
    const o = (y * W + x) * 4; out[o] = a / n; out[o + 1] = b / n; out[o + 2] = c / n; out[o + 3] = 255;
  }
  return { img: { width: W, height: H, data: out }, truth };
}

function check(name, W, H, u, maxUnreadable) {
  const { img, truth } = synth(name, W + H, W, H, u);
  const r = V.readTab(img, assets);
  assert.ok(r.ok, r.reason);
  assert.strictEqual(r.tab, name);
  const bad = Object.entries(truth).filter(([k, v]) => !r.unreadable.some((x) => x.name === k) && (r.counts[k] || 0) !== v);
  assert.deepStrictEqual(bad.map(([k, v]) => `${k}: read ${r.counts[k]}, really ${v}`), [], 'no wrong counts');
  assert.ok(r.unreadable.length <= maxUnreadable, `unreadable ${r.unreadable.length}`);
  return r;
}

test('reads a currency tab at 2560x1440', () => { const r = check('currency', 2560, 1440, 1, 0); assert.strictEqual(r.scale, 1); });
test('reads a rune tab at 1920x1080', () => { const r = check('socketables_runes', 1920, 1080, 1, 6); assert.strictEqual(r.scale, 0.75); });
test('finds a non-default UI scale on its own', () => { const r = check('expedition', 2560, 1440, 0.9, 4); assert.strictEqual(r.scale, 0.9); });
test('remembered scale is used first', () => {
  const { img } = synth('ritual', 5, 1920, 1080, 1);
  const r = V.readTab(img, assets, { scale: 0.75 });
  assert.ok(r.ok); assert.strictEqual(r.tab, 'ritual');
});
test('no stash on screen: clear message, no guesses', () => {
  const W = 960; const H = 540; const data = new Uint8ClampedArray(W * H * 4);
  const r0 = rng(1); for (let i = 0; i < data.length; i++) data[i] = (i % 4 === 3) ? 255 : Math.floor(r0() * 255);
  const r = V.readTab({ width: W, height: H, data }, assets, { scale: 0.375, noSearch: true });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /No stash tab|couldn't tell/);
});
test('slotAt finds the slot under the cursor', () => {
  const L = layouts.find((l) => l.name === 'currency');
  const [rx, ry] = L.signature[3];
  assert.strictEqual(V.slotAt(L, 0.75, [30, 135], 30 + rx * 0.75 + 20, 135 + ry * 0.75 + 20), `${rx},${ry}`);
});
