'use strict';

// The release workflow runs small scripts as  node -e '…'  in bash: a single quote inside one ends
// the script early (it then does nothing and the step fails later). 0.5.0-beta.1 lost its release
// notes to an apostrophe in a comment.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('release workflow: no single quotes inside node -e scripts', () => {
  const y = fs.readFileSync(path.join(__dirname, '..', 'ci', 'release.yml'), 'utf8').replace(/\r/g, '');
  const blocks = [...y.matchAll(/node -e '\n([\s\S]*?)\n\s*'(?= |\n|$)/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 2, 'found the scripts');
  for (const b of blocks) {
    const bad = b.split('\n').filter((l) => l.includes("'"));
    assert.deepStrictEqual(bad, [], 'single quote in a node -e script');
  }
});
