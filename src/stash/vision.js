'use strict';

// Reads a PoE2 specialty stash tab from a screenshot, with no game memory
// access and no input sent to the game.
//
// 1. Find the cell frames: masked normalised cross-correlation of the
//    ornamental frame ring. The interior is ignored, so the item icons don't matter.
// 2. Identify the tab from the arrangement of the cells (each tab has its own layout).
// 3. Read the stack count drawn in each cell's top-left corner, using digit templates.
//
// Layouts, frame crops and digit templates come from the MIT-licensed
// poe2-stash-tracker project (measured at 2560x1440). Everything here works in
// "reference pixels" times a scale factor, so any resolution or UI scale works:
// the scale is found automatically and remembered per screen size.

const REF_H = 1440;
const RING = 12;          // frame ring thickness at reference scale
const DIGIT_W = 14; const DIGIT_H = 22;

// ---------- image helpers (img = { width, height, data: RGBA Uint8 } ) ----------
function toGray(img) {
  const { width: w, height: h, data } = img;
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  return { w, h, g };
}

// Area-average resize of a grey image to (nw, nh).
function resizeGray(src, nw, nh) {
  const out = new Float32Array(nw * nh);
  const sx = src.w / nw; const sy = src.h / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = y * sy; const y1 = Math.min(src.h, (y + 1) * sy);
    for (let x = 0; x < nw; x++) {
      const x0 = x * sx; const x1 = Math.min(src.w, (x + 1) * sx);
      let sum = 0; let area = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        if (wy <= 0) continue;
        const row = yy * src.w;
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const wx = Math.min(xx + 1, x1) - Math.max(xx, x0);
          if (wx <= 0) continue;
          sum += src.g[row + xx] * wx * wy; area += wx * wy;
        }
      }
      out[y * nw + x] = area ? sum / area : 0;
    }
  }
  return { w: nw, h: nh, g: out };
}

function crop(src, x, y, w, h) {
  const out = new Float32Array(w * h);
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
    const sx = Math.min(src.w - 1, Math.max(0, x + xx)); const sy = Math.min(src.h - 1, Math.max(0, y + yy));
    out[yy * w + xx] = src.g[sy * src.w + sx];
  }
  return { w, h, g: out };
}

// integral image of squares, (w+1)*(h+1)
function integralSq(src) {
  const W = src.w + 1; const I = new Float64Array(W * (src.h + 1));
  for (let y = 0; y < src.h; y++) {
    let row = 0;
    for (let x = 0; x < src.w; x++) { const v = src.g[y * src.w + x]; row += v * v; I[(y + 1) * W + x + 1] = I[y * W + x + 1] + row; }
  }
  return { W, I };
}
const boxSum = (S, x, y, w, h) => S.I[(y + h) * S.W + x + w] - S.I[y * S.W + x + w] - S.I[(y + h) * S.W + x] + S.I[y * S.W + x];

// A frame template scaled to size px, as a list of ring pixel offsets + values.
function ringTemplate(tmpl, size, ringPx) {
  const t = resizeGray({ w: tmpl.w, h: tmpl.h, g: Float32Array.from(tmpl.data) }, size, size);
  const offs = []; const vals = []; let norm = 0;
  const r = Math.max(2, Math.round(ringPx));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (x >= r && x < size - r && y >= r && y < size - r) continue;
    offs.push([x, y]); const v = t.g[y * size + x]; vals.push(v); norm += v * v;
  }
  return { size, ring: r, offs, vals, norm: Math.sqrt(norm) };
}

// Masked CCORR_NORMED of a ring template at every position in [x0,x1)x[y0,y1) step `step`.
// Returns positions scoring >= thr.
function scanRing(src, S, T, x0, y0, x1, y1, step, thr) {
  const hits = [];
  const n = T.offs.length; const inner = T.size - 2 * T.ring;
  const lin = new Int32Array(n); for (let k = 0; k < n; k++) lin[k] = T.offs[k][1] * src.w + T.offs[k][0];
  const tv = Float32Array.from(T.vals);
  for (let y = y0; y < Math.min(y1, src.h - T.size); y += step) {
    for (let x = x0; x < Math.min(x1, src.w - T.size); x += step) {
      const e = boxSum(S, x, y, T.size, T.size) - boxSum(S, x + T.ring, y + T.ring, inner, inner);
      if (e <= 1) continue;
      const base = y * src.w + x; let num = 0;
      for (let k = 0; k < n; k++) num += src.g[base + lin[k]] * tv[k];
      const s = num / (Math.sqrt(e) * T.norm);
      if (s >= thr) hits.push({ x, y, s });
    }
  }
  return hits;
}

// keep only the best hit in each neighbourhood
function nms(hits, dist) {
  hits.sort((a, b) => b.s - a.s);
  const keep = [];
  const cell = Math.max(1, Math.floor(dist));
  const grid = new Map();
  const key = (gx, gy) => gx * 100003 + gy;
  for (const h of hits) {
    const gx = Math.floor(h.x / cell); const gy = Math.floor(h.y / cell);
    let clear = true;
    for (let ox = -1; ox <= 1 && clear; ox++) for (let oy = -1; oy <= 1 && clear; oy++) {
      const list = grid.get(key(gx + ox, gy + oy));
      if (list && list.some((k) => Math.abs(k.x - h.x) < dist && Math.abs(k.y - h.y) < dist)) clear = false;
    }
    if (!clear) continue;
    keep.push(h);
    const k = key(gx, gy); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(h);
  }
  return keep;
}

// Real cells have a near-black margin just inside the frame (25th percentile <= 20).
function darkMargin(src, x, y, scale) {
  const a = Math.round(RING * scale); const b = Math.round(73 * scale);
  const vals = [];
  const m = Math.max(2, Math.round(5 * scale));
  for (let yy = y + a; yy < y + b; yy++) for (let xx = x + a; xx < x + b; xx++) {
    if (yy - (y + a) < m || (y + b) - yy <= m || xx - (x + a) < m || (x + b) - xx <= m) {
      if (xx >= 0 && yy >= 0 && xx < src.w && yy < src.h) vals.push(src.g[yy * src.w + xx]);
    }
  }
  if (vals.length < 20) return false;
  vals.sort((p, q) => p - q);
  return vals[Math.floor(vals.length * 0.25)] <= 22;
}

// Find all cell frames at a given scale. Search runs on a half-size image, then is refined.
function detectCells(gray, frames, scale, opts = {}) {
  const thr = opts.thr || 0.85;
  const regionW = Math.min(gray.w, Math.round((opts.regionW || 900) * scale));
  // coarse search on a small copy where a cell frame is ~28 px, then refine at full size
  const f = Math.min(1, 28 / (92 * scale));
  const small = f === 1 ? gray : resizeGray(gray, Math.round(gray.w * f), Math.round(gray.h * f));
  const Ss = integralSq(small); const Sf = integralSq(gray);
  const cands = [];
  for (const [name, fr] of Object.entries(frames)) {
    const size = Math.round(fr.w * scale);
    const Tf = ringTemplate(fr, size, RING * scale);
    const Ts = f === 1 ? Tf : ringTemplate(fr, Math.round(size * f), RING * scale * f);
    const coarse = nms(scanRing(small, Ss, Ts, 0, 0, Math.round(regionW * f), small.h, 1, thr - 0.12), Ts.size * 0.6);
    for (const c of coarse) {
      // refine at full resolution
      const cx = Math.round(c.x / f); const cy = Math.round(c.y / f);
      const r = Math.ceil(1 / f) + 1;
      const fine = scanRing(gray, Sf, Tf, Math.max(0, cx - r), Math.max(0, cy - r), cx + r + 1, cy + r + 1, 1, thr);
      if (fine.length) cands.push({ ...fine.reduce((p, q) => (q.s > p.s ? q : p)), size, name });
    }
  }
  cands.sort((a, b) => b.s - a.s);
  const keep = [];
  for (const c of cands) {
    const clear = keep.every((k) => Math.max(Math.abs(c.x - k.x), Math.abs(c.y - k.y)) > Math.min(c.size, k.size) * 0.6);
    if (clear && darkMargin(gray, c.x, c.y, scale)) keep.push(c);
  }
  keep.sort((a, b) => a.y - b.y || a.x - b.x);
  return keep;
}

// Which tab is this? For each layout, anchor its first reference cell on each detected cell
// and count how many reference cells land on a detection (recall).
function matchLayout(cells, layouts, scale) {
  let best = null; let bestScore = 0; let bestOff = [0, 0];
  if (!cells.length) return { layout: null, score: 0, offset: bestOff };
  const tol = Math.max(3, Math.round(6 * scale));
  const near = (x, y) => cells.some((c) => Math.abs(c.x - x) <= tol && Math.abs(c.y - y) <= tol);
  for (const L of layouts) {
    const sig = L.signature.map(([x, y]) => [Math.round(x * scale), Math.round(y * scale)]);
    for (const a of cells) {
      const dx = a.x - sig[0][0]; const dy = a.y - sig[0][1];
      let hit = 0;
      for (const [x, y] of sig) if (near(x + dx, y + dy)) hit++;
      const score = hit / sig.length;
      // prefer the layout that explains more cells when recalls tie
      if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) < 1e-9 && best && sig.length > best.signature.length)) {
        best = L; bestScore = score; bestOff = [dx, dy];
      }
    }
  }
  return { layout: best, score: bestScore, offset: bestOff };
}

// ---------- digits ----------
function loadDigits(json) {
  const out = {};
  for (const [d, t] of Object.entries(json)) out[d] = Float32Array.from(t.data);
  return out;
}

function ncc(a, b) {
  const n = a.length; let ma = 0; let mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma; const y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

// Bright-white glyphs in the count area of a cell, left to right, each resized to 14x22.
// Segmentation uses ink profiles (rows, then columns) of a soft "white text" image, which
// copes with thin strokes breaking up at small UI sizes better than connected components.
function glyphs(img, x, y, scale) {
  const rx = x + Math.round(8 * scale); const ry = y + Math.round(8 * scale);
  const rw = Math.round(64 * scale); const rh = Math.round(34 * scale);
  const W = img.width;
  const soft = new Float32Array(rw * rh);
  for (let yy = 0; yy < rh; yy++) for (let xx = 0; xx < rw; xx++) {
    const sx = rx + xx; const sy = ry + yy;
    if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
    const p = (sy * W + sx) * 4;
    const lo = Math.min(img.data[p], img.data[p + 1], img.data[p + 2]);
    const hi = Math.max(img.data[p], img.data[p + 1], img.data[p + 2]);
    if (hi - lo < 60) soft[yy * rw + xx] = Math.max(0, Math.min(255, (lo - 110) * 2.4)); // white-ish only
  }
  // strong pixels decide where the text is (relative to the brightest text pixel, so thin
  // strokes at small UI sizes still count)
  let strongAt = 150;
  const strong = (i) => soft[i] >= strongAt;
  // the first few rows/columns of the region are still the cell frame ring
  const ringIn = Math.max(1, Math.floor((RING - 8) * scale));
  for (let yy = 0; yy < rh; yy++) for (let xx = 0; xx < rw; xx++) if (xx < ringIn || yy < ringIn) soft[yy * rw + xx] = 0;
  // text band: first run of rows with strong ink, within the left part of the region
  const leftW = Math.min(rw, Math.round(40 * scale));
  let peak = 0;
  for (let yy = 0; yy < rh; yy++) for (let xx = 0; xx < leftW; xx++) peak = Math.max(peak, soft[yy * rw + xx]);
  if (peak < 70) return [];
  strongAt = Math.min(150, peak * 0.6);
  const rowInk = new Float32Array(rh);
  for (let yy = 0; yy < rh; yy++) for (let xx = 0; xx < rw; xx++) if (strong(yy * rw + xx)) rowInk[yy]++;
  let top = -1;
  for (let yy = 0; yy < rh; yy++) { let k = 0; for (let xx = 0; xx < leftW; xx++) if (strong(yy * rw + xx)) k++; if (k > 0) { top = yy; break; } }
  if (top < 0) return [];
  // digits are ~20 px tall at reference size; icon art can touch the bottom of them
  let bot = top;
  while (bot + 1 < rh && rowInk[bot + 1] > 0 && bot + 1 - top < 24 * scale) bot++;
  let h = bot - top + 1;
  if (h < 12 * scale) return peak > 150 && h >= 7 * scale ? null : []; // specks, or a number we can't segment
  // column ink over the band
  const colInk = new Float32Array(rw);
  for (let xx = 0; xx < rw; xx++) for (let yy = top; yy <= bot; yy++) colInk[xx] += soft[yy * rw + xx] / 255;
  const runs = []; let start = -1;
  const inkMin = 0.35;
  for (let xx = 0; xx <= rw; xx++) {
    const ink = xx < rw && colInk[xx] > inkMin;
    if (ink && start < 0) start = xx;
    if (!ink && start >= 0) { runs.push([start, xx - 1]); start = -1; }
  }
  // a narrow piece next to another one with a 1-2 px gap is part of the same digit (serifs, thin strokes)
  for (let i = 0; i < runs.length - 1; i++) {
    const [a1, b1] = runs[i]; const [a2, b2] = runs[i + 1];
    const narrow = Math.min(b1 - a1 + 1, b2 - a2 + 1) < h * 0.28;
    if (narrow && a2 - b1 - 1 <= Math.max(1, Math.round(2 * scale)) && b2 - a1 + 1 < h * 0.85) { runs.splice(i, 2, [a1, b2]); i--; }
  }
  // keep the left-aligned run of glyphs; stop at the first big gap (icon art further right)
  const out = [];
  const maxGap = Math.max(6 * scale, h * 0.5);
  for (const [a, b] of runs) {
    let mass = 0; for (let xx = a; xx <= b; xx++) mass += colInk[xx];
    if (mass < 2 * scale || b - a + 1 < Math.max(2, h * 0.12)) continue; // a stray column
    if (!out.length) { if (a > 22 * scale) break; out.push([a, b]); continue; }
    if (a - out[out.length - 1][1] - 1 > maxGap) break;
    out.push([a, b]);
  }
  // split runs that are two digits touching
  const parts = [];
  for (const [a, b] of out) {
    const w = b - a + 1; const k = Math.max(1, Math.round(w / (h * 0.62)));
    if (k === 1 || w < h * 0.9) { parts.push([a, b]); continue; }
    // cut at the weakest columns near the expected boundaries
    let prev = a;
    for (let i = 1; i < k; i++) {
      const guess = Math.round(a + (i * w) / k); let cut = guess; let best = Infinity;
      for (let c = guess - 2; c <= guess + 2; c++) if (c > prev && c < b && colInk[c] < best) { best = colInk[c]; cut = c; }
      parts.push([prev, cut - 1]); prev = cut + 1;
    }
    parts.push([prev, b]);
  }
  const glyphsOut = [];
  for (const [a, b] of parts) {
    // tighten rows to the glyph's own ink
    let t = top; let e = bot;
    const rowHas = (yy) => { for (let xx = a; xx <= b; xx++) if (soft[yy * rw + xx] > 90) return true; return false; };
    while (t < e && !rowHas(t)) t++; while (e > t && !rowHas(e)) e--;
    const gw = b - a + 1; const gh = e - t + 1;
    const g = new Float32Array(gw * gh);
    let fill = 0;
    for (let yy = 0; yy < gh; yy++) for (let xx = 0; xx < gw; xx++) { const v = soft[(t + yy) * rw + a + xx]; g[yy * gw + xx] = v; if (v > 150) fill++; }
    // a solid bright block is icon art, not a digit: the number ends here
    if (gh < 12 * scale || fill > 0.8 * gw * gh) { if (!glyphsOut.length) continue; break; }
    glyphsOut.push(resizeGray({ w: gw, h: gh, g }, DIGIT_W, DIGIT_H).g);
  }
  // text-like ink but nothing we could segment: unreadable, not empty
  if (!glyphsOut.length) return peak > 150 ? null : [];
  return glyphsOut;
}

// Best digit for one glyph. `sets` is a list of template maps {digit: Float32Array | Float32Array[]}.
function bestDigit(g, sets) {
  let bd = null; let bs = -1;
  for (const set of sets) for (const [d, t] of Object.entries(set)) {
    for (const one of Array.isArray(t) ? t : [t]) { const v = ncc(g, one); if (v > bs) { bs = v; bd = d; } }
  }
  return { d: bd, s: bs };
}

const ACCEPT = 0.62;   // lowest match we trust
const LEARN = 0.8;    // matches this good teach the reader how digits look on this screen

// Stack count in a cell: a number, 0 if empty, null if unreadable.
function readCount(img, x, y, scale, digits, extra) {
  const gs = glyphs(img, x, y, scale);
  if (gs === null) return { count: null, conf: 0, glyphs: [] };
  if (!gs.length) return { count: 0, conf: 1, glyphs: [] };
  const sets = extra ? [digits, ...[].concat(extra)] : [digits];
  let s = ''; let worst = 1; const parts = [];
  for (const g of gs) {
    const { d, s: bs } = bestDigit(g, sets);
    parts.push({ g, d, s: bs });
    if (d == null || bs < ACCEPT) { worst = Math.min(worst, bs); s = null; continue; }
    if (s != null) s += d; worst = Math.min(worst, bs);
  }
  return { count: s == null ? null : Number(s), conf: worst, glyphs: parts };
}

// Average glyphs into one template per digit.
function averageTemplates(samples) {
  const out = {};
  for (const [d, list] of Object.entries(samples)) {
    if (!list.length) continue;
    const t = new Float32Array(DIGIT_W * DIGIT_H);
    for (const g of list) for (let i = 0; i < t.length; i++) t[i] += g[i] / list.length;
    out[d] = t;
  }
  return out;
}

// ---------- the whole read ----------
// assets: { frames, layouts, digits (from loadDigits) }
// opts.scale: known scale (skip detection); opts.scales: candidates to try.
function readTab(img, assets, opts = {}) {
  const t0 = Date.now();
  const gray = toGray(img);
  const tryScale = (s) => {
    const cells = detectCells(gray, assets.frames, s, opts);
    const m = matchLayout(cells, assets.layouts, s);
    return { s, cells, ...m };
  };
  let res = null;
  if (opts.scale) res = tryScale(opts.scale);
  if ((!res || res.score < 0.6) && !opts.noSearch) {
    // auto scale: PoE scales its UI with the window height; UI scale can change it further.
    const base = img.height / REF_H;
    const list = opts.scales || [1, 0.95, 1.05, 0.9, 1.1, 0.85, 1.15, 0.8, 1.2, 0.75, 1.25, 0.7].map((u) => base * u);
    for (const s of list) {
      if (opts.scale && Math.abs(s - opts.scale) < 1e-3) continue;
      const r = tryScale(s);
      if (!res || r.score > res.score) res = r;
      if (r.score >= 0.9) break;
    }
  }
  if (!res || !res.layout || res.score < 0.6) {
    return { ok: false, reason: res && res.cells.length ? `Found ${res.cells.length} stash cells but couldn't tell which tab this is.` : 'No stash tab found on screen. Open a specialty tab (Currency, Essence, Runes…) first.', cells: res ? res.cells.length : 0, ms: Date.now() - t0 };
  }
  const { layout, offset: [dx, dy], s } = res;
  const learned = assets.learned || null; // templates learned on this screen size before
  const first = layout.signature.map(([rx, ry]) => {
    const x = Math.round(rx * s) + dx; const y = Math.round(ry * s) + dy;
    return { key: `${rx},${ry}`, x, y, r: readCount(img, x, y, s, assets.digits, learned ? [learned] : null) };
  });
  // second pass: digits read with high confidence in this very screenshot show exactly how the
  // game draws them here, so use them to re-read the uncertain ones
  const samples = {};
  for (const c of first) for (const p of c.r.glyphs) if (p.s >= LEARN) (samples[p.d] = samples[p.d] || []).push(p.g);
  const local = averageTemplates(samples);
  const counts = {}; const unreadable = []; const unknown = [];
  for (const c of first) {
    let r = c.r;
    if (r.count == null && r.glyphs.length && Object.keys(local).length) {
      const parts = r.glyphs.map((p) => ({ g: p.g, ...bestDigit(p.g, [assets.digits, local, ...(learned ? [learned] : [])]) }));
      if (parts.every((p) => p.d != null && p.s >= ACCEPT)) r = { count: Number(parts.map((p) => p.d).join('')), conf: Math.min(...parts.map((p) => p.s)), glyphs: parts };
    }
    const name = layout.slots[c.key];
    if (!name) { unknown.push({ key: c.key, x: c.x, y: c.y, count: r.count }); continue; }
    if (r.count == null) { unreadable.push({ name, key: c.key, x: c.x, y: c.y, digits: r.glyphs.length }); continue; }
    counts[name] = (counts[name] || 0) + r.count;
  }
  return { ok: true, samples: Object.fromEntries(Object.entries(samples).map(([d, l]) => [d, l.length])), localTemplates: local, tab: layout.name, score: Math.round(res.score * 100) / 100, scale: Math.round(s * 10000) / 10000, origin: [dx, dy], counts, unreadable, unknown, cells: res.cells.length, ms: Date.now() - t0 };
}

// Where a reference slot sits on screen (for labelling a slot under the cursor).
function slotAt(layout, scale, origin, px, py) {
  for (const [rx, ry] of layout.signature) {
    const x = Math.round(rx * scale) + origin[0]; const y = Math.round(ry * scale) + origin[1];
    const size = 80 * scale;
    if (px >= x && px < x + size && py >= y && py < y + size) return `${rx},${ry}`;
  }
  return null;
}

module.exports = { readTab, detectCells, matchLayout, readCount, glyphs, averageTemplates, bestDigit, toGray, resizeGray, loadDigits, slotAt, REF_H };
