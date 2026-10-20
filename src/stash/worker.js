'use strict';

// Runs the stash reader off the main thread so the app stays responsive while it works.
const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const vision = require('./vision');

const A = path.join(__dirname, 'assets');
const base = {
  frames: JSON.parse(fs.readFileSync(path.join(A, 'frames.json'), 'utf8')),
  layouts: JSON.parse(fs.readFileSync(path.join(A, 'layouts.json'), 'utf8')),
  digits: vision.loadDigits(JSON.parse(fs.readFileSync(path.join(A, 'digits.json'), 'utf8'))),
};

parentPort.on('message', (msg) => {
  const { id, width, height, buffer, opts, learned, layouts } = msg;
  try {
    const img = { width, height, data: new Uint8ClampedArray(buffer) };
    const assets = { ...base, layouts: layouts && layouts.length ? layouts : base.layouts };
    if (learned) assets.learned = Object.fromEntries(Object.entries(learned).map(([d, arr]) => [d, Float32Array.from(arr)]));
    const r = vision.readTab(img, assets, opts || {});
    // send learned templates back as plain arrays
    if (r.localTemplates) r.localTemplates = Object.fromEntries(Object.entries(r.localTemplates).map(([d, t]) => [d, Array.from(t, (v) => Math.round(v))]));
    parentPort.postMessage({ id, ok: true, result: r });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err.stack || String(err) });
  }
});
