# 012. The kitchen commands at the version its projection knows

Status: accepted
Date: 2026-08-28

## Context

`START_PREPARING` and `MARK_READY` are full mutations (§5): they carry a `mutationId` and a
`baseVersion`, and the versioned UPDATE of §6 decides who wins when two kitchen displays press the
same button. That is the whole point of routing kitchen transitions through the mutation protocol
rather than giving them a side door.

But the kitchen screen has no `orders` row to read a version from. It renders `kitchen_tickets` —
the projection the kitchen consumer builds from the event stream (§12.1, ADR 009) — and the only
version on a ticket is `source_event_version`, the order version carried by the event that last
moved it. The projection is eventually consistent by construction: the realtime consumer that
triggers the screen's refetch and the kitchen consumer that writes the projection are separate
consumer groups with nothing ordering them against each other (ADR 006).

So the command needs a `baseVersion` and the only candidate is a number that may be stale.

## Decision

The kitchen sends `baseVersion = ticket.source_event_version`, and a conflict is an accepted,
visible outcome rather than something to be engineered away.

This works because every event that reaches the kitchen room carries the order version it was
written at, and item mutations are refused once the order is `SENT_TO_KITCHEN` (§8) — so nothing
moves the order behind the kitchen's back except a transition the kitchen room is also told about.
The one exception is `PAY` from `READY`, which bumps the order and is not a kitchen event; after it
the order is `PAID` and every kitchen transition is refused anyway, so the stale version costs
nothing.

When the ticket _is_ behind — the projection lagging, or another display having got there first —
the server answers `409`, the card shows the reason, the store refetches the projection, and the
operator presses again. Kitchen commands carry `terminalId: 'kitchen-display'` unless a specific
display names itself; no table has a foreign key to `terminals`, and a terminal id is only ever a
label in `processed_mutations` and `conflict_log`.

## Consequences

- The kitchen is subject to exactly the same concurrency model as a POS, which is what makes §21.10
  — two `MARK_READY` at one `baseVersion`, one success and one conflict — a real test of the system
  rather than of a special case.
- **A kitchen command can be refused for a reason that is not the operator's fault**, when the
  projection is behind. Pressing again works. This is the honest cost of driving a strongly
  consistent write from an eventually consistent read, and the screen says so rather than retrying
  silently — an automatic retry at a refreshed version would be the system deciding, on its own,
  that a transition the operator asked for a second ago is still what they want.
- A kitchen command whose response is lost keeps its `mutationId` per order, so a retry resolves
  under §9 instead of racing. That is per-aggregate rather than per-terminal, which is the
  granularity §14.1 halts at and the one M8 generalises.
- The projection is now load-bearing for writes, not only for display. A kitchen consumer that is
  down no longer just delays the rail — it also freezes the versions the rail would command at.
  `/debug` (M11) is where that lag becomes a number.

## Alternatives considered

- **Read `GET /api/orders/:id` before each command** to get a fresh version. It removes the stale
  conflict, and replaces it with a read per command plus a race window between the read and the
  write that the version guard would have to catch anyway — so the conflict does not actually go
  away, it just costs a round trip first. It would also make the kitchen screen read the aggregate
  it deliberately does not read (§16).
- **Let the kitchen omit `baseVersion`** and have the server apply the transition unconditionally.
  That is last-write-wins for exactly the case §21.10 exists to demonstrate, and it is banned by
  §6. Rejected outright.
- **Store the order version on the ticket separately from the event version.** They would be the
  same number written twice; the second copy could only ever disagree with the first by being more
  wrong.
