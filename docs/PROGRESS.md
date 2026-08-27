# Progress / Handoff

> This file is read first in every new session. Keep it short and accurate.
> Update it at the end of every milestone, before committing.

## Current state

**Last completed milestone:** M2 — database schema, migrations, and seed data.
**Next:** M3 — the vertical slice through the backend. Recommended model: Opus.

M0 is `9a87b86`, M1 is `3b498e8`. M2 passes typecheck, lint, build, `db:migrate` (twice),
`db:seed` (twice, same counts) and `db:check` (13/13 tables selectable, partial outbox index
present). PostgreSQL, Redis, Redpanda and the Console are up and were left running.

## What exists

- `CLAUDE.md` — project conventions and context-budget rules.
- `docs/spec.md` — the canonical spec, distilled from both source prompts and revised.
- `docs/MILESTONES.md` — twenty milestones M0–M19 with briefs, a recommended model, and whether
  the project is demoable after each.
- `docs/milestones/M01.md`, `docs/milestones/M02.md` — the completed implementation briefs.
- `docs/build-log.md` plus accepted ADRs 001 and 007.
- M1 workspace skeleton: `apps/{api,web,worker}`, `packages/{config,contracts,domain}`, Compose,
  root tooling, a short README.
- M2 persistence: `apps/api/src/db/{schema,client,migrate,seed,check}.ts`, `drizzle.config.ts`,
  the committed migration in `apps/api/drizzle/`, and the scripts `db:generate db:migrate db:seed
  db:check` at both the api and root level. `packages/contracts` now exports the `ORDER_STATUSES`
  and `MUTATION_TYPES` value tuples, so the `order_status` PostgreSQL enum cannot drift from
  `OrderStatus`.

## Schema facts M3 depends on

- Slug text ids for `restaurants`, `terminals`, `products` (`demo-restaurant`, `pos-1`, `burger`);
  `uuid` for everything generated at runtime, including the client-generated `orders.id`.
- `outbox_events.id` **is** the `eventId` of the §11 envelope, and the row also carries
  `restaurant_id` and `trace_id` so the publisher can build the envelope without joining `orders`.
- `order_items` has `unique(order_id, product_id)`: one product is one line whose quantity
  changes, so `ADD_ITEM` is an upsert.
- `payments.mutation_id` is unique; `processed_mutations.mutation_id` is the primary key;
  `processed_events` is keyed by `(event_id, consumer_name)`.
- `outbox_events.aggregate_id`, `conflict_log.order_id` and `processed_mutations.order_id` are
  deliberately **not** foreign keys — the log, the audit record and the idempotency record must
  outlive the row that produced them.
- Only the intentional indexes exist, including the partial
  `outbox_events(next_attempt_at) where published_at is null and dead_lettered_at is null`.

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
- Shared packages build once when `pnpm dev` starts. Add watch mode or project references only if
  editing shared packages during a running dev session becomes a real source of friction.
- **There is still no test runner.** M3 introduces Vitest and the integration tests, and it will
  need a decision on how tests get a database: reuse the running Compose PostgreSQL with a
  per-suite truncation, or a separate database. `pnpm verify:integration` (M6) scripts whatever
  M3 chooses.
- `db:check` is a script, not a test. It proves the schema exists; it asserts nothing about
  behaviour. That is deliberate at M2 and is superseded once M3 has real tests.

## First command of the next session

```
Read docs/PROGRESS.md. Expand M3 from docs/MILESTONES.md into docs/milestones/M03.md, then implement M3 only. Stop when the Verification block passes.
```
