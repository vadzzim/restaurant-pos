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
| `006-realtime-consumer.md` | M4 | in the api process, one shared group, and the emit crash window |
| `005-transactional-outbox.md` | M5 | the dual-write problem, and ordering within a partition |
| `012-kitchen-command-base-version.md` | M5 | commanding from an eventually consistent projection |
| `011-health-and-degradation.md` | M6 | why readiness ignores the broker, and why the worker waits |
| `013-client-persistence.md` | M7 | the three Dexie tables, and who may write them at hydration |
| `002-offline-first.md` | M8 | a derived optimistic view, a projected `baseVersion`, and why a conflict halts the queue |
| `010-db-outbox-retries.md` | M9 | why retries live in Postgres and not in BullMQ |
| `014-print-job-queue.md` | M10 | why the print job *is* BullMQ's, and what reconciles the two records |
| `015-simulator-write-surface.md` | M12 | one endpoint pair for four switches, and seven that stay in the tab |
| `008-feature-flags.md` | M13 | why the flag gates transport, not the write path |
| `016-production-images.md` | M14 | why the image ships the pruned workspace rather than one bundled file |
| `017-service-worker-scope.md` | M17 | the shell only, on an allow-list, and why the worker never waits |
| `018-end-to-end-run.md` | M18 | who owns the stack for the browser test, and who owns the reset |
