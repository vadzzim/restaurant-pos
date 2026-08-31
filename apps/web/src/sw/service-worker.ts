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

import { classifyRequest, MENU_PATH, shellAssetUrls } from './cache-policy';

// Injected by the build plugin: one cache name per build, so `activate` can drop everything that
// is not this build's.
declare const __SW_BUILD__: string;

// `self` is typed as a plain `WorkerGlobalScope` by the `webworker` lib, which has no
// `skipWaiting`, `clients` or the extendable events. This is the standard narrowing, and the only
// cast in the file.
const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE_PREFIX = 'pos-shell-';
const CACHE_NAME = `${CACHE_PREFIX}${__SW_BUILD__}`;

/**
 * How many build caches survive `activate`: this build's, and the one before it.
 *
 * **Two, not one, and that is the whole of M23's P2.** `skipWaiting` + `clientsClaim` means the new
 * worker takes over pages that are still *running the old bundle* — and since M23 those pages are
 * no longer reloaded out from under the operator, they are offered a banner and may sit there for as
 * long as the operator likes (`pwa/update.ts`). Deleting the old build's cache under one of them
 * used to be harmless only because `router.ts` imports all four views statically, so there was no
 * chunk left to ask for; ADR 017 named code splitting as the condition to revisit and this is that
 * revisit, done before the condition rather than after it.
 *
 * One generation of slack is enough because a page can only be one build behind: the build after
 * next cannot be installed without a reload, and a reload is what leaves the old bundle behind.
 */
const GENERATIONS_KEPT = 2;

/**
 * Every navigation resolves to the same document — nginx does `try_files $uri $uri/ /index.html`
 * and Vite's dev server the same — so all client routes share one cache entry rather than one per
 * URL the operator happened to visit before going offline.
 */
const SHELL_KEY = '/index.html';

const openCache = (): Promise<Cache> => caches.open(CACHE_NAME);

/**
 * **Every cache read passes this, and removing it breaks the offline reload.**
 *
 * `Cache.match` honours the cached response's `Vary` by comparing the stored request's headers
 * with the incoming one's. Vite's preview server — and any server behind a proxy — answers with
 * `Vary: Origin`. The precache fetches these URLs from inside the worker, where there is no
 * `Origin` header; the page then asks for the very same bundle with `crossorigin="anonymous"` on
 * the tag, which *does* send `Origin`. The headers differ, `Vary` says no match, and offline the
 * fallback `fetch` fails: the document loads from cache and its script and stylesheet do not.
 *
 * That is a browser-only failure — a fake `CacheStorage` ignores `Vary`, so no unit test can see
 * it — and it was found by driving a real Chrome with the server killed.
 *
 * Ignoring `Vary` is correct rather than merely convenient here: the shell and the bundle are one
 * representation per URL, and for `/assets/` the content hash *is* in the name.
 */
const MATCH: CacheQueryOptions = { ignoreVary: true };

sw.addEventListener('install', (event) => {
  event.waitUntil(tryPrecacheShell());

  // Take over as soon as installed rather than waiting for every tab to close. Deliberate, and
  // recorded in ADR 017: the demo's failure mode is an interviewer reloading and being served last
  // week's bundle. What makes it safe is no longer that the app has no lazily imported chunks: since
  // M23 a claimed page may ask for one, and `GENERATIONS_KEPT` plus `cacheFirst`'s cross-cache
  // fallback are what answer it.
  void sw.skipWaiting();
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await Promise.all(staleCaches(await caches.keys()).map((name) => caches.delete(name)));
      await sw.clients.claim();
    })(),
  );
});

/**
 * Which caches `activate` drops: anything that is not ours at all, plus every build of ours older
 * than the newest one we are not.
 *
 * Ordering by name is sound rather than lucky: `__SW_BUILD__` is `Date.now()` stringified (see
 * `vite/service-worker-plugin.ts`), so the names are fixed-width decimals and lexical order *is*
 * chronological order.
 *
 * Not exported: the build is a classic `iife` with no exports (ADR 017), so this is asserted
 * through `activate` — which is the behaviour that matters anyway.
 */
function staleCaches(names: readonly string[]): string[] {
  const foreign = names.filter((name) => !name.startsWith(CACHE_PREFIX));
  const ours = names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).sort();
  // Counted from the front rather than written as `slice(0, -(GENERATIONS_KEPT - 1))`, which reads
  // the same and is a trap: at `GENERATIONS_KEPT === 1` that is `slice(0, -0)`, which is `slice(0,
  // 0)`, which deletes *nothing at all*. This form makes 1 mean "keep only this build".
  const older = ours.slice(0, Math.max(0, ours.length - (GENERATIONS_KEPT - 1)));
  return [...foreign, ...older];
}

sw.addEventListener('fetch', (event) => {
  const route = classifyRequest(event.request, sw.location.origin);

  // `passthrough` means exactly that: no `respondWith`, so the browser performs the request as if
  // no worker were installed. Every mutation, every `/api/debug` poll and the whole Socket.IO
  // transport take this branch.
  if (route === 'passthrough') return;

  if (route === 'shell') {
    event.respondWith(networkFirstShell(event));
    return;
  }

  if (route === 'asset') {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  event.respondWith(staleWhileRevalidate(event));
});

/**
 * The document, the assets the document names, and the menu.
 *
 * The bundle has to be precached here and cannot be picked up as it is fetched, because the page
 * load that installs this worker fetched it **before** the worker existed and `clients.claim()`
 * does not replay those requests. Left to runtime caching, a first visit followed by an offline
 * reload gets a cached `index.html` whose script then misses — a blank app, and M17's whole point.
 *
 * Still not a build-time manifest: the list is read out of the document that was just fetched, so
 * nothing has to be threaded through the build and there is no generated file to go stale.
 *
 * `/api/menu` is precached for exactly the same reason and is not an exception to "the worker owns
 * the shell, never data": it is the one API response on the allow-list, it is the seeded product
 * list rather than anything a terminal owns, and without it an offline reload draws an order with
 * no product grid to add to. It is *not* the order — that is Dexie's, and stays Dexie's.
 *
 * **Nothing here may fail the installation, the document included.** It used to: `install` waited
 * on this promise and a document fetch that threw left the worker stuck `installing` forever, so a
 * registration that happened to land in the second the network dropped produced *no* worker and
 * therefore no shell at all — strictly worse than a worker with an empty cache, which fills itself
 * on the first navigation that reaches the network (`networkFirstShell`). That recovery is why the
 * asset list is re-read there too: runtime caching alone never sees the bundle, because the page
 * that installed the worker fetched it before the worker existed.
 */
async function precacheShell(): Promise<void> {
  const cache = await openCache();

  // `cache: 'reload'` so an update installs against the server's document rather than whatever the
  // HTTP cache is still holding from the build before it.
  const document = await fetch(SHELL_KEY, { cache: 'reload' });
  if (!document.ok) throw new Error(`precache: ${SHELL_KEY} returned ${document.status}`);

  const html = await document.clone().text();
  await cache.put(SHELL_KEY, document);

  await precacheAssets(cache, html);
}

/**
 * The same-origin assets a document names, plus the menu. Best-effort, one `allSettled`: an asset
 * that 404s, or an API that is down while the static server is up, is not a failed shell.
 */
async function precacheAssets(cache: Cache, html: string): Promise<void> {
  await Promise.allSettled([
    ...shellAssetUrls(html, sw.location.origin).map((url) => cache.add(url)),
    cache.add(MENU_PATH),
  ]);
}

/**
 * Whether the shell and its assets are in the cache. False after an installation that could not
 * reach the network, and the flag the first successful navigation reads to make good on it.
 */
let shellPrecached = false;

async function tryPrecacheShell(): Promise<void> {
  try {
    await precacheShell();
    shellPrecached = true;
  } catch {
    // Swallowed on purpose: see `precacheShell`. Recovered by the first navigation that answers.
  }
}

/** Navigations: the network's answer when there is one, the last good document when there is not. */
async function networkFirstShell(event: FetchEvent): Promise<Response> {
  try {
    const response = await fetch(event.request);
    // A redirected response cannot be replayed for a navigation later — the browser rejects it —
    // so it is served but never stored.
    if (response.ok && !response.redirected) {
      const cache = await openCache();
      await cache.put(SHELL_KEY, response.clone());

      if (!shellPrecached) {
        // Set before the work, not after: a second navigation arriving while this one is still
        // fetching assets must not start a duplicate pass.
        shellPrecached = true;
        const html = await response.clone().text();
        // On the event's lifetime rather than the response's, so the operator's page is not held
        // waiting for assets it already has. Rejection is impossible — `precacheAssets` settles —
        // but the `catch` is what says that is not being relied on.
        event.waitUntil(precacheAssets(cache, html).catch(() => undefined));
      }
    }
    return response;
  } catch (error) {
    const cached = await caches.match(SHELL_KEY, MATCH);
    if (cached) return cached;
    throw error;
  }
}

/**
 * Content-hashed build output: the name pins the bytes, so a hit needs no revalidation.
 *
 * **The fallback across every cache is load-bearing.** A page still running the previous build asks
 * for that build's chunks, and this build's cache has never held them. `caches.match` reaches the
 * one generation `activate` kept, which is the other half of the same fix; without it, keeping the
 * cache would buy nothing.
 */
async function cacheFirst(request: Request): Promise<Response> {
  const cache = await openCache();
  const cached = (await cache.match(request, MATCH)) ?? (await caches.match(request, MATCH));
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

/** `GET /api/menu` only. Draws immediately from the cache, and refreshes it for the next load. */
async function staleWhileRevalidate(event: FetchEvent): Promise<Response> {
  const { request } = event;
  const cache = await openCache();
  const cached = await cache.match(request, MATCH);

  const fromNetwork = fetch(request).then(async (response) => {
    if (response.ok) await cache.put(request, response.clone());
    return response;
  });

  if (!cached) return fromNetwork;

  // The event takes the whole `respondWith` promise as its lifetime, so answering from the cache
  // ends it — and a worker with no pending work may be killed at any moment, taking the refresh
  // with it and leaving the menu stale for good. `waitUntil` holds the worker open until the
  // refresh lands. Legal here because the event is still active: `respondWith` was handed a
  // promise that has not settled yet.
  //
  // The `catch` is not decoration. Offline this rejects, and a rejected promise handed to
  // `waitUntil` fails the event — reported as a worker error, when the cached response was in fact
  // the right answer. Swallowing it is both the lifetime and the rejection handled by one clause.
  event.waitUntil(fromNetwork.catch(() => undefined));
  return cached;
}
