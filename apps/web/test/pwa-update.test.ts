import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * M23: a new build offers itself instead of taking the tab.
 *
 * `register.ts` cannot be tested — it returns early unless `import.meta.env.PROD`, which is exactly
 * what makes it safe in dev (ADR 017) — so the decision it used to hold inline was moved into
 * `pwa/update.ts`, which is this. What is being asserted is the *absence* of a reload: before M23
 * the same event called `window.location.reload()`, and `window` is not defined here at all, so a
 * fix that left the reload in place would throw rather than pass.
 */

/** Fresh module per test: `updateReady` is module-level state, deliberately (ADR 015). */
async function load(): Promise<typeof import('../src/pwa/update')> {
  vi.resetModules();
  return await import('../src/pwa/update');
}

beforeEach(() => {
  vi.resetModules();
});

describe('the update banner', () => {
  it('is down until a controller is replaced', async () => {
    const { updateReady } = await load();

    expect(updateReady.value).toBe(false);
  });

  it('goes up when the worker controlling this page is replaced', async () => {
    const { onControllerChange, updateReady } = await load();

    onControllerChange(true);

    expect(updateReady.value).toBe(true);
  });

  /**
   * A first-ever install claims its clients — that is what `clientsClaim` is for — and fires the
   * same event. Announcing an update to a page that has just loaded the newest build is a banner
   * that is simply wrong, and it would appear on every first visit.
   */
  it('stays down for a first install claiming a page that had no controller', async () => {
    const { onControllerChange, updateReady } = await load();

    onControllerChange(false);

    expect(updateReady.value).toBe(false);
  });
});
