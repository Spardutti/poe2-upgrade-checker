#!/usr/bin/env node
'use strict';
// Is a newer Path of Building out than the versions this app ships (tools/get-pob.js)?
// Run by release.bat before a release; prints a warning for each one that's behind. It never
// fails a release by itself: no git or no network just says it couldn't check.
//
//   node tools/check-pob.js          exit 0; exit 2 when one is behind (release.bat asks you)

const { execFileSync } = require('child_process');
const { TARGETS } = require('./get-pob');

const parse = (t) => (String(t).match(/^v(\d+)\.(\d+)\.(\d+)$/) || []).slice(1).map(Number);
const newer = (a, b) => { for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; } return false; };

let behind = 0;
for (const t of TARGETS) {
  let tags;
  try {
    tags = execFileSync('git', ['ls-remote', '--tags', '--refs', t.repo], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map((l) => l.split('refs/tags/')[1]).filter(Boolean);
  } catch (_) { console.log(`Couldn't check ${t.name} for a newer version (no git or no network).`); continue; }
  const pinned = parse(t.tag);
  // the PoE2 repository also carries PoE1's old tags (v2.x): only the same major version counts
  const latest = tags.map((x) => [x, parse(x)]).filter(([, v]) => v.length === 3 && v[0] === pinned[0])
    .reduce((best, x) => (!best || newer(x[1], best[1]) ? x : best), null);
  if (latest && newer(latest[1], pinned)) {
    behind++;
    console.log(`NEWER: ${t.name} ${latest[0]} is out; the app ships ${t.tag}.`);
    console.log(`       Update its tag in tools/get-pob.js, run "node tools/get-pob.js" and the tests, then release.`);
  } else console.log(`${t.name} ${t.tag} is the newest.`);
}
process.exit(behind ? 2 : 0);
