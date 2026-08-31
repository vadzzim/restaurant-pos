import type { FeatureFlagKey } from '@pos/contracts';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useFlagStore } from '../src/stores/flags';

/**
 * §16's flag panel is the second write surface on `/debug`, and the only thing its two buttons
 * promise while a request is out is that they are disabled. Until M22 `busy` held a single key, so
 * two toggles inside one tick left the first button enabled — the defect M20 fixed in the
 * simulator store and did not fix here.
 *
 * The test is at the store, not the panel: `FlagPanel.vue` reads `isBusy(flag.key)` and nothing
 * else, so the store is where the claim lives.
 */

const PUSH: FeatureFlagKey = 'realtime.websocket_push';

/**
 * `FEATURE_FLAG_KEYS` holds one key today and the defect needs two. The panel renders whatever
 * `GET /api/debug/flags` returns, so a second flag is one server-side row away; asserting on the
 * store's contract rather than on today's seed is the point of the cast.
 */
const OTHER = 'realtime.presence_panel' as FeatureFlagKey;

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the flag store, mid-request', () => {
  /**
   * Two presses before either answers. A single-key `busy` reports the second one only, so the
   * first switch stays enabled and can be pressed again while its own request is still out.
   */
  it('reports every flag with a request out, not only the last one pressed', async () => {
    // Never resolves: both requests stay in flight for the length of the test.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => new Promise<Response>(() => undefined)),
    );

    const flags = useFlagStore();

    // No await: this is the two-taps-in-one-tick case, which is the only one that can fail.
    void flags.update(PUSH, { enabled: false });
    void flags.update(OTHER, { enabled: false });
    await Promise.resolve();

    expect(flags.isBusy(PUSH)).toBe(true);
    expect(flags.isBusy(OTHER)).toBe(true);
  });

  /** And the set empties again, or the panel would disable itself permanently after one press. */
  it('clears one key when its request settles and leaves the other alone', async () => {
    let answerPush: ((response: Response) => void) | undefined;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: unknown) => {
        if (String(input).includes(PUSH)) {
          return new Promise<Response>((resolve) => {
            answerPush = resolve;
          });
        }
        return new Promise<Response>(() => undefined);
      }),
    );

    const flags = useFlagStore();

    const push = flags.update(PUSH, { enabled: false });
    void flags.update(OTHER, { enabled: false });
    await Promise.resolve();

    answerPush?.(
      new Response(JSON.stringify({ flags: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await push;

    expect(flags.isBusy(PUSH)).toBe(false);
    expect(flags.isBusy(OTHER)).toBe(true);
  });
});
