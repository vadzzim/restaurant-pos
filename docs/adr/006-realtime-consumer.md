# 006. The realtime consumer runs in the API process, on one shared consumer group

Status: accepted
Date: 2026-08-28

## Context

Socket.IO holds its connections in the API process. Domain events arrive on Kafka. Something has to
sit between them, and where it sits decides whether the Redis adapter is load-bearing or decoration.

Two constraints frame the choice. First, §22 and M14 promise a smoke test in which a mutation
applied through API replica A reaches a WebSocket client attached to replica B — the adapter has to
be _proved_, not asserted. Second, §17 is explicit that readiness checks PostgreSQL only: the whole
reason the outbox exists is that a broker outage must not stop a POS taking orders. Whatever the
API gains here must stay a soft dependency.

## Decision

The consumer runs **inside `apps/api`**, and every API instance joins the **same consumer group**,
`realtime`:

```
Kafka -> realtime consumer (one instance) -> io.to(rooms).emit -> Redis adapter -> other instances -> browsers
```

Because the group is shared, each event is handled exactly once, by whichever instance holds the
partition. That instance broadcasts, and the Redis adapter fans the broadcast out to sockets held
by the others. This is precisely the arrangement M14 exercises.

Kafka and Redis are attached without becoming hard dependencies. `buildApp()` builds routes and the
error handler only; the socket server and the consumer are wired in `index.ts`. The consumer start
is retried in the background with bounded backoff and never blocks `listen()`, so the API serves
reads and accepts mutations with Redpanda down. The Redis clients reconnect on their own; with
Redis down, an instance still reaches its own sockets and only cross-instance fan-out degrades.

The emit itself is not transactional and does not pretend to be (§12.2): the consumer records
`processed_events (event_id, 'realtime')`, commits, then emits.

## Consequences

- The Redis adapter is on the critical path of the multi-instance story, which is what makes M14's
  assertion meaningful.
- One event is handled once no matter how many API instances run, so a rollout does not multiply
  broadcasts or `processed_events` rows.
- The API process now owns two responsibilities, HTTP and consumption. For a demo of this size that
  is the honest trade against inventing a second transport between the worker and the sockets.
- **A crash between the commit and the emit loses that broadcast permanently.** Nothing on the
  server recovers it. The client is the mitigation and has to carry all three rules of §13: dedup
  by `eventId`, ignore any `version` not greater than the one it holds, and refetch the canonical
  snapshot on every reconnect. A client that skipped the reconnect refetch would show state that
  silently disagrees with the database.
- Consumer lag now affects a user-visible screen, so §16's `/debug` dependency panel has a real
  reason to display it.

## Alternatives considered

**A unique consumer group per API instance.** Every instance receives every event and broadcasts
only to its own sockets, so no adapter is needed. Rejected: it makes Redis dead weight, leaves M14
with nothing to prove, multiplies `processed_events` writes by the replica count, and accumulates
one abandoned group per instance restart in the broker.

**The consumer in `apps/worker`, pushing to the API.** The worker would need a second channel to
reach the sockets — an internal HTTP call, or Redis pub/sub. The latter is the Redis adapter with
extra steps; the former adds a hop that can fail independently. Rejected as strictly more moving
parts for the same result.

**Making Redpanda a hard dependency of the API so the consumer can start eagerly.** Rejected
outright: it contradicts §17 and would take a working POS offline on a broker outage — the exact
failure the outbox architecture exists to prevent.
