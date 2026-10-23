// poe2upgrade.com: the website (files in site/), plus a small caching proxy for poe.ninja's price
// data, which poe.ninja asks desktop apps to use instead of calling it from every player's PC
// (https://poe.ninja/docs/api). Only the economy endpoints the app reads are passed on.
//
//   /ninja/poe1/exchange/current/overview?league=…&type=…   ->  https://poe.ninja/poe1/api/economy/…
//   /ninja/poe2/stash/current/item/overview?league=…&type=…
//   /ninja/poe2/leagues

const ALLOWED = /^\/ninja\/(poe1|poe2)\/(leagues|exchange\/current\/overview|stash\/current\/item\/overview|stash\/current\/currency\/overview)$/;
const QUERY = ['league', 'type'];
const UA = 'PoE Upgrade Checker price proxy (https://poe2upgrade.com; support@poe2upgrade.com)';
// poe.ninja refreshes PoE1 about every 15 minutes and PoE2 about hourly
const TTL = { poe1: 15 * 60, poe2: 30 * 60 };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/ninja/')) return env.ASSETS.fetch(request);
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
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
