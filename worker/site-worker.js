// poe2upgrade.com: the website (files in site/), plus a small caching proxy for poe.ninja's price
// data, which poe.ninja asks desktop apps to use instead of calling it from every player's PC
// (https://poe.ninja/docs/api). Only the economy endpoints the app reads are passed on.
//
//   /ninja/poe1/exchange/current/overview?league=…&type=…   ->  https://poe.ninja/poe1/api/economy/…
//   /ninja/poe2/stash/current/item/overview?league=…&type=…
//   /ninja/poe2/leagues

const ALLOWED = /^\/ninja\/(poe1|poe2)\/(leagues|exchange\/current\/overview|stash\/current\/item\/overview|stash\/current\/currency\/overview)$/;
// /ninja/<game>/exchange/all?league=… : every exchange list of the game in one answer
const ALL = /^\/ninja\/(poe1|poe2)\/exchange\/all$/;
const EXCHANGE_TYPES = {
  poe2: ['Currency', 'Fragments', 'Abyss', 'UncutGems', 'LineageSupportGems', 'Essences', 'SoulCores', 'Idols', 'Runes', 'Ritual', 'Expedition', 'Delirium', 'Breach', 'Verisium'],
  poe1: ['Currency', 'Fragment', 'Runegraft', 'AllflameEmber', 'Tattoo', 'Omen', 'DjinnCoin', 'Ducat', 'EnshroudingCrystal', 'DivinationCard', 'Artifact', 'Oil', 'DeliriumOrb', 'Scarab', 'Astrolabe', 'Fossil', 'Resonator', 'Essence'],
};
const QUERY = ['league', 'type'];
const UA = 'PoE Upgrade Checker price proxy (https://poe2upgrade.com; support@poe2upgrade.com)';
// poe.ninja refreshes PoE1 about every 15 minutes and PoE2 about hourly
const TTL = { poe1: 15 * 60, poe2: 30 * 60 };

// one poe.ninja list, through the shared cache
async function cachedJson(game, what, q, ctx) {
  const key = new Request(`https://poe2upgrade.com/ninja-cache/${game}/${what}?${q}`);
  const hit = await caches.default.match(key);
  if (hit) return hit.json();
  const res = await fetch(`https://poe.ninja/${game}/api/economy/${what}?${q}`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, cf: { cacheTtl: TTL[game], cacheEverything: true } });
  if (!res.ok) return null;
  const body = await res.text();
  ctx.waitUntil(caches.default.put(key, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${TTL[game]}` } })));
  try { return JSON.parse(body); } catch (_) { return null; }
}
async function exchangeAll(game, league, ctx) {
  if (!league) return new Response(JSON.stringify({ error: 'league missing' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  const key = new Request(`https://poe2upgrade.com/ninja-cache/${game}/exchange/all?league=${encodeURIComponent(league)}`);
  const hit = await caches.default.match(key);
  if (hit) return hit;
  const types = {};
  // a few at a time, so poe.ninja never sees a burst from us
  const list = EXCHANGE_TYPES[game];
  for (let i = 0; i < list.length; i += 4) {
    await Promise.all(list.slice(i, i + 4).map(async (t) => {
      try { const d = await cachedJson(game, 'exchange/current/overview', `league=${encodeURIComponent(league)}&type=${encodeURIComponent(t)}`, ctx); if (d && Array.isArray(d.lines)) types[t] = d; } catch (_) { /* that list is missing this time */ }
    }));
  }
  const out = new Response(JSON.stringify({ league, types }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${TTL[game]}`, 'Access-Control-Allow-Origin': '*' } });
  if (Object.keys(types).length) ctx.waitUntil(caches.default.put(key, out.clone()));
  return out;
}

// ---------- anonymous usage statistics (the app's "Send anonymous usage statistics") ----------
// POST /api/ping { id, v, p, beta, poe1, poe2 }: one row per install per day. The install id is a
// random number the app made; it's hashed again here, and nothing else is kept: no IP address, no
// account, no character, no items. GET /api/stats?key=… shows the totals (the key is in D1's config).
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
async function sha(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
async function ping(request, env) {
  if (!env.STATS) return json({ ok: false }, 503);
  let b;
  try { b = JSON.parse((await request.text()).slice(0, 2000)); } catch (_) { return json({ ok: false }, 400); }
  if (!b || !/^[0-9a-f]{32}$/.test(String(b.id || ''))) return json({ ok: false }, 400);
  const install = await sha('poe-upgrade-checker:' + b.id);
  const day = new Date().toISOString().slice(0, 10);
  const v = String(b.v || '').replace(/[^0-9A-Za-z.\-]/g, '').slice(0, 24) || null;
  const p = ['win32', 'linux', 'darwin'].includes(b.p) ? b.p : 'other';
  await env.STATS.prepare(`INSERT INTO pings (day, install, version, platform, poe1, poe2, beta, first_seen)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE((SELECT MIN(first_seen) FROM pings WHERE install = ?2), ?1))
      ON CONFLICT (day, install) DO UPDATE SET version = excluded.version, platform = excluded.platform,
        poe1 = MAX(poe1, excluded.poe1), poe2 = MAX(poe2, excluded.poe2), beta = excluded.beta`)
    .bind(day, install, v, p, b.poe1 ? 1 : 0, b.poe2 ? 1 : 0, b.beta ? 1 : 0).run();
  return json({ ok: true });
}
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
async function stats(url, env) {
  if (!env.STATS) return new Response('Statistics are not set up.', { status: 503 });
  const row = await env.STATS.prepare("SELECT v FROM config WHERE k = 'stats_key'").first();
  const key = url.searchParams.get('key') || '';
  if (!row || !key || key !== row.v) return new Response('Not found', { status: 404 });
  const since = (days) => new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const active = async (days) => env.STATS.prepare(`SELECT COUNT(DISTINCT install) AS all_, COUNT(DISTINCT CASE WHEN poe1 = 1 THEN install END) AS poe1,
      COUNT(DISTINCT CASE WHEN poe2 = 1 THEN install END) AS poe2, COUNT(DISTINCT CASE WHEN poe1 = 1 AND poe2 = 1 THEN install END) AS both_
      FROM pings WHERE day >= ?1`).bind(since(days)).first();
  const [d1, d7, d30] = await Promise.all([active(1), active(7), active(30)]);
  const daily = (await env.STATS.prepare(`SELECT day, COUNT(*) AS n, SUM(poe1) AS poe1, SUM(poe2) AS poe2, SUM(CASE WHEN first_seen = day THEN 1 ELSE 0 END) AS fresh
      FROM pings WHERE day >= ?1 GROUP BY day ORDER BY day DESC`).bind(since(30)).all()).results || [];
  const versions = (await env.STATS.prepare('SELECT version, COUNT(DISTINCT install) AS n FROM pings WHERE day >= ?1 GROUP BY version ORDER BY n DESC LIMIT 20').bind(since(7)).all()).results || [];
  const platforms = (await env.STATS.prepare('SELECT platform, COUNT(DISTINCT install) AS n FROM pings WHERE day >= ?1 GROUP BY platform ORDER BY n DESC').bind(since(7)).all()).results || [];
  const total = await env.STATS.prepare('SELECT COUNT(DISTINCT install) AS n FROM pings').first();
  if (url.searchParams.get('format') === 'json') return json({ today: d1, week: d7, month: d30, daily, versions, platforms, ever: total && total.n });
  const card = (t, o) => `<div class="c"><h2>${t}</h2><b>${esc(o.all_)}</b><span>PoE2 ${esc(o.poe2)} · PoE1 ${esc(o.poe1)}${o.both_ ? ` · both ${esc(o.both_)}` : ''}</span></div>`;
  const rows = (list, cols) => list.map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c])}</td>`).join('')}</tr>`).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Usage · PoE Upgrade Checker</title><style>
:root{color-scheme:dark}body{margin:0;padding:24px 16px;background:#0e1013;color:#d8d2c4;font:15px/1.5 system-ui,sans-serif}main{max-width:900px;margin:auto}
h1{font-size:20px;margin:0 0 4px}p{color:#8d8a82;margin:0 0 20px}.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:24px}
.c{background:#181b20;border:1px solid #2c3038;border-radius:8px;padding:14px}.c h2{font-size:13px;font-weight:600;color:#8d8a82;margin:0}.c b{display:block;font-size:30px;color:#f1e4c2}.c span{color:#8d8a82;font-size:13px}
table{width:100%;border-collapse:collapse;margin-bottom:24px;font-variant-numeric:tabular-nums}td,th{text-align:left;padding:5px 8px;border-bottom:1px solid #2c3038}th{color:#8d8a82;font-weight:600;font-size:13px}h3{font-size:15px;margin:0 0 6px}
</style></head><body><main><h1>PoE Upgrade Checker: active users</h1><p>Installs that sent the anonymous daily ping (users who opted out aren't counted). ${esc(total && total.n)} installs ever. Days are UTC.</p>
<div class="g">${card('Today', d1)}${card('Last 7 days', d7)}${card('Last 30 days', d30)}</div>
<h3>Each day</h3><table><tr><th>Day</th><th>Active</th><th>PoE2</th><th>PoE1</th><th>New installs</th></tr>${rows(daily, ['day', 'n', 'poe2', 'poe1', 'fresh'])}</table>
<h3>Versions (last 7 days)</h3><table><tr><th>Version</th><th>Installs</th></tr>${rows(versions, ['version', 'n'])}</table>
<h3>Systems (last 7 days)</h3><table><tr><th>System</th><th>Installs</th></tr>${rows(platforms, ['platform', 'n'])}</table></main></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
}

// ---------- /download: the newest release, betas included ----------
// GitHub's /releases/latest skips pre-releases, so the site and README link here instead. The answer
// is cached for 10 minutes (GitHub allows 60 unauthenticated API calls an hour).
const RELEASES = 'https://github.com/ets-public/poe2-upgrade-checker/releases';
async function download(ctx) {
  const key = new Request('https://poe2upgrade.com/download-cache');
  const hit = await caches.default.match(key);
  let url = hit ? await hit.text() : null;
  if (!url) {
    try {
      const res = await fetch('https://api.github.com/repos/ets-public/poe2-upgrade-checker/releases?per_page=10', { headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' } });
      const list = res.ok ? await res.json() : [];
      const r = (Array.isArray(list) ? list : []).filter((x) => x && !x.draft && x.html_url)
        .sort((a, b) => Date.parse(b.published_at || b.created_at || 0) - Date.parse(a.published_at || a.created_at || 0))[0];
      if (r) { url = r.html_url; ctx.waitUntil(caches.default.put(key, new Response(url, { headers: { 'Cache-Control': 'public, max-age=600' } }))); }
    } catch (_) { /* fall back to the list */ }
  }
  return Response.redirect(url || RELEASES, 302);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // one address for the site: www.poe2upgrade.com goes to poe2upgrade.com
    if (url.hostname === 'www.poe2upgrade.com') { url.hostname = 'poe2upgrade.com'; return Response.redirect(url.toString(), 301); }
    if (url.pathname === '/api/ping') return request.method === 'POST' ? ping(request, env).catch(() => json({ ok: false }, 500)) : json({ ok: false }, 405);
    if (url.pathname === '/download' || url.pathname === '/download/') return download(ctx);
    if (url.pathname === '/api/stats') return stats(url, env).catch((e) => new Response('Error: ' + e.message, { status: 500 }));
    if (!url.pathname.startsWith('/ninja/')) return env.ASSETS.fetch(request);
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    const all = url.pathname.match(ALL);
    if (all) return exchangeAll(all[1], (url.searchParams.get('league') || '').slice(0, 80), ctx);
    const m = url.pathname.match(ALLOWED);
    if (!m) return new Response('Not found', { status: 404 });
    const q = QUERY.filter((k) => url.searchParams.get(k)).map((k) => `${k}=${encodeURIComponent(url.searchParams.get(k).slice(0, 80))}`).join('&');
    const target = `https://poe.ninja/${m[1]}/api/economy/${m[2]}${q ? '?' + q : ''}`;
    // one cache entry per poe.ninja URL, whatever else the request carried
    const key = new Request(`https://poe2upgrade.com/ninja-cache/${m[1]}/${m[2]}?${q}`);
    const cache = caches.default;
    const hit = await cache.match(key);
    if (hit) return hit;
    let res;
    try {
      res = await fetch(target, { headers: { 'User-Agent': UA, Accept: 'application/json' }, cf: { cacheTtl: TTL[m[1]], cacheEverything: true } });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'poe.ninja unreachable' }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
    const body = await res.text();
    const out = new Response(body, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('Content-Type') || 'application/json',
        'Cache-Control': res.ok ? `public, max-age=${TTL[m[1]]}` : 'no-store',
        'Access-Control-Allow-Origin': '*',
        'X-Proxied-From': 'poe.ninja',
      },
    });
    if (res.ok) ctx.waitUntil(cache.put(key, out.clone()));
    return out;
  },
};
