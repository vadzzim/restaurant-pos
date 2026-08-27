# Architecture Decision Records

Once a decision is recorded here it is not revisited without a new ADR. This protects the project
from a fresh session, lacking context, reinventing the architecture from scratch.

The format is four short sections:

```markdown
# NNN. Title

Status: accepted | superseded by NNN
Date: YYYY-MM-DD

## Context
The problem and the constraints.

## Decision
What was decided, in one or two paragraphs.

## Consequences
What this buys and what it costs. Negative consequences are mandatory.

## Alternatives considered
What was evaluated and why it was rejected.
```

## Planned records

| File | Milestone | Note |
|------|-----------|------|
| `001-modular-monolith.md` | M1 | three processes, not microservices |
| `007-drizzle.md` | M1 | explicit concurrency-sensitive SQL over Prisma |
| `003-optimistic-concurrency.md` | M3 | versioned UPDATE, no last-write-wins |
| `004-idempotency.md` | M3 | `mutationId` + `request_hash`, and why reuse is rejected |
| `009-kitchen-projection.md` | M3 | why the kitchen consumer needs a real read model |
| `005-transactional-outbox.md` | M5 | the dual-write problem |
| `006-kafka-at-least-once.md` | M5 | ordering within a partition only; the realtime crash window |
| `011-health-and-degradation.md` | M6 | why readiness ignores the broker |
| `002-offline-first.md` | M8 | including why a conflict halts the queue |
| `010-db-outbox-retries.md` | M9 | why retries live in Postgres and not in BullMQ |
| `008-feature-flags.md` | M13 | why the flag gates transport, not the write path |
