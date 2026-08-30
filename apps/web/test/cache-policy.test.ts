import { describe, expect, it } from 'vitest';

import { classifyRequest, type CacheRoute } from '../src/sw/cache-policy';

const ORIGIN = 'http://localhost:5173';

const route = (url: string, overrides: { method?: string; mode?: string } = {}): CacheRoute =>
  classifyRequest(
    {
      method: overrides.method ?? 'GET',
      url: url.startsWith('http') ? url : `${ORIGIN}${url}`,
      mode: overrides.mode ?? 'cors',
    },
    ORIGIN,
  );

describe('classifyRequest', () => {
  it('serves every client route from the one shell entry', () => {
    for (const path of ['/', '/pos/pos-1', '/pos/bar-1', '/kitchen', '/debug', '/demo']) {
      expect(route(path, { mode: 'navigate' })).toBe('shell');
    }
  });

  it('caches the content-hashed build output and the static shell files', () => {
    expect(route('/assets/index-B7dK2f.js')).toBe('asset');
    expect(route('/assets/index-9aQ1x0.css')).toBe('asset');
    expect(route('/icons/icon-192.png')).toBe('asset');
    expect(route('/manifest.webmanifest')).toBe('asset');
    expect(route('/favicon.ico')).toBe('asset');
  });

  it('caches the menu, and only the menu, out of the whole API', () => {
    expect(route('/api/menu')).toBe('menu');
  });

  /**
   * The point of the milestone. Every one of these is an endpoint the app really calls — the list
   * is `src/api/client.ts` read top to bottom — and a cached answer to any of them is a defect,
   * not a slow page. `/api/orders/:id` above all: a stale snapshot does not look like an error, it
   * looks like the server's truth, and the conflict machinery would never fire.
   */
  it.each([
    ['POST', '/api/orders/o-1/mutations'],
    ['POST', '/api/orders/o-1/mutations/batch'],
    ['POST', '/api/kitchen/orders/o-1/start'],
    ['POST', '/api/kitchen/orders/o-1/ready'],
    ['POST', '/api/presence'],
    ['POST', '/api/debug/simulator/duplicate-next-mutation'],
    ['PATCH', '/api/debug/flags/realtime.websocket_push'],
    ['GET', '/api/orders/o-1'],
    ['GET', '/api/config?restaurantId=r-1'],
    ['GET', '/api/kitchen/tickets?restaurantId=r-1'],
    ['GET', '/api/debug/dependencies'],
    ['GET', '/api/debug/metrics'],
    ['GET', '/api/debug/events'],
    ['GET', '/api/debug/conflicts'],
    ['GET', '/api/debug/outbox'],
    ['GET', '/api/debug/simulator'],
    ['GET', '/api/debug/flags'],
    ['GET', '/api/health/ready'],
    ['GET', '/socket.io/?EIO=4&transport=polling'],
  ])('never caches %s %s', (method, path) => {
    expect(route(path, { method })).toBe('passthrough');
  });

  it('never caches a non-GET, whatever the path', () => {
    // Including the two paths that *are* cacheable as GETs, so the method check cannot be
    // reordered below the path checks without a failure.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
      expect(route('/api/menu', { method })).toBe('passthrough');
      expect(route('/assets/index-B7dK2f.js', { method })).toBe('passthrough');
      expect(route('/', { method, mode: 'navigate' })).toBe('passthrough');
    }
  });

  it('leaves cross-origin requests alone', () => {
    expect(route('https://cdn.example.com/assets/index-B7dK2f.js')).toBe('passthrough');
    expect(route('https://api.example.com/api/menu')).toBe('passthrough');
    expect(route('https://example.com/', { mode: 'navigate' })).toBe('passthrough');
  });

  it('does not let an API path fall through into the asset rule', () => {
    // `/api/` is checked before the prefixes, so this cannot become an `asset` if someone adds an
    // endpoint whose path happens to start that way.
    expect(route('/api/assets/report.csv')).toBe('passthrough');
    expect(route('/api/icons/icon-192.png')).toBe('passthrough');
  });

  it('treats an unparseable url as passthrough rather than throwing at the worker', () => {
    expect(classifyRequest({ method: 'GET', url: 'not a url', mode: 'cors' }, ORIGIN)).toBe(
      'passthrough',
    );
  });

  it('does not cache a path that merely resembles the menu', () => {
    expect(route('/api/menus')).toBe('passthrough');
    expect(route('/api/menu/extra')).toBe('passthrough');
  });
});
