'use strict';

// Credits GitHub contributors in CHANGELOG.md: every pull request merged since the last release that
// the changelog doesn't mention yet gets a line in the section being released. Run by release.bat:
//   node tools/credits.js --since v0.5.0 --heading "## 0.5.1" [--create]
// --create adds the heading (under the title) when it's missing; a beta uses "## Unreleased" with it.
// Pull requests show up as GitHub's merge commits ("Merge pull request #2 from user/branch", with the
// title in the body) or as squash merges ("Title (#2)", authored by the contributor).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const OWNERS = new Set(['ets-public']); // the repo's own account: not a contributor
const US = '\x1f'; const RS = '\x1e';

// git log output (%s US %b US %an RS per commit) -> [{ num, who, title }]
function pullRequests(raw) {
  const out = []; const seen = new Set();
  for (const rec of String(raw || '').split(RS)) {
    const [subject = '', body = '', author = ''] = rec.replace(/^\s+/, '').split(US);
    let m; let pr = null;
    if ((m = subject.match(/^Merge pull request #(\d+) from ([^/\s]+)\//))) pr = { num: Number(m[1]), who: m[2], title: body.trim().split(/\r?\n/)[0].trim() };
    else if ((m = subject.trim().match(/^(.+) \(#(\d+)\)$/))) pr = { num: Number(m[2]), who: author.trim(), title: m[1].trim() };
    if (!pr || !pr.who || OWNERS.has(pr.who) || seen.has(pr.num)) continue;
    seen.add(pr.num);
    out.push({ ...pr, title: pr.title || `pull request #${pr.num}` });
  }
  return out.sort((a, b) => a.num - b.num);
}

const creditLine = (pr) => `- **From contributors:** ${pr.title.replace(/\.$/, '')} (thanks ${pr.who}, #${pr.num}).`;
// already credited anywhere in the changelog: a line ending "(thanks name, #2)", or "PR #2" / "pull request #2"
// (not any "#2": the changelog also says things like "Socket #2")
const mentioned = (log, num) => new RegExp(`(\\(thanks [^)]*, #${num}\\)|\\b(PR|pull request) #${num}\\b)`, 'i').test(log);

// -> { log, added: [lines] }
function addCredits(log, prs, heading, create) {
  const lines = prs.filter((p) => !mentioned(log, p.num)).map(creditLine);
  if (!lines.length) return { log, added: [] };
  const nl = /\r\n/.test(log) ? '\r\n' : '\n';
  const esc = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let m = new RegExp(`^${esc}(?:[ \\t][^\\r\\n]*)?\\r?\\n`, 'm').exec(log);
  if (!m) {
    if (!create) return { log, added: [] };
    const title = /^# [^\r\n]*\r?\n(\r?\n)?/.exec(log);
    const at = title ? title.index + title[0].length : 0;
    log = log.slice(0, at) + heading + nl + log.slice(at);
    m = { index: at, 0: heading + nl };
  }
  const at = m.index + m[0].length;
  return { log: log.slice(0, at) + lines.join(nl) + nl + log.slice(at), added: lines };
}

function main(argv) {
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const heading = arg('--heading');
  if (!heading) { console.error('usage: credits.js --since <tag> --heading "## 1.2.3" [--create]'); return 2; }
  const since = arg('--since');
  const root = path.join(__dirname, '..');
  const raw = execFileSync('git', ['log', `--pretty=format:%s${US}%b${US}%an${RS}`, since ? `${since}..HEAD` : 'HEAD'], { cwd: root, encoding: 'utf8' });
  const file = path.join(root, 'CHANGELOG.md');
  const log = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# Changelog\n\n';
  const r = addCredits(log, pullRequests(raw), heading, argv.includes('--create'));
  if (r.added.length) fs.writeFileSync(file, r.log);
  for (const l of r.added) console.log('Credited: ' + l.replace(/^- \*\*From contributors:\*\* /, ''));
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { pullRequests, addCredits, creditLine };
