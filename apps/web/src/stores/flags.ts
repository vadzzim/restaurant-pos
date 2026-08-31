import type { FeatureFlagKey, FlagState } from '@pos/contracts';
import { defineStore } from 'pinia';
import { ref } from 'vue';

import { fetchFlags, postFlag } from '../api/client';
import { DEBUG_POLL_MS } from './debug';

/**
 * §16's feature-flag toggles, and the only other write surface on `/debug` besides §18's.
 *
 * It is the simulator store's shape on purpose (ADR 015): the response of a write is the new state
 * of every flag, so a toggle shows what it did without waiting for the poll — and the poll runs
 * anyway, because the same rows can be changed from another browser, from a second API instance, or
 * with a `psql` UPDATE.
 */
export const useFlagStore = defineStore('flags', () => {
  const flags = ref<FlagState[]>([]);
  const error = ref<string | undefined>();
  /**
   * Which flags have a request out — a set, not one key. It held a single key until M22, so two
   * overlapping toggles left the first button enabled while its own request was still in flight:
   * exactly the defect M20 fixed in the simulator store and did not fix here.
   */
  const busy = ref(new Set<FeatureFlagKey>());

  const isBusy = (key: FeatureFlagKey): boolean => busy.value.has(key);

  let timer: ReturnType<typeof setInterval> | undefined;

  async function refresh(): Promise<void> {
    try {
      flags.value = (await fetchFlags()).flags;
      error.value = undefined;
    } catch (caught) {
      // The last good state stays on screen: blanking the panel would read as "no flags are
      // enabled" at the moment the API is unreachable, which is the opposite of the truth.
      error.value = caught instanceof Error ? caught.message : String(caught);
    }
  }

  function start(): void {
    stop();
    void refresh();
    timer = setInterval(() => {
      void refresh();
    }, DEBUG_POLL_MS);
  }

  function stop(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  /**
   * One field at a time, so a toggle cannot reset a rollout percentage and a percentage cannot turn
   * the master switch back on. The server patches the same way.
   */
  async function update(
    key: FeatureFlagKey,
    patch: { enabled?: boolean | undefined; rolloutPercent?: number | undefined },
  ): Promise<void> {
    busy.value = new Set(busy.value).add(key);
    try {
      flags.value = (await postFlag(key, patch)).flags;
      error.value = undefined;
    } catch (caught) {
      error.value = caught instanceof Error ? caught.message : String(caught);
    } finally {
      const next = new Set(busy.value);
      next.delete(key);
      busy.value = next;
    }
  }

  return { flags, error, busy, isBusy, refresh, start, stop, update };
});
