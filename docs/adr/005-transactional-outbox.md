# 005. The transactional outbox, and what ordering it does and does not buy

Status: accepted
Date: 2026-08-28

## Context

A mutation has to do two things: change the order in PostgreSQL and tell the rest of the system it
happened. Doing both directly is a dual write, and it has no correct failure mode. Publish inside
the transaction and a broker timeout either rolls back an order the customer watched being taken,
or — worse — commits after a publish that the rollback cannot recall. Publish after the commit and
a crash in between loses the event with no record that it was ever owed.

§7 already forbids the shape that would hide this: no external call inside a transaction.

This ADR is written in M5 because it is the milestone that makes the outbox carry the whole domain
— nine event types instead of three, and two consumers depending on their order.

## Decision

The order change and the event insert happen in one transaction, into `outbox_events`. A separate
worker publishes, in three short steps with no network call inside any of them (§10):

1. **Claim** a batch by lease — `claimed_by`, `claim_until` — and commit.
2. **Publish** to Redpanda outside any transaction.
3. **Mark** `published_at` in a second transaction.

The topic `restaurant.order.events` is partitioned by `orderId`, and the publisher claims only an
order's earliest unpublished event, so a given order's events reach the broker in version order
however the retries fall out and however many workers run.

## Consequences

- **The database is the only thing that has to be up to take an order.** Redpanda down means events
  accumulate in `outbox_events` and publish later; readiness checks PostgreSQL only (§17), because
  a probe that failed on broker loss would take a working POS offline — the exact failure this
  architecture exists to prevent.
- **Publication is at-least-once, and the crash window is real**: a worker that dies between step 2
  and step 3 republishes on the next pass. That is why every consumer is idempotent through
  `processed_events` (§12), and why §21.12 tests the window rather than asserting it cannot happen.
- **Ordering is guaranteed within one order and nowhere else.** Kafka orders within a partition;
  the key is `orderId`; two different orders have no relative ordering and no consumer may assume
  one. This is stated in the docs rather than left for someone to infer from the key.
- The outbox is a queue in a relational database, and it grows without bound. Archiving is out of
  scope for this demo and is said out loud rather than papered over.
- Retries live in Postgres (`attempt_count`, `next_attempt_at`, `dead_lettered_at`), not in a job
  queue. ADR 010 records why.

## Alternatives considered

- **Publish inside the HTTP transaction.** The dual write above, plus a long transaction holding
  row locks across a network call. Banned by §7 for both reasons.
- **Change data capture (Debezium on the WAL).** Genuinely better at scale: no publisher to run, no
  polling, and the event stream cannot drift from the committed data. Rejected here because it
  moves the interesting logic into infrastructure configuration, and this project exists to show
  the reasoning in code that can be read in an interview.
- **Publish after commit from the API process, with retries in memory.** Loses everything a process
  restart is holding, and there is no record of what was lost.
