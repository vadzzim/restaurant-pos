# Progress / Handoff

> This file is read first in every new session. Keep it short and accurate.
> Update it at the end of every milestone, before committing.

## Current state

**Last completed milestone:** M3 — the backend vertical slice: HTTP -> transaction -> outbox ->
Redpanda -> kitchen consumer -> projection, for `CREATE_ORDER`, `ADD_ITEM` and `SEND_TO_KITCHEN`.
**Next:** M4 — the frontend vertical slice and Socket.IO. Recommended model: Sonnet.
**This is the milestone that makes M4 demoable.**

M0 `9a87b86`, M1 `3b498e8`, M2 `2ed4ce3` + `d43c194`. M3 passes typecheck, lint, build and 27
tests (9 domain, 10 api, 8 worker) against a real PostgreSQL. The seven mandatory tests §21.1,
21.2, 21.3, 21.5, 21.6, 21.11 and 21.15 are present and named by their spec number.

## What exists

- `CLAUDE.md`, `docs/spec.md`, `docs/MILESTONES.md`, `docs/build-log.md`.
- `docs/milestones/M01.md`, `M02.md`, `M03.md` — the completed briefs.
- ADRs 001, 003, 004, 007, 009 accepted.
- `packages/config` — zod environment, now including `TEST_DATABASE_URL`, the Kafka topic settings
  and the outbox tuning knobs.
- `packages/contracts` — statuses, mutation types, event types, order and event payload DTOs, the
  §5 request/response shapes and `ConflictReason`.
- `packages/domain` — `calculateTotalCents`, `isValidTransition`, and `decide()`: the one place
  that answers whether a mutation may apply to an order as it stands. No database, no HTTP.
- `packages/db` — schema, migrations, seed, `db:check`, and `@pos/db/testing` (creates `pos_test`,
  migrates, seeds, truncates between tests). **Moved here from `apps/api/src/db` in M3**, because
  the worker needs the same tables and one app cannot import another app's source.
- `apps/api` — `POST /api/orders/:orderId/mutations` (the only write path), zod validation, the
  §7 transaction, the §17 error model, `buildApp()` so tests can `inject`.
- `apps/worker` — the §10 three-step outbox publisher with lease, backoff and dead-lettering; the
  Kafka producer and topic bootstrap; the kitchen consumer and its transactional projection.
- `apps/web` — still the M1 placeholder.

## Facts M4 depends on

- **One write path.** `POST /api/orders/:orderId/mutations`. There is no `POST /api/orders`: the
  client generates the `orderId` (uuid) and sends `CREATE_ORDER` with `baseVersion: 0`.
- The client must send `mutationId` (uuid v4), `terminalId`, `restaurantId`, `baseVersion`, `type`
  and `payload`; responses are exactly the §5 shapes, typed in `@pos/contracts` as
  `MutationResponse`. Validation failures use the §17 `{ code, message, details }` envelope.
- **There is no read endpoint yet.** M4 needs `GET /api/orders/:id` and `GET /api/menu`, and it
  should add them — the mutation response already carries the full `OrderSnapshot`, so a POS can
  work from it, but the kitchen screen cannot.
- The kitchen projection is `kitchen_tickets`, written only from `OrderSentToKitchen`, with
  `state = 'SENT_TO_KITCHEN'` and `source_event_version`. M4's kitchen screen reads this table.
- Events on `restaurant.order.events` are keyed by `orderId`; the envelope is `DomainEvent`.
- Test databases: `TEST_DATABASE_URL` (`pos_test`), created and migrated automatically by
  `@pos/db/testing`. The demo database is never truncated by a test run.
- Workspace packages resolve through their `exports` to `dist`, so `pnpm run build:packages` runs
  before dev, typecheck, build, test and the db scripts. Vitest aliases the sources instead.
- Root `pnpm test` runs the workspace suites with `--workspace-concurrency=1`, because they share
  one test database.

## Decisions already made

- Fastify over NestJS, Drizzle over Prisma.
- Full scope, nothing cut. **Twenty milestones total, seventeen still to run.**
- **A demoable vertical slice lands at M4**, not M11. The original ordering finished the backend
  first, which risked reaching the usage limit with green tests and nothing to show.
- **The user starts the infrastructure.** Claude never runs `docker compose` and never reads
  container logs — only code, tests and migrations. The reproducibility gap this creates is closed
  by `pnpm verify:integration` (M6): one scripted command that brings Compose up, waits for
  readiness, runs the integration suite, tears down, and writes output to a file. CI calls that
  same command and declares no service containers of its own.
- **Drop order if the interview date closes in:** M10 (print job), then M16 (`/demo`), then M17
  (PWA). Do not drop M15 or M18 first — the role has Vue in the title, and rush-speed POS UX plus
  a browser-level E2E test are what demonstrate frontend maturity.

## Review round 1 — accepted

- Kitchen commands became real mutations (`START_PREPARING`, `MARK_READY`) through the same
  transactional handler. Previously they bypassed the concurrency model entirely.
- **A conflict halts the offline queue for that aggregate** (§14.1). Later mutations for the same
  order are `BLOCKED` and never sent; the operator explicitly discards or rebases.
- The kitchen consumer builds a real `kitchen_tickets` projection, so its idempotency is
  demonstrable. The realtime consumer is documented honestly as at-least-once with a crash window,
  mitigated by client-side `eventId`/version filtering.
- `409 MUTATION_ID_REUSED` when a `mutationId` returns with a different `request_hash`.
- Tenant scoping on every mutation.
- Health split into `live`, `ready` (Postgres only) and `debug/dependencies`.
- CI, production images, and a multi-instance smoke test that proves the Redis adapter claim.
- BullMQ removed from outbox retries (Postgres owns them); redirected to the print job.
- The feature flag retargeted from the write path to `realtime.websocket_push`, which has a
  complete polling implementation as its other branch.

## Review round 2 — accepted, and why each mattered

- **Outbox lease.** The publisher held `FOR UPDATE SKIP LOCKED` across the Kafka publish, which
  contradicted §7's own ban on external calls inside a transaction. Now three short steps: claim
  by lease (`claimed_by`, `claim_until`) and commit, publish outside any transaction, mark in a
  second transaction. Publication is explicitly at-least-once and the crash window is tested.
  **Schema change — had to land before M2.**
- **Order creation was the one unprotected write.** `POST /api/orders` sat outside the mutation
  protocol, so a lost response plus a retry created two orders. Creation is now `CREATE_ORDER`
  with a client-generated `orderId` and `baseVersion: 0`, through the same handler. The separate
  endpoint is gone. Bonus: a terminal can now create an order while offline.
  **Changes `MutationType`, so it had to land before M1.**
- **The print job over-promised.** `ticket_hash` deduplicates a database row, not paper: if the
  printer emits and the worker then dies, the retry reprints. Now stated as at-least-once, with
  the reasoning that a missing ticket loses an order while a duplicate wastes paper. The test
  covers the fake printer's idempotency-key contract, not a claim about hardware.
- **"Safe merge" was impossible as written.** §8 promised to merge independent `ADD_ITEM`s while
  §6's strict versioned UPDATE rejects any stale `baseVersion` — the merge path could never have
  executed. Removed. All stale mutations conflict; merging happens only through the human-driven
  rebase. Server-side replay of commutative operations is now discussed in the interview guide as
  the road not taken. This was the only review point that *reduced* scope.
- **Rebase is sequential.** A, B and C cannot share one fresh `baseVersion`; A rebases onto v6,
  then B onto v7 after A applies, then C onto v8, each with a new `mutationId`.
- **`POS-3` added to `Second Restaurant`.** Every terminal belonged to tenant one, so neither the
  cross-tenant test nor a two-restaurant flag rollout could actually be shown. Also defined how an
  open client learns a flag flipped: polling `GET /api/config` every 15 s. A WebSocket control
  event would be circular when the flag disables WebSocket.
- **CI was self-contradictory** — service containers plus a script that starts Compose would bind
  the same ports twice. CI now calls `pnpm verify:integration` and declares no services.
- Arithmetic: M0–M19 is twenty milestones, not nineteen. Corrected everywhere.

## Known problems / open questions

- Scope grew across both reviews and nothing was cut, by explicit choice. Watch the usage budget;
  the drop order is recorded above.
- M10 (print job) survives mainly because BullMQ was wanted as a résumé keyword. Both reviewers
  independently flagged it as an invented responsibility, and it is first on the drop list.
- Infrastructure URLs intentionally have development defaults. M14 production images must require
  explicit values rather than inheriting localhost defaults.
- **Kafka is not in the test path.** The publisher is tested against a fake transport and the
  consumer's projection is tested by calling it directly. The real broker round trip was verified
  by hand at the end of M3 and is automated in M6 by `pnpm verify:integration`. §21.12 (crash
  after publish) and §21.16 (lease expiry, two workers) belong to M9.
- The worker connects to Redpanda at startup and will exit if the broker is down. That is
  acceptable for a demo but is the opposite of the API's readiness rule (§17): M6 should decide
  whether the worker retries its connection instead.
- `outbox_events` and `processed_mutations` grow without bound. Archiving is out of scope and
  worth saying out loud in the interview rather than pretending otherwise.

## First command of the next session

```
Read docs/PROGRESS.md. Expand M4 from docs/MILESTONES.md into docs/milestones/M04.md, then implement M4 only. Stop when the Verification block passes.
```
