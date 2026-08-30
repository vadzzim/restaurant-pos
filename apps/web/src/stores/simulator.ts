import type { SimulatorControl, SimulatorState } from '@pos/contracts';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { fetchSimulator, postSimulatorControl } from '../api/client';
import { isTerminalOffline, setTerminalOffline } from '../api/offline';
import {
  armStates,
  isArmed,
  isLatched,
  latchStates,
  recordSimulatorEffect,
  setArm,
  setLatch,
  simulatorEffects,
  type ClientLatch,
  type MutationArm,
} from '../api/simulator-arms';
import { DEBUG_POLL_MS } from './debug';

/**
 * The write half of `/debug`. `stores/debug.ts` stays exactly what M11 made it — five read-only
 * polls that write nothing anywhere — and every §18 button goes through here instead.
 *
 * The four server switches are one `POST` each and the response carries the new state, so a button
 * shows what it did without waiting for the poll. The poll exists anyway, because the same row can
 * be flipped by `pnpm -F @pos/worker outbox` from a terminal and by any other browser.
 */
export const useSimulatorStore = defineStore('simulator', () => {
  const state = ref<SimulatorState | undefined>();
  const error = ref<string | undefined>();
  const busy = ref<SimulatorControl | undefined>();

  let timer: ReturnType<typeof setInterval> | undefined;

  async function refresh(): Promise<void> {
    try {
      state.value = (await fetchSimulator()).state;
      error.value = undefined;
    } catch (caught) {
      // Same rule as the read panels: keep the last good state rather than blanking the switches,
      // which would read as "nothing is paused" at the moment the API is unreachable.
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

  async function send(
    control: SimulatorControl,
    label: string,
    body: Record<string, unknown> = {},
  ): Promise<void> {
    busy.value = control;
    try {
      const response = await postSimulatorControl(control, body);
      state.value = response.state;
      error.value = undefined;
      recordSimulatorEffect(label, describe(control, response.replayed));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      error.value = message;
      recordSimulatorEffect(label, message);
    } finally {
      busy.value = undefined;
    }
  }

  const pauseOutbox = (paused: boolean): Promise<void> =>
    send('outbox-pause', 'Pause Outbox Publisher', { enabled: paused });

  const delayOutbox = (publishDelayMs: number): Promise<void> =>
    send('outbox-delay', 'Delay Outbox Publishing', { publishDelayMs });

  const failPrinter = (failing: boolean): Promise<void> =>
    send('printer-fail', 'Fail Printer', { enabled: failing });

  const replayLastEvent = (): Promise<void> => send('replay-last-event', 'Replay Last Kafka Event');

  /** The two M8 switches, driven from here so the panel has one way to press a control. */
  function toggleOffline(terminalId: string): void {
    const offline = setTerminalOffline(terminalId, !isTerminalOffline(terminalId));
    recordSimulatorEffect(
      `Simulate ${terminalId.toUpperCase()} Offline`,
      offline ? 'the terminal now refuses every call.' : 'the terminal is calling again.',
    );
  }

  function toggleArmed(arm: MutationArm, label: string): void {
    const armed = !isArmed(arm);
    setArm(arm, armed);
    recordSimulatorEffect(label, armed ? 'armed for the next mutation.' : 'disarmed.');
  }

  function toggleLatched(latch: ClientLatch, label: string): void {
    const thrown = !isLatched(latch);
    setLatch(latch, thrown);
    recordSimulatorEffect(label, thrown ? 'on.' : 'off.');
  }

  return {
    state,
    error,
    busy,
    arms: computed(() => armStates.value),
    latches: computed(() => latchStates.value),
    effects: computed(() => simulatorEffects.value),
    offlineTerminal: (terminalId: string): boolean => isTerminalOffline(terminalId),
    refresh,
    start,
    stop,
    pauseOutbox,
    delayOutbox,
    failPrinter,
    replayLastEvent,
    toggleOffline,
    toggleArmed,
    toggleLatched,
  };
});

function describe(control: SimulatorControl, replayed: unknown): string {
  if (control === 'printer-fail') {
    // Immediate, unlike the two outbox switches: the fake device reads its row on every print
    // rather than polling it, so there is no window to warn about.
    return 'the row is written; the next print reads it.';
  }

  if (control !== 'replay-last-event') {
    return 'the row is written; the publisher sees it within one OUTBOX_POLL_MS.';
  }

  if (replayed === null || replayed === undefined) {
    return 'nothing has been published yet, so there was nothing to replay.';
  }

  const event = replayed as { eventType: string; eventVersion: number; eventId: string };
  return `${event.eventType} v${event.eventVersion} (${event.eventId.slice(0, 8)}) is unpublished again.`;
}
