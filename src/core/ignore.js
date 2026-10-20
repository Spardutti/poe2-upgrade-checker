'use strict';

const { norm } = require('./statnorm');

// Stats you don't want to see or search for.
// A rule is { id, mode } for a preset (e.g. all resistances) or { key, mode }
// for one exact stat. mode:
//   'ignore'  - left out of the popup score and every search
//   'exclude' - also: trade searches skip listings that HAVE the stat

const PRESETS = {
  res: {
    label: 'All resistances',
    test: (k) => /^#% to (Fire|Cold|Lightning|Chaos) Resistance$/.test(k),
    keys: ['#% to Fire Resistance', '#% to Cold Resistance', '#% to Lightning Resistance', '#% to Chaos Resistance'],
  },
  eleres: {
    label: 'Elemental resistances (fire, cold, lightning)',
    test: (k) => /^#% to (Fire|Cold|Lightning) Resistance$/.test(k),
    keys: ['#% to Fire Resistance', '#% to Cold Resistance', '#% to Lightning Resistance'],
  },
  chaosres: {
    label: 'Chaos resistance',
    test: (k) => k === '#% to Chaos Resistance',
    keys: ['#% to Chaos Resistance'],
  },
  attributes: {
    label: 'Attributes (Str, Dex, Int)',
    test: (k) => /^# to (Strength|Dexterity|Intelligence)$/.test(k),
    keys: ['# to Strength', '# to Dexterity', '# to Intelligence'],
  },
  life: { label: 'Maximum Life', test: (k) => k === '# to maximum Life', keys: ['# to maximum Life'] },
  mana: { label: 'Maximum Mana', test: (k) => k === '# to maximum Mana', keys: ['# to maximum Mana'] },
};

function cleanRules(rules) {
  return (Array.isArray(rules) ? rules : [])
    .filter((r) => r && (PRESETS[r.id] || (typeof r.key === 'string' && r.key)))
    .map((r) => ({ ...(r.id ? { id: r.id } : { key: r.key }), mode: r.mode === 'exclude' ? 'exclude' : 'ignore' }));
}

// Returns the first rule that covers this stat key, or null.
function ruleFor(rules, key) {
  for (const r of cleanRules(rules)) {
    if (r.id && PRESETS[r.id].test(key)) return r;
    if (r.key && (r.key === key || norm(r.key) === norm(key))) return r;
  }
  return null;
}

function isIgnored(rules, key) { return !!ruleFor(rules, key); }

// Stat keys a listing must NOT have (from 'exclude' rules).
function excludedKeys(rules) {
  const out = new Set();
  for (const r of cleanRules(rules)) {
    if (r.mode !== 'exclude') continue;
    if (r.id) PRESETS[r.id].keys.forEach((k) => out.add(k)); else out.add(r.key);
  }
  return Array.from(out);
}

function describe(rules) {
  return cleanRules(rules).map((r) => (r.id ? PRESETS[r.id].label : r.key) + (r.mode === 'exclude' ? ' (excluded)' : ''));
}

module.exports = { PRESETS, cleanRules, ruleFor, isIgnored, excludedKeys, describe };
