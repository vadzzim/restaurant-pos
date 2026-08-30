import {
  PRESENCE_HEARTBEAT_MS,
  type ConsumerLagReport,
  type CounterReading,
  type CounterSource,
  type DependencyReport,
  type OutboxRowView,
  type PresenceEntry,
  type PrintJobState,
} from '@pos/contracts';

/**
 * Everything `/debug` decides about what it is showing, as pure functions.
 *
 * The page itself renders and polls and does nothing else. These are the judgements — is this
 * terminal stale, is this row stuck, what does this number mean — and they are here so they can be
 * tested without a browser, which is the same split the rest of this client keeps
 * (`domain/project-queue.ts`, `realtime/event-gate.ts`).
 */

export type Tone = 'ok' | 'warn' | 'bad' | 'neutral';

export interface Badge {
  label: string;
  tone: Tone;
}

/**
 * A terminal is stale when it has missed a beat — not when it has merely not beaten in the last
 * instant. The entry is still inside its server-side TTL at this point, so it is *marked* rather
 * than hidden: "POS-2 was here nine seconds ago" is information, and dropping it would leave the
 * panel unable to distinguish a terminal that is struggling from one that never connected.
 *
 * Two heartbeats rather than one, because a poll lands at an arbitrary point in the beat: with a
 * one-beat threshold every healthy terminal would read stale about half the time.
 */
export const STALE_AFTER_MS = PRESENCE_HEARTBEAT_MS * 2;

export function isStalePresence(entry: PresenceEntry, now: number): boolean {
  const lastSeen = Date.parse(entry.lastSeenAt);
  // An unparseable timestamp came from somewhere this build does not understand, and calling that
  // fresh would be the one reading on this panel that hides a problem.
  return Number.isNaN(lastSeen) || now - lastSeen > STALE_AFTER_MS;
}

/** §16's required vocabulary, for one terminal. */
export function presenceBadges(entry: PresenceEntry, now: number): Badge[] {
  const badges: Badge[] = [
    entry.offline ? { label: 'OFFLINE', tone: 'bad' } : { label: 'ONLINE', tone: 'ok' as const },
  ];

  if (entry.pendingCount > 0) {
    badges.push({ label: `PENDING ${entry.pendingCount}`, tone: 'warn' });
  }

  if (isStalePresence(entry, now)) {
    badges.push({ label: 'STALE', tone: 'warn' });
  }

  return badges;
}

export interface CounterGroup {
  source: CounterSource;
  title: string;
  /** What the numbers in this group are worth. §20's list mixes sources; the page must not. */
  caveat: string;
  readings: CounterReading[];
}

const GROUP_ORDER: readonly { source: CounterSource; title: string; caveat: string }[] = [
  {
    source: 'process',
    title: 'This API instance',
    caveat:
      'In-memory. Resets when the API restarts, and with several instances this is one instance’s share.',
  },
  {
    source: 'database',
    title: 'Derived from PostgreSQL',
    caveat: 'Durable and fleet-wide: these survive a restart of the API and of the worker.',
  },
  {
    source: 'shared',
    title: 'Shared through Redis',
    caveat:
      'Counted in the worker, which has no row for this fact. Redis is soft, so a null here means Redis could not be read — not zero.',
  },
  {
    source: 'client',
    title: 'This browser',
    caveat:
      'Counted in IndexedDB, shared by every tab on this origin. The server cannot observe an offline sync at all.',
  },
];

/** Grouped in a fixed order, and a group with nothing in it is dropped rather than left blank. */
export function groupCounters(readings: CounterReading[]): CounterGroup[] {
  return GROUP_ORDER.flatMap((group) => {
    const mine = readings.filter((reading) => reading.source === group.source);
    return mine.length === 0 ? [] : [{ ...group, readings: mine }];
  });
}

/**
 * What an outbox row is doing, in §16's vocabulary.
 *
 * `DEAD-LETTERED` first, because it is the only state a human has to act on; `RECLAIMED` is
 * carried alongside rather than instead, since a row can be both. A non-zero `reclaim_count` is the
 * only visible symptom of a publisher that crashes on one row — `known-problems.md` says the answer
 * to that is a human reading this page, so the page has to show it.
 */
export function outboxRowBadges(row: OutboxRowView): Badge[] {
  const badges: Badge[] = [];

  if (row.deadLetteredAt !== null) {
    badges.push({ label: 'DEAD-LETTERED', tone: 'bad' });
  } else if (row.publishedAt !== null) {
    badges.push({ label: 'PUBLISHED', tone: 'ok' });
  } else {
    badges.push({ label: 'PENDING', tone: 'warn' });
  }

  if (row.claimedBy !== null && row.publishedAt === null && row.deadLetteredAt === null) {
    badges.push({ label: 'CLAIMED', tone: 'neutral' });
  }

  if (row.reclaimCount > 0) {
    badges.push({ label: `RECLAIMED ${row.reclaimCount}`, tone: 'warn' });
  }

  return badges;
}

const PRINT_JOB_TONES: Readonly<Record<PrintJobState, Tone>> = {
  PENDING: 'warn',
  PRINTED: 'ok',
  FAILED: 'warn',
  DEAD_LETTER: 'bad',
};

export function printJobBadge(state: PrintJobState): Badge {
  return {
    label: state === 'DEAD_LETTER' ? 'DEAD-LETTERED' : state,
    tone: PRINT_JOB_TONES[state],
  };
}

/**
 * A hard dependency that is down is `bad`; a soft one is `warn`, because the system keeps taking
 * orders without it and colouring it red would train whoever reads this page to ignore red.
 * That distinction is the entire content of the health split (§17, ADR 011), so it is what the
 * colour carries.
 */
export function dependencyBadges(report: DependencyReport): Badge[] {
  return [
    { label: report.kind === 'hard' ? 'HARD' : 'SOFT', tone: 'neutral' },
    report.status === 'up'
      ? { label: 'UP', tone: 'ok' }
      : { label: 'DOWN', tone: report.kind === 'hard' ? 'bad' : 'warn' },
  ];
}

/**
 * Consumer lag, coloured by what it costs. Under ADR 012 the kitchen projection is load-bearing
 * for *writes* — a kitchen command validates against it — so lag there is not a display delay, and
 * an unknown lag is never shown as zero.
 */
export function lagBadge(report: ConsumerLagReport): Badge {
  if (report.lag === null) {
    return { label: 'LAG UNKNOWN', tone: 'warn' };
  }
  if (report.lag === 0) {
    return { label: 'CAUGHT UP', tone: 'ok' };
  }
  return { label: `LAG ${report.lag}`, tone: report.lag > 50 ? 'bad' : 'warn' };
}

/** A counter that could not be read is `—`, never `0`. The difference is the whole point. */
export const formatCounter = (value: number | null): string =>
  value === null ? '—' : String(value);

/** Timestamps are rendered as a local wall clock: this page is read next to a running demo. */
export function formatTime(iso: string | null): string {
  if (iso === null) {
    return '—';
  }
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleTimeString();
}

/** An identifier column that has to fit: enough to match against a log line, not the whole UUID. */
export const shortId = (id: string): string => id.slice(0, 8);
