# Progress / Handoff

> **The only progress file read at the start of a session**, with `docs/milestones/MXX.md`; grep the
> others, never open them whole. Hard limit 8,000 characters — history belongs in `build-log.md`.

## Current state

**M26 is complete.** M0–M19 built the system, M20–M24 closed the review backlog and deployment
surface, M25 added the Prometheus operator surface, and M26 made the evidence immediately visible
and reproducible for an interviewer.

The API exposes six bounded-label metric families at `/metrics`: HTTP count/duration, mutation
outcomes, WebSocket connections, durable outbox/print states, and oldest unpublished outbox age.
The two durable gauges share one aggregate PostgreSQL query per scrape; normal requests execute
none. Starter alerts cover old outbox work and outbox/print dead letters. Consumer lag, distributed
tracing, and a consumer-side dead-letter topic remain explicitly unimplemented.

The README now opens with a concrete requirement-to-implementation map and a Mermaid diagram. A
captioned 87.8-second H.264 MP4 is published as a GitHub attachment rather than stored in Git;
`pnpm demo:record` deterministically rebuilds its local WebM source against the production Vue
bundle, PostgreSQL, Redis, Redpanda, API, and worker. The ordinary Playwright spec remains the CI
path and does not overwrite the recording.

**Green:** format, lint, typecheck, `pnpm test` **507 passed**, `verify:integration` (104 API, 68
worker, three real broker/queue round trips), `test:e2e`, production builds, and `verify:multi` — a
mutation through replica A reached a socket on replica B. The new metrics test proves route labels
contain no order UUID and PostgreSQL-backed gauges report inserted outbox and print states. The demo
recording passed, local Markdown links resolve, Mermaid CLI rendered the README diagram, and no
Playwright scratch recording remains.

## What exists

- `packages/` — validated config, contracts, domain decisions/pricing, and Drizzle schema/migrations.
- `apps/api` — versioned/idempotent mutations, reads, kitchen commands, realtime consumer, printer,
  feature flags, health/debug routes, and `modules/observability/`.
- `apps/worker` — leased transactional-outbox publisher, idempotent kitchen projection, BullMQ print
  processing/reconciliation, and opt-in health server.
- `apps/web` — Vue/Pinia POS and KDS, Dexie mutation queue, reconnect/conflict engine, realtime
  invalidation, polling fallback, PWA shell, debug simulator, and guided demo.
- Infrastructure and proof — PostgreSQL, Redis, Redpanda, three production images, two-API Compose
  overlay, CI, Vitest/integration/Playwright suites, and lifecycle-owning `verify:*` scripts.
- Decisions and limits — ADR 001–019, `architecture.md`, `known-problems.md`, and milestone briefs
  M01–M26.

## Standing decisions

- WebSocket messages invalidate; canonical HTTP reads remain authoritative.
- Idempotency records, the business effect, and outbox rows commit in one PostgreSQL transaction.
- Conflicts halt one order's client queue and require explicit Discard/Rebase; no silent rebase.
- Outbox and Kafka delivery are at least once; projections commit their consumer marker with state.
- Realtime scales through the Socket.IO Redis adapter; `verify:multi` is the executable claim.
- PostgreSQL owns durable print outcome; BullMQ owns scheduling and retry.
- `/metrics` labels must stay bounded. Never add tenant/order/terminal/mutation/event IDs.
- Database-backed metrics run on scrape, not on normal request paths; aggregate replicas with `max`,
  not `sum`, for shared durable state.
- Verification runs own only the services they start and write `.verify-output/*.log`.
- The three Dockerfiles' dependency stage stays byte-identical so BuildKit shares `pnpm install`.
- Never change a base service from the Compose overlay; it would recreate the user's demo service.

## Known problems

`docs/known-problems.md` is authoritative. The highest-value remaining distributed-systems gaps are
consumer poison-message isolation/dead-lettering, Kafka consumer-lag export, and tracing across the
HTTP → outbox → Kafka → consumer hop. Production auth/rate limiting are also not claimed.

## Next milestone

There is no planned M27. The highest-ROI next engineering work is consumer poison-message
isolation/dead-lettering, then Kafka lag metrics and asynchronous tracing. The only verification not
available locally is the remote GitHub Actions run for commits M25 and M26; push them when desired.
