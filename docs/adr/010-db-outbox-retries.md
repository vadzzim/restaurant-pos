# 010. Outbox retries live in PostgreSQL, not in BullMQ

Status: accepted
Date: 2026-08-28

## Context

The transactional outbox (§10) needs retries: a publish to Redpanda can fail, and the event must be
tried again later, with a bounded backoff, and eventually parked somewhere visible rather than
dropped. Redis and BullMQ are already in the stack for the print job (§12.3), so the obvious move is
to reuse them — enqueue a job per outbox row and let BullMQ own `attempts`, `backoff` and the failed
set.

An external review of the design raised the objection that settled this, and M9 — which hardens the
lease and writes the crash-window tests — is where it had to be written down.

## Decision

**`outbox_events` is the queue.** `attempt_count`, `next_attempt_at`, `last_error` and
`dead_lettered_at` are columns on the same row as the payload, and the publisher's three-step pass
(claim by lease → publish outside any transaction → mark the outcome) is the only thing that writes
them. No second queue, no job, no Redis in the publish path.

Two rules fall out of that and are part of this decision:

1. **An attempt means "this event failed".** Only a failed send of _this record_ increments
   `attempt_count`. A broker that went away mid-batch, a publisher a human paused, and a lease that
   ran out all leave the row exactly as they found it. Without that rule a five-minute outage
   dead-letters a full batch of healthy events and the dead-letter state stops meaning anything —
   which is the same invariant ADR 011 defends from the supervision side.
2. **A reclaim is not an attempt.** When a worker dies mid-publish its lease expires and another
   worker takes the row. That says a _worker_ died, not that the event is bad, so it increments
   `reclaim_count` and nothing else. It is counted rather than ignored because a row being reclaimed
   over and over is the only visible symptom of a publisher crashing on one specific event, and
   `/debug` (M11) is where a human sees it.

## Consequences

- The dual-write problem stays solved end to end. The order change and the event are one
  transaction, and the retry state is on the same row — so there is no moment where the job and the
  row can disagree about whether an event was published.
- Recovering a crashed publish is time-based: the row is stuck until `claim_until` passes. That is
  a real latency bound of up to `OUTBOX_LEASE_MS`, and it is why M9 releases the claims of rows a
  pass decides not to publish instead of leaving them to expire.
- The publisher polls. A queue would push, and polling every `OUTBOX_POLL_MS` costs a query on an
  idle system. The partial index on `(next_attempt_at) where published_at is null and
dead_lettered_at is null` keeps that query cheap, and a productive pass immediately runs the next
  one so a busy system does not pay the poll interval per event.
- Backoff, dead-lettering and the lease are ours to write and ours to get wrong; BullMQ has them
  already. §21.12, §21.13 and §21.16 exist because that code needs the same scrutiny a library
  would have had.
- The dead-letter state is a column, not a queue with a UI. Until M11 it is reachable only by
  reading the table.

## Alternatives considered

**BullMQ per outbox row.** Rejected: it introduces a second source of truth for one fact. The job
can say "retry" while the row says "published", and reconciling them needs exactly the sweep that
having one source of truth avoids. It also puts Redis — a soft dependency everywhere else (ADR 011)
— into the durability path of an event that is already committed in PostgreSQL.

**Kafka's own producer retries only.** Rejected: they cover a send that fails inside one process
lifetime. They cannot survive the worker being killed, which is precisely the window §21.12 is
about.

**`LISTEN`/`NOTIFY` instead of polling.** Rejected for now: it removes the idle query but not the
poll (a notification lost while the worker is down still needs a sweep to catch the backlog), so it
is an optimisation on top of this design rather than an alternative to it.
