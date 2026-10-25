'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { pullRequests, addCredits } = require('../tools/credits');

const US = '\x1f'; const RS = '\x1e';
const LOG = [
  `Merge pull request #2 from Spardutti/fix/map-check-long-maps${US}Map check: keep no-number mods on long maps and unique maps${US}ets-public`,
  `Map check: keep no-number mods on long maps and unique maps${US}${US}Spardutti`,
  `Release 0.5.0${US}${US}ets-public`,
  `Better flask wording (#3)${US}${US}Someone`,
  `Our own squash (#4)${US}${US}ets-public`,
].join(RS);

test('finds merged and squashed pull requests from contributors, not our own', () => {
  assert.deepEqual(pullRequests(LOG), [
    { num: 2, who: 'Spardutti', title: 'Map check: keep no-number mods on long maps and unique maps' },
    { num: 3, who: 'Someone', title: 'Better flask wording' },
  ]);
});

test('credits go under the released heading, once', () => {
  const log = '# Changelog\n\n## 0.5.1 - 2026-10-26\n- **Thing:** done.\n\n## 0.5.0 - 2026-10-25\n- **From contributors:** old (thanks X, #1).\n';
  const prs = [{ num: 1, who: 'X', title: 'old' }, { num: 2, who: 'Spardutti', title: 'Map fix' }];
  const r = addCredits(log, prs, '## 0.5.1', false);
  assert.deepEqual(r.added, ['- **From contributors:** Map fix (thanks Spardutti, #2).']);
  assert.match(r.log, /## 0\.5\.1 - 2026-10-26\n- \*\*From contributors:\*\* Map fix \(thanks Spardutti, #2\)\.\n- \*\*Thing/);
  assert.equal(addCredits(r.log, prs, '## 0.5.1', false).added.length, 0); // run again: nothing new
});

test('a beta adds "## Unreleased" when there is none; CRLF files stay CRLF', () => {
  const r = addCredits('# Changelog\r\n\r\n## 0.5.0 - 2026-10-25\r\n- a\r\n', [{ num: 5, who: 'Y', title: 'Fix.' }], '## Unreleased', true);
  assert.equal(r.log, '# Changelog\r\n\r\n## Unreleased\r\n- **From contributors:** Fix (thanks Y, #5).\r\n## 0.5.0 - 2026-10-25\r\n- a\r\n');
  assert.equal(addCredits('# Changelog\n', [{ num: 5, who: 'Y', title: 'Fix' }], '## 9.9.9', false).added.length, 0); // no heading, no --create
});

test('other "#2" text in the changelog doesn\'t count as a credit', () => {
  const r = addCredits('# Changelog\n\n## Unreleased\n- shows "vs Entropy Star (Socket #2)"\n', [{ num: 2, who: 'S', title: 'Map fix' }], '## Unreleased', true);
  assert.equal(r.added.length, 1);
});
