import {
  flagBucket,
  type ConfigResponse,
  type FlagsResponse,
  type PresenceEntry,
  type PresenceReport,
} from '@pos/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { writeFlag } from '../src/modules/config/application/flag-store.js';
import type { FlagRow } from '../src/modules/config/application/flag-store.js';
import type { FlagCache } from '../src/modules/config/application/resolve-flags.js';
import type { PresenceOrigin, PresenceStore } from '../src/modules/debug/application/ports.js';
import { DEMO_RESTAURANT, SECOND_RESTAURANT, db, testApp, useTestDatabase } from './helpers.js';

useTestDatabase();

const PUSH = 'realtime.websocket_push';

/**
 * `feature_flags` is reference data, so it survives `truncateTransactionalTables` — which is what
 * makes it a flag rather than per-test state. Each test therefore puts it back where the seed left
 * it, or the first toggle here would leak into every later file.
 */
beforeEach(async () => {
  await writeFlag(db(), PUSH, { enabled: true, rolloutPercent: 100 });
});

const config = async (
  app: ReturnType<typeof buildApp>,
  restaurantId: string,
): Promise<ConfigResponse> => {
  const response = await app.inject({
    method: 'GET',
    url: `/api/config?restaurantId=${restaurantId}`,
  });
  expect(response.statusCode).toBe(200);
  return response.json<ConfigResponse>();
};

describe('the rollout hash', () => {
  /**
   * The demo in §15 — POS-1 and POS-3 on different transports at the same time — is only possible
   * because these two buckets differ, and the percentage that splits them is a fact about this
   * hash. If the hash ever changes, this test is what says the demo percentage changed with it.
   */
  it('puts the two seeded restaurants in buckets a percentage can separate', () => {
    expect(flagBucket(PUSH, DEMO_RESTAURANT)).toBe(1);
    expect(flagBucket(PUSH, SECOND_RESTAURANT)).toBe(24);
  });

  it('is stable across calls, so a restaurant does not change transport between two polls', () => {
    const first = flagBucket(PUSH, DEMO_RESTAURANT);
    expect(flagBucket(PUSH, DEMO_RESTAURANT)).toBe(first);
  });
});

describe('GET /api/config', () => {
  it('resolves the flag on for everyone at 100 percent', async () => {
    const app = testApp();

    expect((await config(app, DEMO_RESTAURANT)).flags[PUSH]).toBe(true);
    expect((await config(app, SECOND_RESTAURANT)).flags[PUSH]).toBe(true);
  });

  it('splits the two restaurants at a percentage between their buckets', async () => {
    const app = testApp();
    await writeFlag(db(), PUSH, { rolloutPercent: 10 });

    expect((await config(app, DEMO_RESTAURANT)).flags[PUSH]).toBe(true);
    expect((await config(app, SECOND_RESTAURANT)).flags[PUSH]).toBe(false);
  });

  it('is off for everyone when the master switch is off, whatever the percentage says', async () => {
    const app = testApp();
    await writeFlag(db(), PUSH, { enabled: false, rolloutPercent: 100 });

    expect((await config(app, DEMO_RESTAURANT)).flags[PUSH]).toBe(false);
    expect((await config(app, SECOND_RESTAURANT)).flags[PUSH]).toBe(false);
  });

  it('rejects a request with no restaurant', async () => {
    const response = await testApp().inject({ method: 'GET', url: '/api/config' });
    expect(response.statusCode).toBe(400);
  });
});

/** A cache that records what it was asked, so a test can see the table being skipped. */
function fakeCache(): {
  cache: FlagCache;
  calls: { reads: number; writes: number; invalidations: number };
} {
  let stored: FlagRow[] | undefined;
  const calls = { reads: 0, writes: 0, invalidations: 0 };

  const cache: FlagCache = {
    read: async () => {
      calls.reads += 1;
      return stored;
    },
    write: async (rows: FlagRow[]) => {
      calls.writes += 1;
      stored = rows;
    },
    invalidate: async () => {
      calls.invalidations += 1;
      stored = undefined;
    },
  };

  return { cache, calls };
}

describe('the flag cache', () => {
  it('fills on a miss and answers the next request without the table', async () => {
    const { cache, calls } = fakeCache();
    const app = buildApp({ db: db(), logLevel: 'silent', flagCache: cache });

    await config(app, DEMO_RESTAURANT);
    expect(calls.writes).toBe(1);

    // Written behind the API's back, so the table and the cache now disagree. The cached answer is
    // the one that must come out — otherwise nothing was cached.
    await writeFlag(db(), PUSH, { enabled: false });
    expect((await config(app, DEMO_RESTAURANT)).flags[PUSH]).toBe(true);
    expect(calls.writes).toBe(1);
  });

  it('falls back to the table when the cache throws, rather than failing the request', async () => {
    const broken: FlagCache = {
      read: () => Promise.reject(new Error('redis is down')),
      write: () => Promise.reject(new Error('redis is down')),
      invalidate: () => Promise.reject(new Error('redis is down')),
    };
    const app = buildApp({ db: db(), logLevel: 'silent', flagCache: broken });

    expect((await config(app, DEMO_RESTAURANT)).flags[PUSH]).toBe(true);
  });

  it('is invalidated by a write, so a toggle takes effect without a restart', async () => {
    const { cache, calls } = fakeCache();
    const app = buildApp({ db: db(), logLevel: 'silent', flagCache: cache });

    await config(app, DEMO_RESTAURANT);

    const response = await app.inject({
      method: 'POST',
      url: `/api/debug/flags/${PUSH}`,
      payload: { enabled: false },
    });

    expect(response.statusCode).toBe(200);
    expect(calls.invalidations).toBe(1);
    expect((await config(app, DEMO_RESTAURANT)).flags[PUSH]).toBe(false);
  });
});

describe('POST /api/debug/flags/:key', () => {
  it('answers with every flag, its resolution and its bucket', async () => {
    const app = testApp();
    const response = await app.inject({
      method: 'POST',
      url: `/api/debug/flags/${PUSH}`,
      payload: { rolloutPercent: 10 },
    });

    expect(response.statusCode).toBe(200);
    const [flag] = response.json<FlagsResponse>().flags;
    expect(flag?.rolloutPercent).toBe(10);
    expect(flag?.enabled).toBe(true);
    expect(flag?.resolved).toEqual([
      { restaurantId: DEMO_RESTAURANT, enabled: true, bucket: 1 },
      { restaurantId: SECOND_RESTAURANT, enabled: false, bucket: 24 },
    ]);
  });

  it('patches one field and leaves the other alone', async () => {
    const app = testApp();

    await app.inject({
      method: 'POST',
      url: `/api/debug/flags/${PUSH}`,
      payload: { rolloutPercent: 40 },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/debug/flags/${PUSH}`,
      payload: { enabled: false },
    });

    const [flag] = response.json<FlagsResponse>().flags;
    expect(flag).toMatchObject({ enabled: false, rolloutPercent: 40 });
  });

  it('refuses an unknown key, a body that changes nothing, and a percentage out of range', async () => {
    const app = testApp();

    const unknown = await app.inject({ method: 'POST', url: '/api/debug/flags/nope', payload: {} });
    expect(unknown.statusCode).toBe(400);

    const empty = await app.inject({
      method: 'POST',
      url: `/api/debug/flags/${PUSH}`,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);

    const tooHigh = await app.inject({
      method: 'POST',
      url: `/api/debug/flags/${PUSH}`,
      payload: { rolloutPercent: 101 },
    });
    expect(tooHigh.statusCode).toBe(400);
  });
});

describe('POST /api/presence', () => {
  function recordingPresence(): PresenceStore & {
    touched: { report: PresenceReport; origin: PresenceOrigin }[];
  } {
    const touched: { report: PresenceReport; origin: PresenceOrigin }[] = [];
    return {
      touched,
      touch: async (report, origin) => {
        touched.push({ report, origin });
      },
      forget: async () => undefined,
      list: async (): Promise<PresenceEntry[]> => [],
    };
  }

  const report: PresenceReport = {
    terminalId: 'pos-3',
    restaurantId: SECOND_RESTAURANT,
    role: 'pos',
    pendingCount: 2,
    offline: false,
  };

  /**
   * The presence path that has no socket. Without it a terminal on the polling transport would be
   * absent from `/debug`'s panel — the panel the rollout demo relies on to show two terminals on
   * two transports.
   */
  it('records a report from a terminal with no socket', async () => {
    const presence = recordingPresence();
    const app = buildApp({ db: db(), logLevel: 'silent', presence });

    const response = await app.inject({ method: 'POST', url: '/api/presence', payload: report });

    expect(response.statusCode).toBe(202);
    expect(presence.touched).toEqual([{ report, origin: { source: 'polling' } }]);
  });

  it('rejects a report that is not one, with the same bounds the socket applies', async () => {
    const presence = recordingPresence();
    const app = buildApp({ db: db(), logLevel: 'silent', presence });

    const response = await app.inject({
      method: 'POST',
      url: '/api/presence',
      payload: { ...report, pendingCount: -1 },
    });

    expect(response.statusCode).toBe(400);
    expect(presence.touched).toHaveLength(0);
  });

  /** Redis is soft: a presence write that fails must not fail the terminal reporting it. */
  it('still answers when the store is unavailable', async () => {
    const app = buildApp({
      db: db(),
      logLevel: 'silent',
      presence: {
        touch: () => Promise.reject(new Error('redis is down')),
        forget: async () => undefined,
        list: async () => [],
      },
    });

    const response = await app.inject({ method: 'POST', url: '/api/presence', payload: report });
    expect(response.statusCode).toBe(202);
  });
});
