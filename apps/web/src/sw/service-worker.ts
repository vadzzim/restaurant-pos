/// <reference lib="webworker" />

/**
 * The service worker: the app **shell** offline, and nothing else.
 *
 * The offline story that matters — the pending mutation queue and the last order snapshot — is
 * Dexie's and has been since M8 (ADR 013). What was missing was the boring half: with no network,
 * a hard reload never got as far as running that code, because index.html, the JS and the CSS come
 * from the server. This file closes that gap and deliberately stops there. If a later session finds
 * itself caching an order here, the answer is that IndexedDB already holds it and two caches over
 * one dataset drift.
 *
 * Built separately from the app (see `vite/service-worker-plugin.ts`) into a single classic
 * script, so it has no `import` at runtime and needs no `{ type: 'module' }` registration.
 */

import { classifyRequest } from './cache-policy';

// Injected by the build plugin: one cache name per build, so `activate` can drop everything that
// is not this build's.
declare const __SW_BUILD__: string;

// `self` is typed as a plain `WorkerGlobalScope` by the `webworker` lib, which has no
// `skipWaiting`, `clients` or the extendable events. This is the standard narrowing, and the only
// cast in the file.
const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE_NAME = `pos-shell-${__SW_BUILD__}`;

/**
 * Every navigation resolves to the same document — nginx does `try_files $uri $uri/ /index.html`
 * and Vite's dev server the same — so all client routes share one cache entry rather than one per
 * URL the operator happened to visit before going offline.
 */
const SHELL_KEY = '/index.html';

const openCache = (): Promise<Cache> => caches.open(CACHE_NAME);

sw.addEventListener('install', (event) => {
  // The only thing precached: the document. Not a build-time asset list — the hashed bundle is
  // cached as it is fetched by the very load that installed this worker, which is the same load
  // that must have happened before anyone can go offline. A generated precache manifest would buy
  // a first-visit-then-immediately-offline case nobody has, at the cost of build plumbing that
  // rots silently when the output layout changes.
  event.waitUntil(openCache().then((cache) => cache.add(SHELL_KEY)));

  // Take over as soon as installed rather than waiting for every tab to close. Deliberate, and
  // recorded in ADR 017: the demo's failure mode is an interviewer reloading and being served last
  // week's bundle. It is safe here because the app has no lazily imported chunks — `router.ts`
  // imports all four views statically — so a page running the old bundle cannot ask for a chunk
  // this build's cache no longer holds.
  void sw.skipWaiting();
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)),
      );
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener('fetch', (event) => {
  const route = classifyRequest(event.request, sw.location.origin);

  // `passthrough` means exactly that: no `respondWith`, so the browser performs the request as if
  // no worker were installed. Every mutation, every `/api/debug` poll and the whole Socket.IO
  // transport take this branch.
  if (route === 'passthrough') return;

  if (route === 'shell') {
    event.respondWith(networkFirstShell(event.request));
    return;
  }

  if (route === 'asset') {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  event.respondWith(staleWhileRevalidate(event.request));
});

/** Navigations: the network's answer when there is one, the last good document when there is not. */
async function networkFirstShell(request: Request): Promise<Response> {
  try {
    const response = await fetch(request);
    // A redirected response cannot be replayed for a navigation later — the browser rejects it —
    // so it is served but never stored.
    if (response.ok && !response.redirected) {
      const cache = await openCache();
      await cache.put(SHELL_KEY, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(SHELL_KEY);
    if (cached) return cached;
    throw error;
  }
}

/** Content-hashed build output: the name pins the bytes, so a hit needs no revalidation. */
async function cacheFirst(request: Request): Promise<Response> {
  const cache = await openCache();
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

/** `GET /api/menu` only. Draws immediately from the cache, and refreshes it for the next load. */
async function staleWhileRevalidate(request: Request): Promise<Response> {
  const cache = await openCache();
  const cached = await cache.match(request);

  const fromNetwork = fetch(request).then(async (response) => {
    if (response.ok) await cache.put(request, response.clone());
    return response;
  });

  if (!cached) return fromNetwork;
  // Offline, the revalidation rejects; without this the unhandled rejection is reported as a
  // worker error even though the cached response is the correct answer.
  fromNetwork.catch(() => undefined);
  return cached;
}
