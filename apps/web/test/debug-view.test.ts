import {
  PRESENCE_HEARTBEAT_MS,
  type ConsumerLagReport,
  type CounterReading,
  type DependencyReport,
  type OutboxRowView,
  type PresenceEntry,
} from '@pos/contracts';
import { describe, expect, it } from 'vitest';

import {
  dependencyBadges,
  formatCounter,
  groupCounters,
  isStalePresence,
  lagBadge,
  outboxRowBadges,
  presenceBadges,
  printJobBadge,
} from '../src/domain/debug-view';

const NOW = Date.parse('2026-08-30T12:00:00.000Z');

function presence(overrides: Partial<PresenceEntry> = {}): PresenceEntry {
  return {
    terminalId: 'pos-1',
    restaurantId: 'demo-restaurant',
    role: 'pos',
    source: 'socket',
    socketId: 'socket-1',
    pendingCount: 0,
    offline: false,
    lastSeenAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function outboxRow(overrides: Partial<OutboxRowView> = {}): OutboxRowView {
  return {
    id: 'event-1',
    aggregateId: 'order-1',
    restaurantId: 'demo-restaurant',
    eventType: 'OrderCreated',
    eventVersion: 1,
    createdAt: new Date(NOW).toISOString(),
    publishedAt: null,
    deadLetteredAt: null,
    attemptCount: 0,
    reclaimCount: 0,
    lastError: null,
    claimedBy: null,
    nextAttemptAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

describe('presence staleness', () => {
  it('leaves a terminal that has beaten within the window alone', () => {
    const entry = presence({
      lastSeenAt: new Date(NOW - PRESENCE_HEARTBEAT_MS).toISOString(),
    });

    // A poll lands at an arbitrary point in the beat, so one interval of age is the normal state
    // of a perfectly healthy terminal. Marking it stale would make the badge meaningless.
    expect(isStalePresence(entry, NOW)).toBe(false);
  });

  it('marks a terminal that has missed a beat, without hiding it', () => {
    const entry = presence({
      lastSeenAt: new Date(NOW - PRESENCE_HEARTBEAT_MS * 2 - 1).toISOString(),
    });

    expect(isStalePresence(entry, NOW)).toBe(true);
    // Still rendered: it is inside its server-side TTL, and "POS-1 was here eleven seconds ago" is
    // information. Dropping it would make a struggling terminal look like one that never connected.
    expect(presenceBadges(entry, NOW).map((badge) => badge.label)).toContain('STALE');
  });

  it('treats an unparseable timestamp as stale rather than as fresh', () => {
    expect(isStalePresence(presence({ lastSeenAt: 'not a date' }), NOW)).toBe(true);
  });

  it('shows the offline switch and the pending queue depth the client reported', () => {
    const labels = presenceBadges(presence({ offline: true, pendingCount: 4 }), NOW).map(
      (badge) => badge.label,
    );

    expect(labels).toContain('OFFLINE');
    expect(labels).toContain('PENDING 4');
  });
});

describe('counter grouping', () => {
  const readings: CounterReading[] = [
    { name: 'apiRequests', value: 10, source: 'process' },
    { name: 'outboxEventsPending', value: 2, source: 'database' },
    { name: 'duplicateKafkaEventsPrevented', value: null, source: 'shared' },
  ];

  it('keeps a fixed order and drops a group with nothing in it', () => {
    const groups = groupCounters(readings);

    expect(groups.map((group) => group.source)).toEqual(['process', 'database', 'shared']);
    // No `client` group: nothing reported one, and an empty panel headed "This browser" would read
    // as "this browser has synced nothing" rather than "there is no such reading here".
    expect(groups.every((group) => group.readings.length > 0)).toBe(true);
  });

  it('gives every group the caveat that says what its numbers are worth', () => {
    const groups = groupCounters(readings);

    expect(groups.find((group) => group.source === 'process')?.caveat).toMatch(/resets/i);
    expect(groups.find((group) => group.source === 'database')?.caveat).toMatch(/durable/i);
  });

  it('renders an unreadable counter as a dash, never as zero', () => {
    expect(formatCounter(null)).toBe('—');
    expect(formatCounter(0)).toBe('0');
  });
});

describe('the delivery pipelines', () => {
  it('marks a dead-lettered row rather than reporting it as merely unpublished', () => {
    const labels = outboxRowBadges(
      outboxRow({ deadLetteredAt: new Date(NOW).toISOString(), attemptCount: 8 }),
    ).map((badge) => badge.label);

    expect(labels).toContain('DEAD-LETTERED');
    expect(labels).not.toContain('PENDING');
  });

  it('surfaces a repeatedly reclaimed row, which nothing else in the system reports', () => {
    // `known-problems.md`: a row can be reclaimed for ever, `reclaim_count` climbs, and the stated
    // answer is a human reading this page. So the page has to show it.
    const labels = outboxRowBadges(outboxRow({ reclaimCount: 4, claimedBy: 'worker-1' })).map(
      (badge) => badge.label,
    );

    expect(labels).toContain('RECLAIMED 4');
    expect(labels).toContain('CLAIMED');
  });

  it('does not call a published row claimed, whatever the lease column still says', () => {
    const labels = outboxRowBadges(
      outboxRow({ publishedAt: new Date(NOW).toISOString(), claimedBy: 'worker-1' }),
    ).map((badge) => badge.label);

    expect(labels).toEqual(['PUBLISHED']);
  });

  it('spells a dead-lettered print job in §16’s vocabulary', () => {
    expect(printJobBadge('DEAD_LETTER')).toEqual({ label: 'DEAD-LETTERED', tone: 'bad' });
    // FAILED is a retry in progress, not a terminal state: amber, not red.
    expect(printJobBadge('FAILED').tone).toBe('warn');
  });
});

describe('dependencies and lag', () => {
  const report = (overrides: Partial<DependencyReport> = {}): DependencyReport => ({
    name: 'redis',
    kind: 'soft',
    status: 'down',
    latencyMs: 12,
    impact: 'cross-instance fan-out degrades',
    ...overrides,
  });

  it('colours a hard dependency worse than a soft one when both are down', () => {
    // The whole content of the health split (§17, ADR 011): the system keeps taking orders without
    // Redis, so colouring that red would train whoever reads this page to ignore red.
    expect(dependencyBadges(report())[1]?.tone).toBe('warn');
    expect(dependencyBadges(report({ name: 'postgres', kind: 'hard' }))[1]?.tone).toBe('bad');
  });

  it('never shows an unknown lag as caught up', () => {
    const known = (lag: number): ConsumerLagReport => ({
      groupId: 'kitchen',
      topic: 'restaurant.order.events',
      lag,
    });
    const unknown: ConsumerLagReport = {
      ...known(0),
      lag: null,
      error: 'the broker did not answer',
    };

    expect(lagBadge(unknown)).toEqual({ label: 'LAG UNKNOWN', tone: 'warn' });
    expect(lagBadge(known(0)).label).toBe('CAUGHT UP');
    expect(lagBadge(known(120)).tone).toBe('bad');
  });
});
