/**
 * What the service worker is allowed to do with one request.
 *
 * Pure on purpose — no `fetch`, no `caches`, no DOM, no import of anything that has them. It is the
 * only file that decides what may be served from a cache, so it is the file the tests own, and it
 * has to be importable from a plain `vitest` run in Node. `service-worker.ts` next to it does the
 * I/O and nothing else.
 */

/**
 * - `shell` — a navigation. Network first, the cached `index.html` when the network is not there.
 * - `asset` — a content-hashed build output. Cache first; the hash is in the name, so a hit is by
 *   construction the file that name meant.
 * - `menu` — stale-while-revalidate. The single API response worth caching (see below).
 * - `passthrough` — **the worker does not call `respondWith` at all.** The request goes to the
 *   network exactly as it would with no worker installed.
 */
export type CacheRoute = 'shell' | 'asset' | 'menu' | 'passthrough';

/** Everything `classifyRequest` needs from a `Request`, so a test does not have to build one. */
export interface ClassifiableRequest {
  readonly method: string;
  readonly url: string;
  /** `RequestInit['mode']`; `'navigate'` is what a document load reports. */
  readonly mode: string;
}

/**
 * Static shell paths that are safe to serve cache-first. `index.html` is deliberately **not** here:
 * it is not content-hashed, so it goes through `shell` and is refreshed whenever the network is up.
 */
const SHELL_ASSET_PATHS = new Set(['/manifest.webmanifest', '/favicon.ico']);

const ASSET_PREFIXES = ['/assets/', '/icons/'];

/**
 * This is an **allow-list**, not a deny-list, and that is the whole design.
 *
 * A deny-list is one new endpoint away from quietly caching a mutation. Under an allow-list a new
 * endpoint is `passthrough` until someone writes it down here and a test says why. Which matters
 * most for the ones that would be catastrophic rather than merely stale:
 *
 * - `POST /api/orders/:id/mutations` — replaying a cached response would fabricate an ack for a
 *   mutation the server never saw, and the sync engine would drop it from the queue.
 * - `POST /api/kitchen/orders/:id/{start,ready}` — same, for the §17 adapters.
 * - `GET /api/orders/:id` — the canonical read. A stale snapshot here silently replaces the
 *   server's truth, which is worse than an error: the conflict machinery would never fire.
 * - `/api/debug/*`, `/api/config`, `/api/kitchen/tickets`, `/api/presence` — `/debug` and `/demo`
 *   poll these every two seconds and the numbers are the demo.
 * - `/socket.io/*` — a cached handshake is a transport that never establishes.
 *
 * `GET /api/menu` is the one exception, and only because it is eleven seeded products that change
 * when the seed changes, never during a session. Serving it stale while a revalidation runs is
 * what lets a cold offline reload draw the product grid at all.
 *
 * The offline *data* story is not here and must not move here: the queue and the last snapshot are
 * Dexie's (ADR 013). A second cache over the same data would drift from it.
 */
export function classifyRequest(request: ClassifiableRequest, origin: string): CacheRoute {
  // Before anything else: a cache is a map keyed by GET. Anything else is passthrough, and that
  // covers every mutation without naming one.
  if (request.method !== 'GET') return 'passthrough';

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return 'passthrough';
  }

  // Cross-origin is somebody else's cache policy.
  if (url.origin !== origin) return 'passthrough';

  // A navigation, however deep the client route. `try_files ... /index.html` in nginx (and Vite's
  // history fallback) means every one of them is the same document.
  if (request.mode === 'navigate') return 'shell';

  if (url.pathname === '/api/menu') return 'menu';

  // No `/api` or `/socket.io` response is cacheable beyond the line above, and saying so before
  // the asset check means a future `/api/assets/...` cannot fall through into it.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) {
    return 'passthrough';
  }

  if (SHELL_ASSET_PATHS.has(url.pathname)) return 'asset';
  if (ASSET_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return 'asset';

  return 'passthrough';
}
