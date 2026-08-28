# 014. The print job is BullMQ's, the record is the processor's, and the sweep reconciles them

Status: accepted
Date: 2026-08-29

## Context

ADR 010 kept the outbox's retries in PostgreSQL and rejected BullMQ for them, on the grounds that a
job and a row are two sources of truth for one fact. That argument does not settle §12.3, which is
the opposite situation: printing a kitchen ticket is an effect on a device outside the database
entirely, so _nothing_ can make the effect and its record one transaction. There is no dual-write to
avoid here — there is a dual-write that cannot be avoided.

Three things had to be decided with that in mind: whether BullMQ is the right owner of the retry
schedule, who writes `print_jobs` and when, and whether Redis becomes a hard dependency now that
something real runs on it.

## Decision

**BullMQ owns the schedule; `print_jobs` owns the verdict.** The queue decides _when_ an attempt
happens — `attempts`, exponential `backoff`, stalled-job recovery — and the row records what
happened: `attempt_count`, `last_error`, `state`, `printed_at`. The two counters are deliberately
not kept in step. A job re-enqueued by the sweep starts a fresh BullMQ attempt series against a row
that remembers every attempt before it, so a printer that has been down all afternoon still
dead-letters once rather than once per enqueue.

**The `print_jobs` row is written by the processor, never by the enqueuer.** This is what makes the
reconciliation sweep possible: "a `kitchen_tickets` row with no `print_jobs` row" means nothing has
ever tried to print that ticket, whatever became of the job. A row written at enqueue time would
make a lost job indistinguishable from an in-flight one, and the sweep would have to guess.

**The sweep reads the projection, not the queue.** Every way an enqueue can be lost — a crash
between the projection commit and the `add`, a redelivery that answered `duplicate` and therefore
enqueued nothing (§21.13), Redis losing its keys — leaves the same evidence in `kitchen_tickets`,
and one mechanism repairs all three. `PRINTED` and `DEAD_LETTER` rows are never swept; `PENDING` and
`FAILED` rows are, once they have been untouched for longer than any live backoff.

**Redis stays a soft dependency.** `/api/health/ready` still checks PostgreSQL only (ADR 011). With
Redis down, orders are accepted, projected and displayed, and the tickets that did not print are
still recorded in `kitchen_tickets` waiting for the sweep. Marking the API unready would take a
working POS offline to protect a printer.

**The guarantee is at-least-once, and it is stated in the UI.** `ticket_hash` deduplicates the
record and the fake printer's `Idempotency-Key` deduplicates the request within the device's own
memory. Neither deduplicates paper: if the device prints and the worker dies before writing
`PRINTED`, the retry prints again. The kitchen screen says so, in those words.

## Consequences

- The one component in the repository where a job and a record may disagree is also the one with a
  reconciler. That is the whole shape of the decision, and it is why ADR 010's rule and this one do
  not contradict each other.
- A duplicate ticket can physically print. For a kitchen that is the right trade — a missing ticket
  loses an order — but it is a real cost and the demo does not hide it.
- The fake printer's ledger is in memory, so restarting the API makes the next retry print again.
  Modelling the device's dedup window as a durable table would look more robust and would be a lie.
- Two counters exist for one process. `attempt_count` and BullMQ's `attemptsMade` can differ, and
  only the first one decides anything. Anyone reading the failed set in a BullMQ dashboard will see
  a different number from `/debug`.
- The sweep's staleness threshold has to exceed the longest backoff a healthy retry can be waiting
  out, or it re-enqueues jobs that are merely slow. That coupling between two configuration values
  is real and is documented on `PRINT_STALE_MS`.
- A cancelled ticket is skipped by the sweep but not by the live path, so an order cancelled a
  second after being sent can still print. The rule cannot be made symmetric without asking the
  live path to wait, which would delay every ticket for the sake of a rare one.
- Redis being soft means a Redis outage is invisible to readiness and visible only in the worker's
  logs until M11's `/debug` reports it.

## Alternatives considered

**Write the `print_jobs` row when the job is enqueued.** Rejected: it destroys the sweep's only
unambiguous signal. Every repair would then need a timeout to distinguish "the job is gone" from
"the job is running", which is the same guess the design avoids by writing later.

**Put the print retries in PostgreSQL too, matching the outbox.** Rejected: it would mean building a
second poller, a second lease and a second backoff for a job that has no ordering requirement and no
transactional relationship to anything. The outbox's retry state lives in the database because it
_must_ be atomic with the event; a print attempt has nothing to be atomic with.

**Make Redis a hard dependency and fail readiness with it.** Rejected under ADR 011: a POS that
stops accepting orders because a printer queue is unreachable is the exact inversion this
architecture exists to prevent.

**Keep BullMQ's failed jobs (`removeOnFail: false`) as the visible dead-letter state.** Rejected:
BullMQ keeps terminal jobs under their `jobId`, and a retained one silently swallows every later
`add` for the same ticket — including the sweep's repair and a human's manual retry. The visible
record is the `print_jobs` row, which `/debug` reads.

**Deduplicate the paper by asking the device to remember every key for ever.** Rejected as
dishonest: no real printer does, and §21.14 is written to test the endpoint's contract rather than
to imply a guarantee about hardware.
