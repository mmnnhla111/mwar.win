import type { Context } from 'hono';

/**
 * Tiny Cloudflare Cache API (`caches.default`) wrapper for read-heavy GET routes whose response
 * is the same for every caller. A HIT is served from the colo's edge cache without touching D1.
 * (The Worker invocation itself still counts; the saving is D1 reads + CPU time.)
 * On workers.dev / local dev the Cache API is a no-op, so this silently falls through.
 */
const CACHE_ORIGIN = 'https://edge-cache.mwar.win';

export async function edgeCachedJson(c: Context<any>, key: string, ttlSeconds: number, produce: () => Promise<unknown>): Promise<Response> {
  const cache = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
  const req = new Request(`${CACHE_ORIGIN}/${key}`);
  if (cache) {
    try {
      const hit = await cache.match(req);
      if (hit) {
        const res = new Response(hit.body, hit);
        res.headers.set('X-Edge-Cache', 'HIT');
        return res;
      }
    } catch {
      /* cache unavailable: fall through */
    }
  }
  const body = JSON.stringify(await produce());
  const stored = new Response(body, {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${ttlSeconds}` },
  });
  if (cache) {
    try {
      c.executionCtx.waitUntil(cache.put(req, stored.clone()));
    } catch {
      /* no execution context (tests): skip */
    }
  }
  const res = new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Edge-Cache': 'MISS' } });
  return res;
}

/** Drop a cached entry after a write so the next read is fresh. */
export async function edgeCachePurge(c: Context<any>, key: string) {
  const cache = (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default;
  if (!cache) return;
  try {
    c.executionCtx.waitUntil(cache.delete(new Request(`${CACHE_ORIGIN}/${key}`)));
  } catch {
    /* ignore */
  }
}
