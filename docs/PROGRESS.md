# Progress / Handoff

> This file is read first in every new session. Keep it short and accurate.
> Update it at the end of every milestone, before committing.

## Current state

**Last completed milestone:** M4 — the frontend vertical slice: Socket.IO with the Redis adapter,
the §12.2 realtime consumer inside the API process, four read endpoints, and a POS screen and a
kitchen screen in Vue. **The project is demoable from here on.**
**Next:** M5 — the remaining six mutation types and the full §8 conflict matrix. Model: Sonnet.

M0 `9a87b86`, M1 `3b498e8`, M2 `2ed4ce3` + `d43c194`, M3 `9637c92` + `507700f`, M4 `afc77c5` + the
review fixes. The tree passes typecheck, lint, build and 74 tests (9 domain, 27 api, 11 worker,
27 web) against a real PostgreSQL. The seven mandatory M3 tests §21.1, 21.2, 21.3, 21.5, 21.6,
21.11 and 21.15 are still present and named by their spec number.

## What exists

- `CLAUDE.md`, `docs/spec.md`, `docs/MILESTONES.md`, `docs/build-log.md`.
- `docs/milestones/M01.md`, `M02.md`, `M03.md`, `M04.md` — the completed briefs.
- ADRs 001, 003, 004, 006, 007, 009 accepted.
- `packages/config` — zod environment, now including `TEST_DATABASE_URL`, the Kafka topic settings
  and the outbox tuning knobs.
- `packages/contracts` — statuses, mutation types, event types, order and event payload DTOs, the
  §5 request/response shapes, `ConflictReason`, and (M4) `MenuItem`, `KitchenTicket`,
  `ConfigResponse`, the socket event names, `SubscribeRequest`, and `TERMINALS` / `findTerminal`.
- `packages/domain` — `calculateTotalCents`, `isValidTransition`, and `decide()`: the one place
  that answers whether a mutation may apply to an order as it stands. No database, no HTTP.
- `packages/db` — schema, migrations, seed, `db:check`, and `@pos/db/testing` (creates `pos_test`,
  migrates, seeds, truncates between tests). **Moved here from `apps/api/src/db` in M3**, because
  the worker needs the same tables and one app cannot import another app's source.
- `apps/api` — `POST /api/orders/:orderId/mutations` (the only write path), zod validation, the
  §7 transaction, the §17 error model, `buildApp()` so tests can `inject`. **M4 added** the reads
  `GET /api/menu`, `GET /api/orders/:orderId`, `GET /api/kitchen/tickets?restaurantId=` and
  `GET /api/config?restaurantId=`, plus `src/modules/realtime/` — the Socket.IO server with the
  Redis adapter, `roomsFor()`, and the §12.2 consumer.
- `apps/worker` — the §10 three-step outbox publisher with lease, backoff and dead-lettering; the
  Kafka producer and topic bootstrap; the kitchen consumer and its transactional projection.
- `apps/web` — a working POS screen (`/pos/:terminalId`) and kitchen screen (`/kitchen`). Pinia
  stores for menu, order, kitchen and connection; `src/api/client.ts` typed entirely from
  `@pos/contracts`; `src/realtime/event-gate.ts` — the dedup + version filter of §12.2, unit
  tested. `/debug` and `/demo` are still the M1 placeholder (M11, M16).

## Facts M5 depends on

- **One write path.** `POST /api/orders/:orderId/mutations`. There is no `POST /api/orders`: the
  client generates the `orderId` (uuid) and sends `CREATE_ORDER` with `baseVersion: 0`.
- The client must send `mutationId` (uuid v4), `terminalId`, `restaurantId`, `baseVersion`, `type`
  and `payload`; responses are exactly the §5 shapes, typed in `@pos/contracts` as
  `MutationResponse`. Validation failures use the §17 `{ code, message, details }` envelope.
- **`SUPPORTED_MUTATION_TYPES` in `@pos/contracts` is still the M3 three.** M5 widens it, extends
  the zod discriminated union in `mutation-routes.ts`, the `EVENT_TYPE_BY_MUTATION` map and the
  effect switch in `mutation-handler.ts`, and adds rules to `decide()`. The handler's shape does
  not need to change — that was M3's stated contract with M5.
- **The POS screen already issues real mutations,** so every new type M5 adds needs a button and
  the same `baseVersion`-from-the-snapshot discipline the three existing ones use. The kitchen
  screen has a `New` column only; `PREPARING` and `READY` and their two commands are M5's.
- The kitchen projection is `kitchen_tickets`, written only from `OrderSentToKitchen`, with
  `state = 'SENT_TO_KITCHEN'` and `source_event_version`. The kitchen screen reads it through
  `GET /api/kitchen/tickets`. Once `START_PREPARING` and `MARK_READY` exist, the consumer has to
  advance `state` from `OrderPreparing` and `OrderReady` or the screen will not move.
- Events on `restaurant.order.events` are keyed by `orderId`; the envelope is `DomainEvent`.
- **Two consumers now read that topic**, on separate groups: `kitchen` in `apps/worker` (builds the
  projection) and `realtime` in `apps/api` (broadcasts). Both write `processed_events` under their
  own `consumer_name`. A new event type has to be handled in both or it will be invisible on one
  screen. See ADR 006.
- **The browser filters what the socket delivers**: dedup by `eventId`, ignore `version` not
  greater than what it holds, refetch the snapshot on reconnect. A socket message never carries
  state into the UI — it only triggers `GET /api/orders/:id` or `GET /api/kitchen/tickets`.
- **Nothing orders the two consumer groups against each other.** A broadcast can arrive before the
  projection it refers to has been written, so the kitchen store reads until
  `source_event_version >= event.version` on a bounded backoff. Any future screen that reads a
  projection built by a different consumer needs the same wait; a screen reading `orders` does not,
  because that row is written by the transaction that wrote the outbox row.
- **The kitchen socket joins only `kitchen:{restaurantId}`,** and `roomsFor` decides which event
  types reach it through `KITCHEN_EVENT_TYPES`. M5 adds `OrderPreparing`, `OrderReady` and
  `OrderCancelled` there at the same time as it teaches the kitchen consumer to advance `state`.
- **A mutation whose answer never came back keeps its identity** (`orderId`, `mutationId`,
  `terminalId`, `restaurantId`) and is retried unchanged, so §9 resolves it as `ALREADY_APPLIED`.
  **One slot means the terminal halts:** while it is occupied every command is refused, because
  sending another would overwrite the only id that can still settle the first. Resolution is
  explicit — Retry, or Discard and accept an unknown outcome. Same shape as §14.1, which is why M8
  generalises it per aggregate rather than replacing it.
- **A list that is replaced wholesale is never loaded concurrently.** `createCoalescingLoader` runs
  one read at a time and folds in whatever arrived meanwhile. The rule it encodes: an expectation
  may only be judged by a read *issued after* it was raised — an in-flight read predates the event
  and proves nothing about it, even when it happens to contain the effect.
- **The publisher claims only an order's earliest unpublished event**, so that order's events reach
  Redpanda in version order regardless of retries or how many workers run. A pass that published
  something immediately runs again instead of waiting out the poll interval.
- Test databases: `TEST_DATABASE_URL` (`pos_test`), created and migrated automatically by
  `@pos/db/testing`. The demo database is never truncated by a test run.
- Workspace packages resolve through their `exports` to `dist`, so `pnpm run build:packages` runs
  before dev, typecheck, build, test and the db scripts. Vitest aliases the sources instead.
- Root `pnpm test` runs the workspace suites with `--workspace-concurrency=1`, because they share
  one test database.

## Decisions already made

- Fastify over NestJS, Drizzle over Prisma.
- Full scope, nothing cut. **Twenty milestones total, sixteen still to run.**
- **A demoable vertical slice lands at M4**, not M11. The original ordering finished the backend
  first, which risked reaching the usage limit with green tests and nothing to show. **Done.**
- **The realtime consumer lives in the API process on one shared consumer group**, with the Redis
  adapter fanning a broadcast out to the other instances (ADR 006). M14's multi-instance smoke test
  is what turns that adapter claim into a tested fact, and it only means something because the
  group is shared.
- **Redpanda and Redis are soft dependencies of the API.** `buildApp()` is routes-only; the socket
  server and the consumer are wired in `index.ts`, and the consumer is *supervised* — retried both
  when it cannot start and when it dies later — so it never blocks `listen()` and never leaves the
  API alive with frozen screens. Readiness still checks PostgreSQL only (§17).
- **Reads that span two tables are `repeatable read`.** `GET /api/orders/:id` reads `orders` and
  `order_items`; at READ COMMITTED those two statements can straddle a commit and return a total
  that matches neither version.
- **A socket message is a hint, never data.** The client refetches the canonical snapshot; it does
  not rebuild order state from event payloads (§13 forbids event-replay infrastructure). This is
  also why M13's polling transport is the same code on a different trigger.
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

## M4 review — accepted

- **A broadcast can outrun the projection it points at.** Two consumer groups, no ordering between
  them; the kitchen screen now reads until the projection reaches the event's version, bounded, and
  shows `PROJECTION LAG` if it does not. The POS needs no such wait and does not have one.
- **`GET /api/orders/:id` reads at `repeatable read`.** Two SELECTs at READ COMMITTED could return
  one version's header with another's items.
- **The realtime consumer is supervised, and validates its envelopes.** A poison message used to be
  able to kill it permanently while the API kept serving.
- **A retried `CREATE_ORDER` reuses its `orderId` and `mutationId`.** Minting fresh ones made a lost
  response into a second order — the exact hole that dropping `POST /api/orders` was meant to close.
- **`adopt` refuses a snapshot older than the one held**, and `start` claims a generation so a slow
  bootstrap cannot outlive the `stop` that was supposed to cancel it.

Full reasoning in `build-log.md`. Ten regression tests were added.

## M4 review round 2 — accepted

- **Kitchen loads are coalesced,** not run in parallel; overlapping reads could take a visible
  ticket back off the screen.
- **An unresolved mutation halts the terminal** instead of being overwritten by the next command or
  dropped by "New order".
- **`refetch` checks that the order it asked about is still on screen.** `adopt` cannot tell a
  stale read from a newly created order.
- **`connectConsumer` cleans up after itself** if `subscribe` or `run` throws after `connect`.
- **`resolveTransport` has no side effects;** `start` writes `transport` only after its generation
  check.
- **The poison-message skip is terminal and now says so.** The offset is committed; no later build
  will see that message. Logged at `error`, not `warn`.

Full reasoning in `build-log.md`. Twelve regression tests were added.

## Known problems / open questions

- Scope grew across both reviews and nothing was cut, by explicit choice. Watch the usage budget;
  the drop order is recorded above.
- M10 (print job) survives mainly because BullMQ was wanted as a résumé keyword. Both reviewers
  independently flagged it as an invented responsibility, and it is first on the drop list.
- Infrastructure URLs intentionally have development defaults. M14 production images must require
  explicit values rather than inheriting localhost defaults.
- **Kafka is not in the test path.** The publisher is tested against a fake transport, and both
  consumers are tested by calling their handlers directly. No test opens a socket either — the
  broadcast is asserted through a fake emitter, and `roomsFor` is a pure function. The real round
  trip is verified by hand and automated in M6 by `pnpm verify:integration`. §21.12 (crash after
  publish) and §21.16 (lease expiry, two workers) belong to M9.
- The worker connects to Redpanda at startup and will exit if the broker is down. **The API no
  longer does** — M4 made its consumer start retry in the background. M6 should give the worker the
  same treatment, or state why it should not.
- **`GET /api/config` is the M4 stub of a M13 feature.** It reads `feature_flags` directly: no
  Redis cache, no percentage-by-hash rollout, and the client fetches it once at bootstrap instead
  of every 15 s. With the flag off today the screens are correct but receive no live updates,
  because the polling transport — the flag's other, complete branch — is M13's.
- **`GET /api/kitchen/tickets` is not in §17's endpoint list.** It was added because the kitchen
  screen must read the projection and no listed endpoint returns it; see `build-log.md`.
  `GET /api/restaurants/:restaurantId/orders` is still unbuilt — nothing needs it yet.
- **The socket has no authentication.** Any browser can subscribe to any restaurant's rooms. That
  is deliberate for a demo with no auth anywhere, and is worth saying out loud in the interview
  rather than leaving for someone to notice.
- **The projection wait is bounded and can still lose.** If the kitchen consumer is down, the
  kitchen screen shows `PROJECTION LAG` and the ticket appears only when a later event lands or the
  page is reloaded. M13's polling transport removes the reload as the last resort; M11's `/debug`
  is where consumer lag becomes visible as a number.
- **One pending mutation slot, not a queue.** It lives in memory and it halts the terminal while
  occupied, which is correct but coarse: a POS that loses one response takes no orders until a
  human presses Retry or Discard. M7 and M8 make it durable and per-aggregate, which is what makes
  the halt tolerable in a real rush.
- **A poison message on the realtime topic is lost to that consumer group permanently.** The offset
  is committed and no later build will be offered it; recovery is by hand from the topic, while
  retention lasts. A consumer-side dead-letter topic is the real answer and is not built. The
  publish side already dead-letters through `outbox_events`.
- **The concurrent-read test asserts an invariant, it does not force the interleaving.** It cannot
  fail falsely, but it is not a proof that the old code was broken — the reasoning in
  `build-log.md` is. A deterministic version would need statement-level hooks.
- `outbox_events` and `processed_mutations` grow without bound. Archiving is out of scope and
  worth saying out loud in the interview rather than pretending otherwise.

## First command of the next session

```
Read docs/PROGRESS.md. Expand M5 from docs/MILESTONES.md into docs/milestones/M05.md, then implement M5 only. Stop when the Verification block passes.
```
