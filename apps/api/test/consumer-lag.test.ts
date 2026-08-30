import type { Admin, Kafka } from 'kafkajs';
import { describe, expect, it, vi } from 'vitest';

import { createConsumerLagProbe } from '../src/modules/debug/application/consumer-lag.js';

/**
 * The lag arithmetic, against a scripted admin client. No broker: what is worth testing here is
 * the subtraction and what happens when it cannot be done, and neither needs Redpanda.
 */

const TOPIC = 'restaurant.order.events';

interface Script {
  high: { partition: number; high: string }[];
  committed: Record<string, { partition: number; offset: string }[]>;
  fail?: Error;
  /** Holds `connect()` open, so a second probe can arrive while the first is still connecting. */
  connectGate?: Promise<void>;
}

function fakeKafka(script: Script): {
  kafka: Kafka;
  disconnect: ReturnType<typeof vi.fn>;
  built: () => number;
} {
  const disconnect = vi.fn(async () => undefined);
  let built = 0;

  const admin = {
    connect: async () => {
      await script.connectGate;
    },
    disconnect,
    fetchTopicOffsets: async () => {
      if (script.fail !== undefined) {
        throw script.fail;
      }
      return script.high.map((entry) => ({ ...entry, low: '0', offset: entry.high }));
    },
    fetchOffsets: async ({ groupId }: { groupId: string }) => [
      { topic: TOPIC, partitions: script.committed[groupId] ?? [] },
    ],
  } as unknown as Admin;

  return {
    kafka: {
      admin: () => {
        built += 1;
        return admin;
      },
    } as unknown as Kafka,
    disconnect,
    built: () => built,
  };
}

function probeFor(script: Script, groupIds = ['realtime', 'kitchen']) {
  const { kafka, disconnect, built } = fakeKafka(script);
  return {
    ...createConsumerLagProbe(kafka, { topic: TOPIC, groupIds, timeoutMs: 500 }),
    disconnect,
    built,
  };
}

describe('consumer lag', () => {
  it('sums the gap across every partition of the topic', async () => {
    const { probe, close } = probeFor({
      high: [
        { partition: 0, high: '100' },
        { partition: 1, high: '50' },
      ],
      committed: {
        realtime: [
          { partition: 0, offset: '90' },
          { partition: 1, offset: '50' },
        ],
        kitchen: [
          { partition: 0, offset: '100' },
          { partition: 1, offset: '50' },
        ],
      },
    });

    const reports = await probe();

    expect(reports).toEqual([
      { groupId: 'realtime', topic: TOPIC, lag: 10 },
      { groupId: 'kitchen', topic: TOPIC, lag: 0 },
    ]);

    await close();
  });

  it('counts a partition a group has never committed to as entirely behind', async () => {
    // `-1` is "this group has never committed here". Reading it as zero would report a consumer
    // that has never run as caught up — under ADR 012 that is a write concern, not a display one.
    const { probe, close } = probeFor(
      {
        high: [{ partition: 0, high: '42' }],
        committed: { kitchen: [{ partition: 0, offset: '-1' }] },
      },
      ['kitchen'],
    );

    expect(await probe()).toEqual([{ groupId: 'kitchen', topic: TOPIC, lag: 42 }]);

    await close();
  });

  it('counts a partition the group did not report at all', async () => {
    const { probe, close } = probeFor(
      { high: [{ partition: 3, high: '7' }], committed: { kitchen: [] } },
      ['kitchen'],
    );

    expect(await probe()).toEqual([{ groupId: 'kitchen', topic: TOPIC, lag: 7 }]);

    await close();
  });

  it('never reports a negative lag when a committed offset runs ahead of the watermark', async () => {
    // The two reads are not atomic, so a group can commit between them. A negative number on this
    // panel would read as a bug in the page rather than as a race in the broker.
    const { probe, close } = probeFor(
      {
        high: [{ partition: 0, high: '10' }],
        committed: { kitchen: [{ partition: 0, offset: '12' }] },
      },
      ['kitchen'],
    );

    expect(await probe()).toEqual([{ groupId: 'kitchen', topic: TOPIC, lag: 0 }]);

    await close();
  });

  it('builds one admin client when two polls overlap, not one per poll', async () => {
    // `/debug` polls every two seconds and a probe may take as long as its timeout, so overlapping
    // calls are the normal case rather than a race to be hand-waved. A second client built here
    // would be overwritten while still connected and never disconnected — a broker connection
    // whose retry timers hold the event loop open, so the API would not exit on SIGTERM.
    let open!: () => void;
    const connectGate = new Promise<void>((resolve) => {
      open = resolve;
    });

    const handle = probeFor(
      { high: [{ partition: 0, high: '5' }], committed: { kitchen: [] }, connectGate },
      ['kitchen'],
    );

    const first = handle.probe();
    const second = handle.probe();
    open();

    expect(await first).toEqual([{ groupId: 'kitchen', topic: TOPIC, lag: 5 }]);
    expect(await second).toEqual([{ groupId: 'kitchen', topic: TOPIC, lag: 5 }]);
    expect(handle.built()).toBe(1);

    await handle.close();
    expect(handle.disconnect).toHaveBeenCalledTimes(1);
  });

  it('reports a broker failure as a null lag with a reason, and throws the client away', async () => {
    const probeHandle = probeFor(
      {
        high: [],
        committed: {},
        fail: new Error('there is no leader for this topic-partition'),
      },
      ['kitchen'],
    );

    const [report] = await probeHandle.probe();

    expect(report?.lag).toBeNull();
    expect(report?.error).toContain('no leader');
    // A failed admin client does not recover on its own, so it is disconnected rather than reused.
    expect(probeHandle.disconnect).toHaveBeenCalled();

    await probeHandle.close();
  });
});
