import type { DomainEvent } from '@pos/contracts';
import { describe, expect, it } from 'vitest';

import { createEventGate } from '../src/realtime/event-gate';

function event(eventId: string, version: number): DomainEvent {
  return {
    eventId,
    eventType: 'OrderItemAdded',
    aggregateId: 'order-1',
    restaurantId: 'demo-restaurant',
    version,
    occurredAt: '2026-08-28T00:00:00.000Z',
    payload: {},
  };
}

describe('the client event gate (§12.2)', () => {
  it('accepts an event newer than the version the client holds', () => {
    const gate = createEventGate();
    expect(gate.accept(event('a', 3), 2)).toBe('accepted');
  });

  it('drops a redelivery of the same eventId', () => {
    const gate = createEventGate();
    expect(gate.accept(event('a', 3), 2)).toBe('accepted');
    expect(gate.accept(event('a', 3), 2)).toBe('duplicate');
  });

  it('drops anything not newer than the held version', () => {
    const gate = createEventGate();
    // The echo of the client's own mutation: its response already carried version 3.
    expect(gate.accept(event('a', 3), 3)).toBe('stale');
    expect(gate.accept(event('b', 2), 3)).toBe('stale');
  });

  it('bounds the seen set so a full shift cannot grow it without limit', () => {
    const gate = createEventGate(3);

    for (let index = 0; index < 10; index += 1) {
      gate.accept(event(`event-${index}`, index + 1), index);
    }

    expect(gate.size).toBe(3);
    // Evicted ids look new again, which is exactly why the version gate is the second rule and
    // not an optimisation: it still refuses anything that is not actually newer.
    expect(gate.accept(event('event-0', 1), 10)).toBe('stale');
  });
});
