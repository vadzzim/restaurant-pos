import type {
  ConflictsDebugResponse,
  CounterReading,
  DependenciesResponse,
  EventsDebugResponse,
  MetricsResponse,
  OutboxDebugResponse,
} from '@pos/contracts';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import {
  fetchDebugConflicts,
  fetchDebugEvents,
  fetchDebugOutbox,
  fetchDependencies,
  fetchMetrics,
} from '../api/client';
import { groupCounters, type CounterGroup } from '../domain/debug-view';
import { localStore } from '../persistence/local-store';

/** Fast enough to watch a mutation travel the pipeline, slow enough not to be the load itself. */
export const DEBUG_POLL_MS = 2_000;

/**
 * The state behind `/debug`. **Read-only**: it polls five endpoints and reads this browser's own
 * sync counters, and it writes nothing anywhere. §18's controls are M12's and the feature-flag
 * toggles are M13's.
 *
 * The five reads are independent and each is allowed to fail on its own. A single
 * `Promise.all` that rejected would blank the whole page over one slow query — and the case that
 * matters most is exactly the one where something *is* wrong, so the panels that still work have
 * to keep working. Each section therefore keeps its last good payload and its own error line.
 */
export const useDebugStore = defineStore('debug', () => {
  const dependencies = ref<DependenciesResponse | undefined>();
  const metrics = ref<MetricsResponse | undefined>();
  const events = ref<EventsDebugResponse | undefined>();
  const conflicts = ref<ConflictsDebugResponse | undefined>();
  const outbox = ref<OutboxDebugResponse | undefined>();

  const errors = ref<Record<string, string | undefined>>({});
  const lastLoadedAt = ref<string | undefined>();
  const loading = ref(false);

  /** This browser's §20 counters, read from IndexedDB rather than from the API (see `db.ts`). */
  const clientCounters = ref<CounterReading[]>([]);

  let timer: ReturnType<typeof setInterval> | undefined;

  async function load<T>(key: string, read: () => Promise<T>, into: { value: T | undefined }) {
    try {
      into.value = await read();
      errors.value = { ...errors.value, [key]: undefined };
    } catch (error) {
      // The last good payload is deliberately kept: a panel that empties on a transient failure
      // tells the reader the system is empty, which is a different and much worse claim.
      errors.value = {
        ...errors.value,
        [key]: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function readClientCounters(): Promise<void> {
    const rows = await localStore.readSyncCounters();

    clientCounters.value = [
      {
        name: 'offlineSyncSuccesses',
        value: rows.reduce((total, row) => total + row.successes, 0),
        source: 'client',
        note: describeTerminals(rows.map((row) => `${row.terminalId}: ${row.successes}`)),
      },
      {
        name: 'offlineSyncFailures',
        value: rows.reduce((total, row) => total + row.failures, 0),
        source: 'client',
        note: describeTerminals(rows.map((row) => `${row.terminalId}: ${row.failures}`)),
      },
    ];
  }

  async function refresh(): Promise<void> {
    loading.value = true;
    try {
      await Promise.all([
        load('dependencies', fetchDependencies, dependencies),
        load('metrics', fetchMetrics, metrics),
        load('events', fetchDebugEvents, events),
        load('conflicts', fetchDebugConflicts, conflicts),
        load('outbox', fetchDebugOutbox, outbox),
        readClientCounters(),
      ]);
      lastLoadedAt.value = new Date().toISOString();
    } finally {
      loading.value = false;
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
   * The counter panel: the server's readings and this browser's, grouped by where each came from.
   * They are concatenated rather than merged because they answer to different lifetimes, and the
   * grouping is what puts that on screen.
   */
  const counterGroups = computed<CounterGroup[]>(() =>
    groupCounters([...(metrics.value?.counters ?? []), ...clientCounters.value]),
  );

  return {
    dependencies,
    metrics,
    events,
    conflicts,
    outbox,
    errors,
    loading,
    lastLoadedAt,
    counterGroups,
    refresh,
    start,
    stop,
  };
});

function describeTerminals(parts: string[]): string {
  return parts.length === 0 ? 'no sync pass has run in this browser yet' : parts.join(', ');
}
