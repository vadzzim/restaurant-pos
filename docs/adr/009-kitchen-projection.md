# 009. The kitchen consumer builds a real projection

Status: accepted
Date: 2026-08-28

## Context

Publication from the outbox is at-least-once (§10), so consumers see duplicates and redeliveries.
A consumer that only logged or only emitted a WebSocket message could claim idempotency, but the
claim would be untestable — nothing observable would distinguish "handled once" from "handled
twice".

## Decision

The kitchen consumer writes a real read model, `kitchen_tickets`, and does it transactionally:

```
BEGIN
  insert into processed_events (event_id, 'kitchen') on conflict do nothing
  -- no row inserted means this event was already handled: skip
  upsert kitchen_tickets, only where source_event_version < the incoming version
COMMIT
```

The dedup marker and the projection commit together, so a crash cannot record one without the
other. The version guard is separate from the dedup marker on purpose: deduplication catches the
_same_ event arriving twice, while the version guard catches an _older_ event arriving after a
newer one — which Kafka permits across partitions, and which redelivery makes likely.

`/kitchen` reads this projection rather than the orders table, so the demo shows the consumer's
output rather than the writer's.

## Consequences

Idempotency becomes demonstrable: replay an event, watch the ticket not change, count one row in
`processed_events`. The cost is a second copy of order data that can lag behind `orders`, and a
`processed_events` table that grows with every event consumed.

The realtime consumer (§12.2) deliberately does **not** get this treatment — a WebSocket emit
cannot join a database transaction, so its crash window is documented instead of hidden.

## Alternatives considered

Reading `orders` directly from the kitchen screen was rejected: it would work, but it removes the
consumer's reason to exist and with it the only honest way to show event-driven idempotency.
Keeping only a "last seen event id" per order was rejected because it cannot answer what the
kitchen should currently display.
