import { KafkaJSConnectionError, KafkaJSProtocolError } from 'kafkajs';
import { describe, expect, it } from 'vitest';

import type { DomainEvent } from '@pos/contracts';

import type { EventTransport } from '../src/modules/events/outbox-publisher.js';
import { guardTransport, isRecordRejection } from '../src/shared/broker-session.js';

const event = { eventId: 'e1', eventType: 'OrderItemAdded' } as unknown as DomainEvent;

function throwing(error: unknown): EventTransport {
  return {
    publish: async () => {
      throw error;
    },
  };
}

function protocolError(type: string): KafkaJSProtocolError {
  // What KafkaJS raises when the broker answers with a rejection rather than going silent.
  return new KafkaJSProtocolError(type);
}

describe('what ends a broker session', () => {
  it('does not end it for a record the broker itself rejected', async () => {
    // MESSAGE_TOO_LARGE says the event is wrong, not that the connection is. Ending the session
    // would take the kitchen consumer with it and abandon the rest of the batch on every retry,
    // until the poison row dead-lettered.
    let died = false;
    const transport = guardTransport(throwing(protocolError('MESSAGE_TOO_LARGE')), () => {
      died = true;
    });

    await expect(transport.publish(event, 'order-1')).rejects.toThrow();
    expect(died).toBe(false);
    expect(isRecordRejection(protocolError('MESSAGE_TOO_LARGE'))).toBe(true);
  });

  it('ends it for a connection failure, before the error is rethrown', async () => {
    // The signal KafkaJS does *not* give as a DISCONNECT event: the broker went away under an open
    // socket. A publish loop that catches this and moves on must already see a dead session.
    let died = false;
    const transport = guardTransport(
      throwing(new KafkaJSConnectionError('broker unreachable')),
      () => {
        died = true;
      },
    );

    await transport.publish(event, 'order-1').catch(() => {
      expect(died).toBe(true);
    });
    expect(died).toBe(true);
  });

  it('ends it for an error it does not recognise', async () => {
    // Pausing the publisher costs a reconnect; carrying on through a dead transport costs an
    // attempt_count on every claimed row. The unknown case takes the cheaper mistake.
    let died = false;
    const transport = guardTransport(throwing(new Error('something else')), () => {
      died = true;
    });

    await expect(transport.publish(event, 'order-1')).rejects.toThrow('something else');
    expect(died).toBe(true);
    expect(isRecordRejection(new Error('something else'))).toBe(false);
  });

  it('leaves a successful publish alone', async () => {
    let died = false;
    const sent: string[] = [];
    const transport = guardTransport(
      {
        publish: async (_event, key) => {
          sent.push(key);
        },
      },
      () => {
        died = true;
      },
    );

    await transport.publish(event, 'order-1');
    expect(sent).toEqual(['order-1']);
    expect(died).toBe(false);
  });
});
