import type { ConsumerLagReport } from '@pos/contracts';
import type { Admin, Kafka } from 'kafkajs';

/**
 * Consumer lag, the one dependency number that needs a Kafka admin client.
 *
 * `/api/debug/dependencies` has reported everything except lag since M6, and `known-problems.md`
 * named it as the gap. It matters more here than the usual "how far behind is the read model",
 * because of ADR 012: the kitchen commands validate against the projection, so **the kitchen
 * projection is load-bearing for writes**. Lag on the kitchen group is not a display delay, it is
 * the window in which `START_PREPARING` takes a conflict it should not.
 *
 * Lag is `null`, never zero, when the broker cannot answer. A guessed zero on this panel reads as
 * "the kitchen is up to date" during exactly the outage it must not.
 */
export type ConsumerLagProbe = () => Promise<ConsumerLagReport[]>;

export interface LagProbeOptions {
  topic: string;
  groupIds: string[];
  timeoutMs: number;
}

/**
 * One lazily-connected admin client, reused. Connecting per request would open and close a broker
 * connection every two seconds while `/debug` is on screen; never disconnecting a *failed* client
 * would leave one that will not recover.
 */
export function createConsumerLagProbe(
  kafka: Kafka,
  options: LagProbeOptions,
): {
  probe: ConsumerLagProbe;
  close: () => Promise<void>;
} {
  /**
   * The **promise** of a client, not the client.
   *
   * `/debug` polls every two seconds and a probe is allowed to take as long as `timeoutMs`, so two
   * calls overlap routinely — and a guard that checked for a client, awaited `connect()`, and then
   * assigned would build two. One of them would be overwritten while still connected, and nothing
   * would ever disconnect it: a broker connection whose retry timers hold the event loop open, so
   * the API would not exit on SIGTERM. Memoising before the first await is what makes the second
   * caller join the first connection instead of starting its own.
   */
  let connecting: Promise<Admin> | undefined;
  let closed = false;

  function connected(): Promise<Admin> {
    if (connecting === undefined) {
      connecting = (async () => {
        const next = kafka.admin();
        await next.connect();
        // Nothing may hold a broker connection open after shutdown, for the same reason. The same
        // rule as the Redis probe client in `socket-server.ts`.
        if (closed) {
          await next.disconnect().catch(() => undefined);
          throw new Error('the API is shutting down');
        }
        return next;
      })();

      // A connection that failed must not be remembered as the connection: the next probe would
      // await a promise that is already rejected and never try again.
      connecting = connecting.catch((error: unknown) => {
        connecting = undefined;
        throw error;
      });
    }
    return connecting;
  }

  async function readLag(): Promise<ConsumerLagReport[]> {
    const client = await connected();

    // The high watermark per partition, read once for every group: the groups follow the same
    // topic, and asking the broker twice for the same numbers would let two rows of one panel
    // disagree by a message.
    const highWatermarks = new Map<number, bigint>();
    for (const partition of await client.fetchTopicOffsets(options.topic)) {
      highWatermarks.set(partition.partition, BigInt(partition.high));
    }

    return Promise.all(
      options.groupIds.map(async (groupId): Promise<ConsumerLagReport> => {
        const committed = await client.fetchOffsets({ groupId, topics: [options.topic] });
        const partitions =
          committed.find((entry) => entry.topic === options.topic)?.partitions ?? [];

        let lag = 0n;
        for (const [partition, high] of highWatermarks) {
          const offset = partitions.find((entry) => entry.partition === partition)?.offset;
          // `-1` is "this group has never committed here", so everything on the partition is
          // still ahead of it. Treating it as zero would hide a consumer that has never run.
          const consumed = offset === undefined || offset === '-1' ? 0n : BigInt(offset);
          const behind = high - consumed;
          lag += behind > 0n ? behind : 0n;
        }

        return { groupId, topic: options.topic, lag: Number(lag) };
      }),
    );
  }

  return {
    probe: async () => {
      try {
        return await withTimeout(readLag(), options.timeoutMs);
      } catch (error) {
        // The admin client is thrown away on failure for the same reason the Redis probe client
        // is: a broker that went away leaves it in a state a retry will not recover from, and a
        // fresh one costs a connection. The pending promise is cleared *before* it is awaited, so
        // a concurrent probe cannot adopt the client that is being discarded.
        const failed = connecting;
        connecting = undefined;
        void failed?.then((client) => client.disconnect()).catch(() => undefined);

        const message = error instanceof Error ? error.message : String(error);
        return options.groupIds.map((groupId) => ({
          groupId,
          topic: options.topic,
          lag: null,
          error: message.slice(0, 200),
        }));
      }
    },
    close: async () => {
      closed = true;
      const current = connecting;
      connecting = undefined;
      // A connection still being opened is awaited rather than ignored: `closed` makes it
      // disconnect itself, and awaiting here is what stops shutdown racing that teardown.
      await current?.then((client) => client.disconnect()).catch(() => undefined);
    },
  };
}

/**
 * KafkaJS retries inside `fetchOffsets`, so an unreachable broker can keep this pending far longer
 * than a health request may wait. The losing promise is left to settle on its own — the same
 * backstop, and the same reasoning, as `runProbe`.
 */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`the broker did not answer within ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
