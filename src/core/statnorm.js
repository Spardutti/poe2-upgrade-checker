'use strict';

// One normal form for stat texts, so "+# to maximum Life" (trade explicit),
// "+# total maximum Life" (trade pseudo) and "# to maximum Life" (our item
// key) all compare equal.
function norm(text) {
  return String(text)
    .toLowerCase()
    .replace(/\+/g, '')
    .replace(/\b(total|to)\b/g, ' ')
    .replace(/\s*\(local\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { norm };
