import { beforeEach, describe, expect, it, vi } from 'vitest';

import { classifyRequest } from '../src/sw/cache-policy';

/**
 * The worker's I/O, exercised against a fake `CacheStorage` and a fake `fetch`.
 *
 * `cache-policy.test.ts` proves what *may* be cached; this proves what the worker then *does* —
 * that a navigation falls back to the cached document when the network is gone (the milestone's
 * whole point), that a passthrough request is never answered from the worker at all, and that
 * `activate` drops the previous build's cache.
 *
 * It lives in `tsconfig.sw.json`, not the app's project, for the same reason the worker does:
 * `WebWorker` and `DOM` cannot share one `lib`.
 */

type Listener = (event: FakeEvent) => void;

interface FakeEvent {
  readonly request: Request;
  respondWith(response: Promise<Response>): void;
  waitUntil(work: Promise<unknown>): void;
}

interface Entry {
  readonly response: Response;
  /** The headers of the request this entry was stored against, which is what `Vary` compares. */
  readonly requestHeaders: Headers;
}

/**
 * Models `Vary`, because not modelling it is how a real defect reached a real browser: the
 * precache stores the bundle from inside the worker, where there is no `Origin` header, and the
 * page then asks for it with `crossorigin` set, which sends one. Under `Vary: Origin` those do
 * not match, and offline the fallback `fetch` fails.
 */
class FakeCache {
  readonly entries = new Map<string, Entry>();

  put(request: Request | string, response: Response): Promise<void> {
    this.entries.set(keyOf(request), { response, requestHeaders: headersOf(request) });
    return Promise.resolve();
  }

  match(request: Request | string, options?: CacheQueryOptions): Promise<Response | undefined> {
    const entry = this.entries.get(keyOf(request));
    if (!entry) return Promise.resolve(undefined);

    if (!options?.ignoreVary) {
      const vary = entry.response.headers.get('vary');
      const incoming = headersOf(request);
      const mismatched = (vary ?? '')
        .split(',')
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean)
        .some((name) => entry.requestHeaders.get(name) !== incoming.get(name));
      if (mismatched) return Promise.resolve(undefined);
    }

    return Promise.resolve(entry.response);
  }

  async add(request: Request | string): Promise<void> {
    // As in a worker: the precache fetch carries no `Origin`.
    await this.put(request, await fetch(keyOf(request)));
  }
}

const headersOf = (request: Request | string): Headers =>
  typeof request === 'string' ? new Headers() : request.headers;

// The real Cache API keys on the full URL whether it was handed a string or a `Request`.
const keyOf = (request: Request | string): string =>
  new URL(typeof request === 'string' ? request : request.url, 'https://pos.test').href;

const cacheStore = new Map<string, FakeCache>();
const listeners = new Map<string, Listener>();

const skipWaiting = vi.fn();
const claim = vi.fn();

/** How many times the handler extended the event's lifetime, reset per test. */
let extended = 0;

/** What the network returns, per pathname. `null` means "the network is not there". */
let network: Map<string, Response | null>;

function fakeFetch(input: Request | string): Promise<Response> {
  const url = typeof input === 'string' ? input : input.url;
  // A navigation resolves to the document whatever the path, because that is what the server does:
  // `try_files $uri $uri/ /index.html` in nginx, and Vite's history fallback in `preview`.
  const path =
    typeof input !== 'string' && input.mode === 'navigate'
      ? '/index.html'
      : new URL(url, 'https://pos.test').pathname;
  const canned = network.get(path);
  if (canned === undefined || canned === null) {
    return Promise.reject(new TypeError(`offline: ${path}`));
  }
  return Promise.resolve(canned.clone());
}

/** Dispatches one event and waits for whatever the handler registered. */
async function dispatch(type: string, request?: Request): Promise<Response | 'passthrough'> {
  const listener = listeners.get(type);
  if (!listener) throw new Error(`no ${type} listener registered`);

  const pending: Promise<unknown>[] = [];
  let answered: Promise<Response> | undefined;

  listener({
    request: request ?? new Request('https://pos.test/'),
    respondWith: (response) => {
      answered = response;
      pending.push(response);
    },
    waitUntil: (work) => {
      extended += 1;
      pending.push(work);
    },
  });

  // Drained in waves, not with one `Promise.all`: a handler registers `waitUntil` only after its
  // first `await`, so the array grows while we are waiting on it. Snapshotting it once would let a
  // late registration — which is exactly what the menu's revalidation is — go unawaited, and a
  // rejection in it would pass silently instead of failing the event as it would in a worker.
  for (let drained = 0; drained < pending.length;) {
    const wave = pending.slice(drained);
    drained = pending.length;
    await Promise.all(wave);
  }

  return answered ? await answered : 'passthrough';
}

const get = (path: string, init: RequestInit = {}): Request =>
  new Request(`https://pos.test${path}`, init);

// A navigation. `Request`'s own constructor refuses `mode: 'navigate'` — only the browser can make
// one — so this is a stand-in carrying the three fields the worker reads. The first test asserts
// `classifyRequest` calls it a `shell`, so the stand-in cannot drift from the real thing.
const navigation = (path: string): Request =>
  ({ method: 'GET', url: `https://pos.test${path}`, mode: 'navigate' }) as unknown as Request;

beforeEach(async () => {
  cacheStore.clear();
  listeners.clear();
  skipWaiting.mockClear();
  claim.mockClear();
  extended = 0;
  network = new Map([
    [
      '/index.html',
      new Response(
        '<!doctype html><title>Restaurant POS</title>' +
          '<script type="module" crossorigin src="/assets/index-abc123.js"></script>',
      ),
    ],
    ['/assets/index-abc123.js', new Response('console.log(1)')],
    ['/api/menu', new Response('[{"id":"p-1"}]')],
    ['/api/orders/o-1/mutations', new Response('{"status":"APPLIED"}')],
  ]);

  vi.stubGlobal('fetch', fakeFetch);
  vi.stubGlobal('caches', {
    open: (name: string) => {
      const existing = cacheStore.get(name) ?? new FakeCache();
      cacheStore.set(name, existing);
      return Promise.resolve(existing);
    },
    keys: () => Promise.resolve([...cacheStore.keys()]),
    delete: (name: string) => Promise.resolve(cacheStore.delete(name)),
    match: async (request: Request | string, options?: CacheQueryOptions) => {
      for (const cache of cacheStore.values()) {
        const hit = await cache.match(request, options);
        if (hit) return hit;
      }
      return undefined;
    },
  });
  vi.stubGlobal('self', {
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting,
    clients: { claim },
    location: { origin: 'https://pos.test' },
  });
  vi.stubGlobal('__SW_BUILD__', 'build-2');

  // Fresh module per test: the worker registers its listeners at import time.
  vi.resetModules();
  await import('../src/sw/service-worker');
});

describe('the service worker', () => {
  /**
   * The bundle, not just the document. The load that installs the worker fetched the script before
   * the worker existed, so runtime caching never sees it and the first offline reload would render
   * a cached `index.html` whose script misses.
   */
  it('precaches the document and the bundle it names, and takes over immediately', async () => {
    await dispatch('install');

    expect(skipWaiting).toHaveBeenCalledOnce();
    const cache = cacheStore.get('pos-shell-build-2');
    expect(await cache?.match('/index.html')).toBeDefined();
    expect(await cache?.match(get('/assets/index-abc123.js'))).toBeDefined();
  });

  /**
   * `/api/menu` loses the same race as the bundle: the first page load fetches it before the worker
   * controls anything, so runtime caching never sees it and an offline reload draws an order with
   * no product grid to add to.
   */
  it('precaches the menu, the one API response on the allow-list', async () => {
    await dispatch('install');

    const cached = await cacheStore.get('pos-shell-build-2')?.match(get('/api/menu'));
    expect(await cached?.text()).toBe('[{"id":"p-1"}]');
  });

  it('serves the menu from the cache on a first offline load', async () => {
    await dispatch('install');
    network.set('/api/menu', null);

    const response = await dispatch('fetch', get('/api/menu'));

    expect(await (response as Response).text()).toBe('[{"id":"p-1"}]');
  });

  it.each([
    ['an asset the document names', '/assets/index-abc123.js'],
    ['the menu, when the API is down but the static server is up', '/api/menu'],
  ])('installs even when %s cannot be fetched', async (_label, path) => {
    network.set(path, null);

    await expect(dispatch('install')).resolves.toBe('passthrough');
    expect(await cacheStore.get('pos-shell-build-2')?.match('/index.html')).toBeDefined();
  });

  /**
   * M23. It used to reject, and ADR 017 argued for that: without the document there is no shell, so
   * fail loudly. The argument was wrong in the one case it mattered — a registration landing in the
   * second the network drops leaves the worker stuck `installing` forever, which is *no* worker and
   * therefore no shell at all, rather than an empty one that fills itself.
   */
  it('installs even when the document itself cannot be fetched', async () => {
    network.set('/index.html', null);

    await expect(dispatch('install')).resolves.toBe('passthrough');
  });

  /**
   * ...and makes good on it. The bundle is the part runtime caching can never pick up on its own —
   * the page that installed the worker fetched it before the worker existed — so the first
   * navigation that reaches the network re-reads the asset list out of the document it just got.
   *
   * Without that recovery the second half of this test fails: the document is cached by
   * `networkFirstShell` either way, and its script is not.
   */
  it('precaches the assets it missed on the first navigation that answers', async () => {
    network.set('/index.html', null);
    await dispatch('install');

    network.set(
      '/index.html',
      new Response(
        '<!doctype html><title>Restaurant POS</title>' +
          '<script type="module" crossorigin src="/assets/index-abc123.js"></script>',
      ),
    );
    await dispatch('fetch', navigation('/pos/pos-1'));

    network.set('/index.html', null);
    network.set('/assets/index-abc123.js', null);
    const document = await dispatch('fetch', navigation('/pos/pos-1'));
    const script = await dispatch('fetch', get('/assets/index-abc123.js'));

    expect(await (document as Response).text()).toContain('Restaurant POS');
    expect(await (script as Response).text()).toBe('console.log(1)');
  });

  it('does not re-read the asset list on every navigation once the shell is precached', async () => {
    await dispatch('install');
    extended = 0;

    await dispatch('fetch', navigation('/pos/pos-1'));

    expect(extended).toBe(0);
  });

  /** The whole point, end to end: install online, then reload with nothing but the cache. */
  it('serves both the document and its bundle after the network is gone', async () => {
    await dispatch('install');
    network.set('/index.html', null);
    network.set('/assets/index-abc123.js', null);

    const document = await dispatch('fetch', navigation('/pos/pos-1'));
    const script = await dispatch('fetch', get('/assets/index-abc123.js'));

    expect(await (document as Response).text()).toContain('Restaurant POS');
    expect(await (script as Response).text()).toBe('console.log(1)');
  });

  /**
   * **M23, and the only P2 that was left in `known-problems.md`.** `skipWaiting` + `clientsClaim`
   * hands a page still running the old bundle to the new worker, and since M23 that page is offered
   * a banner rather than reloaded — so it may sit there. Dropping its cache underneath it is the
   * defect; one generation of slack is the fix.
   *
   * `pos-shell-build-0` proves the slack is *one*, not unbounded.
   */
  it('keeps the previous build and drops everything older, then claims its clients', async () => {
    cacheStore.set('pos-shell-build-0', new FakeCache());
    cacheStore.set('pos-shell-build-1', new FakeCache());
    cacheStore.set('a-cache-that-is-not-ours', new FakeCache());
    await dispatch('install');

    await dispatch('activate');

    expect([...cacheStore.keys()].sort()).toEqual(['pos-shell-build-1', 'pos-shell-build-2']);
    expect(claim).toHaveBeenCalledOnce();
  });

  /**
   * The half that makes keeping it worth anything: an `asset` miss in this build's cache falls back
   * across every cache, so a claimed page can still fetch a chunk only the previous build holds.
   * That is ADR 017's code-splitting condition, closed before the condition arrives.
   *
   * Deleting the `caches.match` fallback in `cacheFirst` reddens this; so does dropping
   * `GENERATIONS_KEPT` back to 1.
   */
  it('serves the previous build a lazy chunk only the previous build ever cached', async () => {
    const previous = new FakeCache();
    await previous.put('/assets/lazy-view-old.js', new Response('the old chunk'));
    cacheStore.set('pos-shell-build-1', previous);
    await dispatch('install');
    await dispatch('activate');

    // The old page asks for its chunk with nothing on the network to answer with.
    const response = await dispatch('fetch', get('/assets/lazy-view-old.js'));

    expect(await (response as Response).text()).toBe('the old chunk');
  });

  /**
   * **The P1 the Codex review of M23 found.** M23 gave `cacheFirst` a cross-cache fallback and left
   * `staleWhileRevalidate` reading this build's cache only. Compose the two new behaviours and that
   * gap is a broken till: an installation that could not reach the network activates *empty*, an
   * offline reload then serves the shell and the bundle out of the retained generation, and the menu
   * — which the same generation is holding — misses, so `menu.load()` aborts POS startup and the
   * operator gets an order with no product grid to add to.
   *
   * Reverting `matchAnyCache` to `cache.match` in `staleWhileRevalidate` reddens this and nothing
   * else, which is how the review found it in the first place.
   */
  it('serves the retained generation the menu after an installation that never reached the network', async () => {
    const previous = new FakeCache();
    await previous.put('/api/menu', new Response('[{"id":"p-from-the-old-build"}]'));
    cacheStore.set('pos-shell-build-1', previous);

    network.set('/index.html', null);
    await dispatch('install');
    await dispatch('activate');
    expect(cacheStore.get('pos-shell-build-1')).toBeDefined();

    network.set('/api/menu', null);
    const response = await dispatch('fetch', get('/api/menu'));

    expect(await (response as Response).text()).toBe('[{"id":"p-from-the-old-build"}]');
  });

  /** And the inheritance is one-way: the refresh writes into *this* build's cache, not the old one. */
  it('writes the revalidated menu into this build cache, not the one it inherited from', async () => {
    const previous = new FakeCache();
    await previous.put('/api/menu', new Response('[{"id":"p-old"}]'));
    cacheStore.set('pos-shell-build-1', previous);
    network.set('/index.html', null);
    await dispatch('install');

    network.set('/api/menu', new Response('[{"id":"p-new"}]'));
    await dispatch('fetch', get('/api/menu'));

    const mine = await cacheStore.get('pos-shell-build-2')?.match(get('/api/menu'));
    expect(await mine?.text()).toBe('[{"id":"p-new"}]');
    const theirs = await previous.match(get('/api/menu'));
    expect(await theirs?.text()).toBe('[{"id":"p-old"}]');
  });

  it('serves a navigation from the network while there is one, refreshing the shell', async () => {
    await dispatch('install');
    network.set('/index.html', new Response('<!doctype html><title>Newer</title>'));

    expect(classifyRequest(navigation('/pos/pos-1'), 'https://pos.test')).toBe('shell');
    const response = await dispatch('fetch', navigation('/pos/pos-1'));

    expect(response).not.toBe('passthrough');
    expect(await (response as Response).text()).toContain('Newer');
    const cached = await cacheStore.get('pos-shell-build-2')?.match('/index.html');
    expect(await cached?.text()).toContain('Newer');
  });

  /** The milestone: offline plus a hard reload has to reach the app, not the browser's error page. */
  it('falls back to the cached document when the network is gone', async () => {
    await dispatch('install');
    network.set('/index.html', null);

    const response = await dispatch('fetch', navigation('/pos/pos-1'));

    expect(await (response as Response).text()).toContain('Restaurant POS');
  });

  it('does not answer a navigation it has never cached', async () => {
    network.set('/index.html', null);

    await expect(dispatch('fetch', navigation('/pos/pos-1'))).rejects.toThrow(/offline/);
  });

  /**
   * The browser-only failure this fake now models. Vite's preview server answers `Vary: Origin`;
   * the precache fetch has no `Origin`, the page's `<script crossorigin>` request has one. Without
   * `ignoreVary` the cached bundle is invisible to the very request that needs it, and an offline
   * reload renders the shell with no app in it.
   */
  it('serves the bundle to a request carrying Origin though the response varies on it', async () => {
    network.set(
      '/assets/index-abc123.js',
      new Response('console.log(1)', { headers: { vary: 'Origin' } }),
    );
    await dispatch('install');
    network.set('/assets/index-abc123.js', null);

    const fromPage = get('/assets/index-abc123.js', {
      headers: { origin: 'https://pos.test' },
    });

    expect(await ((await dispatch('fetch', fromPage)) as Response).text()).toBe('console.log(1)');
  });

  it('serves a hashed asset from the cache once it has seen it, network gone or not', async () => {
    const first = await dispatch('fetch', get('/assets/index-abc123.js'));
    expect(await (first as Response).text()).toBe('console.log(1)');

    network.set('/assets/index-abc123.js', null);
    const second = await dispatch('fetch', get('/assets/index-abc123.js'));
    expect(await (second as Response).text()).toBe('console.log(1)');
  });

  /**
   * The refresh must be held by `waitUntil`. Answering from the cache settles the `respondWith`
   * promise, which ends the event's lifetime; a worker with no pending work may be killed at any
   * moment, and the menu would then stay stale for good.
   */
  it('serves the menu stale and holds the revalidation open with waitUntil', async () => {
    await dispatch('fetch', get('/api/menu'));
    network.set('/api/menu', new Response('[{"id":"p-2"}]'));
    extended = 0;

    // The cached copy answers this call...
    const stale = await dispatch('fetch', get('/api/menu'));
    expect(await (stale as Response).text()).toBe('[{"id":"p-1"}]');
    expect(extended).toBe(1);

    // ...and because the refresh was registered on the event, `dispatch` awaited it: no sleep, and
    // the next call gets what it wrote.
    const fresh = await dispatch('fetch', get('/api/menu'));
    expect(await (fresh as Response).text()).toBe('[{"id":"p-2"}]');
  });

  it('does not fail the event when the revalidation rejects offline', async () => {
    await dispatch('fetch', get('/api/menu'));
    network.set('/api/menu', null);

    // `dispatch` awaits everything the handler registered, so a rejection that was not swallowed
    // would surface right here — which is what it would do to the event in a real worker.
    const stale = await dispatch('fetch', get('/api/menu'));

    expect(await (stale as Response).text()).toBe('[{"id":"p-1"}]');
  });

  it('leaves a mutation entirely alone', async () => {
    const request = get('/api/orders/o-1/mutations', { method: 'POST', body: '{}' });
    expect(classifyRequest(request, 'https://pos.test')).toBe('passthrough');

    // No `respondWith`, so the browser performs the request itself and nothing is stored.
    expect(await dispatch('fetch', request)).toBe('passthrough');
    for (const cache of cacheStore.values()) {
      expect([...cache.entries.keys()]).not.toContain('https://pos.test/api/orders/o-1/mutations');
    }
  });

  it('leaves the canonical order read alone as well', async () => {
    expect(await dispatch('fetch', get('/api/orders/o-1'))).toBe('passthrough');
  });
});
