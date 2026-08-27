# 003. Optimistic concurrency through a versioned UPDATE

Status: accepted
Date: 2026-08-28

## Context

Several terminals edit the same order at the same time, and offline terminals send mutations built
against a version of the order that may already be old. The system needs a rule that decides which
write wins, and it has to be a rule a reviewer can inspect rather than trust.

## Decision

Every order carries an integer `version`. A mutation states the `baseVersion` it was built
against, and the write is guarded inside the statement itself:

```sql
update orders set version = version + 1, updated_at = now()
where id = $1 and version = $2
```

Zero affected rows is a conflict: the handler rolls the transaction back, re-reads the canonical
order, records the attempt in `conflict_log` and answers `409` with the current state.

The read that precedes this UPDATE is explicitly **not** a guard. Two transactions can both read
version 5; only one of them can bump it. Any check written as "read, compare, then write" would be
a race, so the comparison lives in the WHERE clause where PostgreSQL settles it.

## Consequences

Concurrent writers get a truthful answer, and the losing client receives the canonical order so it
can rebase. The cost is that the client must carry and send a version, and that stale mutations
fail rather than merge — including two `ADD_ITEM`s that would in principle commute. Merging is a
human decision made through the rebase flow (§14.1), not something the server guesses.

A conflict is also returned when the domain rule already rejects the mutation, and the domain
reason wins: "the kitchen is already cooking" is more useful to an operator than "your version is
old".

## Alternatives considered

Last-write-wins was rejected: it silently destroys the losing terminal's work, which in a
restaurant means a missing dish. `SELECT ... FOR UPDATE` on the order row was rejected because it
serialises every terminal on one row and holds locks for the whole request; the version guard
achieves the same correctness without blocking readers. Server-side replay of provably commutative
operations remains the interesting road not taken — it is a small CRDT, and it quietly
reintroduces last-write-wins wherever the commutativity proof is wrong.
