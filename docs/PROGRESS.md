# Progress / Handoff

> This file is read first in every new session. Keep it short and accurate.
> Update it at the end of every milestone, before committing.

## Current state

**Last completed milestone:** M6 — the typed error model, §20 correlation fields, the three-way
health split with its ADR, the supervised worker, `pnpm verify:integration` and CI.
**The entire order lifecycle is demoable end to end, and now so is a broker outage.**
**Next:** M7 — Dexie / IndexedDB persistence. Model: Sonnet.

M0 `9a87b86`, M1 `3b498e8`, M2 `2ed4ce3` + `d43c194`, M3 `9637c92` + `507700f`, M4 `afc77c5` and
four review commits through `50d4ac7`, M5 `f6888e6` plus two review commits through `c8dde81`,
M6 `860b064` plus three review commits through `HEAD`. The tree passes typecheck, lint, build and
**183 tests** (61 domain, 52 api, 22 worker, 47 web) against a real PostgreSQL, plus **one
integration test** against a real Redpanda that runs only under `pnpm verify:integration`. Ten of the sixteen
mandatory §21 tests exist and are named by their spec number: 21.1, 21.2, 21.3, **21.4**, 21.5,
21.6, **21.9**, **21.10**, 21.11, 21.15.

## What exists

- `CLAUDE.md`, `docs/spec.md`, `docs/MILESTONES.md`, `docs/build-log.md`.
- `docs/milestones/M01.md` … `M06.md` — the completed briefs.
- ADRs 001, 003, 004, 005, 006, 007, 009, **011**, 012 accepted.
- `packages/config` — zod environment, `TEST_DATABASE_URL`, Kafka topics, outbox tuning.
- `packages/contracts` — statuses, the nine `MUTATION_TYPES`, the nine event types, every mutation
  and event payload, the §5 request/response shapes, `ConflictReason`, `PaymentMethod`,
  `KitchenTicketState`, `KITCHEN_TERMINAL_ID`, menu and config DTOs, socket names, `TERMINALS`.
- `packages/domain` — `calculateTotalCents`, `isValidTransition`, and `decide()`: **the whole of
  §8**, table-driven, no database and no HTTP.
- `packages/db` — schema (all thirteen tables), migrations, seed, `db:check`, `@pos/db/testing`.
  **No schema change was needed in M5**; M2 wrote it in full, and `payments` and the rest of
  `kitchen_tickets.state` finally got used.
- `apps/api` — `POST /api/orders/:orderId/mutations` with nine zod branches; the two §17 kitchen
  adapters `POST /api/kitchen/orders/:orderId/{preparing,ready}`; the reads `GET /api/menu`,
  `/api/orders/:orderId`, `/api/kitchen/tickets`, `/api/config`; `src/modules/realtime/` — the
  Socket.IO server with the Redis adapter, `roomsFor()`, and the §12.2 consumer.
- `apps/worker` — the §10 three-step outbox publisher with lease, backoff and dead-lettering; the
  Kafka producer and topic bootstrap; the kitchen consumer and its transactional projection, which
  now **advances** `state` from `OrderPreparing`, `OrderReady` and `OrderCancelled`.
- `apps/web` — a POS screen with all six of its commands (add, ±quantity, remove, send, pay,
  cancel) and a kitchen screen with four columns and two command buttons. Pinia stores for menu,
  order, kitchen and connection. `/debug` and `/demo` are still the M1 placeholder (M11, M16).
- **The operational surface (M6):** `/api/health/{live,ready}` and `/api/debug/dependencies`; the
  §17 envelope produced in one handler with `ApiErrorCode` closed in contracts; `requestId` and
  `traceId` on every request log line; `scripts/verify-integration.mjs`; `.github/workflows/ci.yml`.

## Facts the next milestone depends on

- **One write path, three routes into it.** `applyMutation` is the only function that writes an
  order. The canonical `POST /api/orders/:orderId/mutations` and the two kitchen adapters all go
  through `executeMutation` in `apps/api/src/modules/orders/api/mutation-reply.ts`, which is the
  single place an outcome becomes an HTTP reply and a log line — and, since M6, the single place
  §20's correlation fields are logged. Anything a future milestone wants on every mutation goes
  there, never into the three route handlers.
- **Everything leaving the API is one of three shapes**: a §5 domain outcome, the §17 envelope
  `{ code, message, details }` with `code: ApiErrorCode`, or a health report. `buildApp()` installs
  the one error handler and the one not-found handler; no route builds an error body. A conflict is
  never an error — it carries a snapshot and a reason that §14.1 branches on.
- **`traceId` is the client's if it sends one.** `x-trace-id` (else the requestId) is bound to the
  request logger, passed into `applyMutation`, written to `outbox_events.trace_id`, copied onto the
  `DomainEvent` and logged by both consumers. `x-request-id` seeds `request.id`. Both are sanitized
  in `apps/api/src/shared/request-context.ts`.
- **Readiness checks the hard dependencies and there is exactly one: PostgreSQL** (ADR 011).
  Redpanda and Redis down is `degraded`, never unready. `registerHealthRoutes` throws at boot if it
  is given no hard probe. Probes are injected in `index.ts`; `buildApp()` defaults to PostgreSQL
  alone so `fastify.inject` tests need no infrastructure.
- **The worker never publishes while its broker is disconnected** (ADR 011). A failed publish costs
  an `attempt_count`, so publishing through an outage would dead-letter events that were never bad.
  `broker.current()` is `undefined` while disconnected and the publisher loop idles.
- **The session dies on a failed send, not on `DISCONNECT`.** KafkaJS emits that instrumentation
  event for an explicit disconnect only, never for the broker vanishing under an open socket — the
  one case the supervision exists for. `publishOnce` also breaks out of a batch through
  `isTransportAlive`, so a blip costs one attempt rather than one per claimed row. **Do not move
  the death signal back onto a KafkaJS event**; the M6 review found exactly that.
- **Liveness belongs to the session, never to the supervisor.** `broker.current()` still returns a
  session while its teardown is in flight, and later returns its replacement, so
  `isTransportAlive` is taken from the same `BrokerConnection` object as the transport being used.
  Round 2 of the review found the version that asked the supervisor instead.
- **A record the broker rejected is not a dead broker — but "the broker answered" is not "the record
  is at fault" either.** `isRecordRejection` matches an explicit **whitelist**, `RECORD_REJECTIONS`:
  the produce errors about the record itself. `TOPIC_AUTHORIZATION_FAILED` is a
  `KafkaJSProtocolError` too and means every row will fail, so it ends the session like any outage.
  **Do not widen this back to `instanceof` alone**; review round 3 found exactly that. The default
  is asymmetric on purpose: an unfamiliar code costs one reconnect, the other way costs a
  dead-lettered order event. All of it lives in `apps/worker/src/shared/broker-session.ts` **with
  unit tests** — it was in `index.ts`, where nothing could be asserted, which is why two P1s hid
  there.
- **A probe timeout gives up, it does not cancel.** Anything a probe calls has to be bounded at its
  own client — the pool's `connectionTimeoutMillis`, the probe broker's disabled retries — or a
  long outage accumulates one abandoned operation per health request. Redis takes **two** sources:
  the adapter client's `status` says whether broadcasts have a connection, and a third client with
  `enableOfflineQueue: false` and a `commandTimeout` carries the actual `PING`, because a half-open
  socket leaves ioredis reporting `ready` with nothing moving. That probe client is **thrown away
  and reopened on every failure**: `commandTimeout` rejects the promise, but only closing the socket
  takes the command out of ioredis's ordered response queue.
- **`decide()` owns §8 and nothing else does.** Nine mutation types, six statuses, one table-driven
  function, one matrix test. A rule added anywhere else is a bug. The order of checks is fixed:
  **domain rule first, version second** — §21.4 fails if that is reversed, because a client at v5
  against a cancelled order at v6 must hear `ORDER_CANCELLED`, the reason it can act on.
- **`decide()` returns the status the order should end in**, and `guardedVersionBump` writes it
  unconditionally in one statement. For an item mutation that is the status it already had.
- **Two §8 cases are `ALREADY_APPLIED`, and only two**: removing a line that is not there, and
  cancelling a cancelled order. Everything else conflicts, including a repeated kitchen transition
  (`INVALID_STATUS_TRANSITION`) and a quantity change to the value already stored (which applies
  and bumps the version). The reasoning is in `build-log.md` under M5.
- **`ALREADY_APPLIED` is the one answer that asserts state without writing it**, so it is the one
  place with no versioned UPDATE to protect it. `alreadyAppliedOutcome` therefore locks the order
  row (`select … for update`) and takes the decision again under that lock, in one transaction with
  the `processed_mutations` insert. **Do not turn that back into a bare read**: without it, an
  `ADD_ITEM` committing in the gap makes a no-op removal acknowledge a line that is still there.
  This is the only pessimistic lock in the write path; everywhere else optimism is correct because
  there is a write to guard. Both regression tests are deterministic — they hold the row and poll
  `pg_stat_activity` until the acknowledgement is provably blocked.
- **`PAY` carries `{ method }`, never an amount.** `payments.amount_cents` is the order's canonical
  total read inside the transaction; `payments.mutation_id` is unique as a backstop, but §21.9
  passes through `processed_mutations` like every other repeat.
- **The kitchen commands at `ticket.source_event_version`** — the only version its projection has.
  It can lag, and then the command conflicts and the operator presses again. That is the designed
  outcome, recorded in ADR 012. Kitchen commands carry `terminalId: 'kitchen-display'` unless a
  display names itself; no table has a foreign key to `terminals`.
- **A new event type has to be handled in three places or it is invisible somewhere**: the kitchen
  projection's `STATE_BY_EVENT_TYPE`, `KITCHEN_EVENT_TYPES` in `broadcast.ts`, and the browser. The
  four kitchen event types and the four the projection acts on are deliberately the same four —
  `OrderPaid` is the counter-example: it moves the order but no ticket, so it stays out of the
  kitchen room, and a kitchen that received it would burn its retry budget waiting for a projection
  change that was never coming.
- **Two consumers read `restaurant.order.events`**, on separate groups: `kitchen` in `apps/worker`
  and `realtime` in `apps/api`. Both write `processed_events` under their own `consumer_name`
  (ADR 006). Events are keyed by `orderId`; ordering holds within a partition and nowhere else
  (ADR 005).
- **Nothing orders the two consumer groups against each other.** A broadcast can arrive before the
  projection it refers to has been written, so the kitchen store reads until
  `source_event_version >= event.version` on a bounded backoff. A screen reading `orders` does not
  need this, because that row is written by the transaction that wrote the outbox row.
- **Not every event earns that wait, but nearly every one does.** `expectationFor` decides, and the
  rule is narrow on purpose: **only `OrderCancelled` with no ticket on screen skips the wait**,
  because `CANCEL` is valid on an `OPEN` order and the projection then records the event without
  building anything — waiting there burns the retry budget and raises `PROJECTION LAG` over a fault
  that does not exist. Every other kitchen event concerns a ticket that exists, so an empty local
  list means the projection is behind, which is the one case the wait is for. **Do not widen the
  skip to "no ticket held"** — that skips the wait exactly when it is needed, and the event gate
  has already spent that event's only hint.
- **The browser filters what the socket delivers**: dedup by `eventId`, ignore `version` not
  greater than what it holds, refetch the snapshot on reconnect. A socket message never carries
  state into the UI — it only triggers a canonical read.
- **A mutation whose answer never came back keeps its identity and blocks further commands.** On
  the POS the slot is **per terminal**; in the kitchen it is **per order**, which is the aggregate
  and the granularity §14.1 halts at. Both resolve explicitly — Retry (same `mutationId`, so §9
  answers `ALREADY_APPLIED`) or Discard (accept an unknown outcome). M8 makes both durable.
- **Client state that outlives a screen has an explicit owner.** `adopt` refuses a snapshot older
  than the one held for that order; `refetch` re-checks that the order it asked about is still
  current; `connection.start`/`stop` claim a generation. This class of bug is what three of the
  four M4 review rounds found, and M7/M8 add durable client state — exactly where it reappears.
- **A list replaced wholesale is never loaded concurrently.** `createCoalescingLoader` runs one read
  at a time. The rule: an expectation may only be judged by a read *issued after* it was raised.
- **The publisher claims only an order's earliest unpublished event**, so that order's events reach
  Redpanda in version order regardless of retries or worker count.
- Test databases: `TEST_DATABASE_URL` (`pos_test`), created and migrated by `@pos/db/testing`. The
  demo database is never truncated by a test run.
- **`pnpm test` must stay runnable with PostgreSQL alone.** A suite needing a live broker is named
  `*.integration.test.ts`, excluded by `apps/worker/vitest.config.ts` and run by
  `vitest.integration.config.ts` under `pnpm verify:integration`. Such a suite uses its own topic
  and consumer group, suffixed per run: on `restaurant.order.events` the worker the user keeps
  running for the demo would consume the test's events into the demo database.
- **`pnpm verify:integration` tears down only what it started** and never touches volumes, so it
  cannot destroy a demo that is already up. A failed teardown fails the run: the script promised to
  leave the machine as it found it. CI runs that same command with no `services:` block.
- Workspace packages resolve through their `exports` to `dist`, so `pnpm run build:packages` runs
  before dev, typecheck, build, test and the db scripts. Vitest aliases the sources instead.
- Root `pnpm test` runs the suites with `--workspace-concurrency=1`; they share one test database.

## Decisions already made

- Fastify over NestJS, Drizzle over Prisma.
- Full scope, nothing cut. **Twenty milestones total, fourteen still to run.**
- **A demoable vertical slice landed at M4**, not M11. **Done.**
- **The realtime consumer lives in the API process on one shared consumer group**, with the Redis
  adapter fanning a broadcast out to the other instances (ADR 006). M14's multi-instance smoke test
  is what turns that adapter claim into a tested fact.
- **Redpanda and Redis are soft dependencies of the API.** `buildApp()` is routes-only; the socket
  server and the supervised consumer are wired in `index.ts`. Readiness checks PostgreSQL only.
- **Reads that span two tables are `repeatable read`.**
- **A socket message is a hint, never data.** The client refetches the canonical snapshot (§13).
- **The user starts the infrastructure.** Claude never runs `docker compose` and never reads
  container logs. `pnpm verify:integration` is the one exception and the one reproducible command:
  Compose up, wait for the healthchecks, run the infrastructure-backed suites, tear down only what
  it started, write the output to `.verify-output/integration.log`. **Built in M6.** CI calls that
  same command and declares no service containers.
- **Drop order if the interview date closes in:** M10 (print job), then M16 (`/demo`), then M17
  (PWA). Do not drop M15 or M18 first.

## Review rounds 1 and 2, the M4 reviews, and the M5 review

Recorded in full in `docs/build-log.md`. The habits worth carrying forward:

- **Client state that outlives the screen which created it, with no explicit owner**, was three of
  the four M4 findings. It is the class of bug M7 and M8 will reopen.
- **Every review round's findings were opened by the previous round's fix.**
- **M5's own lesson is narrower and sharper:** the correctness model here is "a write is the
  guard", so the one code path that answers without writing was the one the model did not cover.
  When adding an answer, ask what write makes it true. The M5 review also found a rule I had stated
  correctly in a comment (`KITCHEN_EVENT_TYPES`) and then broken two lines later — a comment is not
  a check.
- **M6's lesson came from finishing an outline rather than reviewing one.** Two error paths had been
  wrong since M3 — a malformed body answered 500, an unknown route answered Fastify's own shape —
  and neither had a test, because the handler was written for the errors the code raises rather than
  for the errors that reach it. Ask what arrives at a handler, not what is thrown at it.
- **The M6 review is that lesson one layer down, and it caught three instances of it.** The broker
  session hung on `DISCONNECT`, which does not fire when the broker vanishes; the correlation fields
  bound in an `onRequest` hook, which runs after Fastify's first log line; the probe race, which
  gives up without cancelling. Each trusted a signal to fire at a moment it does not cover. **Ask
  what the failure actually emits, not what the API has an event named after.**
- **Rounds 2 and 3 each found what the previous fix opened, exactly as M4 and M5 did.** Round 1
  wired a correct signal to the wrong object — a liveness flag on the supervisor and one on the
  session read identically at the call site and differ precisely during the failure they exist for.
  Round 2 split a condition with the wrong polarity: a blacklist where only a whitelist is safe,
  because "the broker answered" does not imply "this row is at fault". Round 3 bounded a command
  without releasing it. **All three were in the same forty lines** — the ones carrying ADR 011's one
  real claim. Round 3 also caught a test that could not fail: it built a `KafkaJSProtocolError` from
  a string, so the field it meant to assert on was `undefined`.
- **Three rounds was the stopping point, chosen deliberately.** The findings had narrowed to
  conditions this demo cannot reach — no ACLs anywhere, so no `TOPIC_AUTHORIZATION_FAILED` — and
  the budget belongs to M7.

## Known problems / open questions

- **`START_PREPARING` and `MARK_READY` conflict on a repeat rather than answering
  `ALREADY_APPLIED`.** This is deliberate (§8: out-of-order transitions conflict) and it is what
  makes §21.10 legible, but it means a kitchen display that lost a response and then *discarded*
  the pending command will be told `INVALID_STATUS_TRANSITION` if it presses again — technically
  right, and it reads like a failure. Worth saying out loud in the interview.
- **The kitchen commands from a lagging projection** and takes a conflict when it is behind
  (ADR 012). The projection is therefore load-bearing for writes, not only for display: a kitchen
  consumer that is down freezes the versions the rail commands at. M11's `/debug` is where that lag
  becomes a number.
- Scope grew across the reviews and nothing was cut, by explicit choice. Watch the usage budget.
- M10 (print job) survives mainly because BullMQ was wanted as a résumé keyword; it is first on the
  drop list.
- Infrastructure URLs intentionally have development defaults. M14 production images must require
  explicit values rather than inheriting localhost defaults.
- **Kafka is in the test path once, and only once.** `apps/worker/test/kafka-roundtrip.integration
  .test.ts` runs outbox row → producer → Redpanda → consumer group → projection for real, under
  `pnpm verify:integration`. Everything else still uses a fake transport or calls a handler
  directly, **no test opens a socket**, and the realtime consumer's KafkaJS wiring is covered only
  by the structurally identical worker path. §21.12 and §21.16 are M9's.
- **`/api/debug/dependencies` reports no consumer lag.** It needs a Kafka admin describing group
  offsets and belongs with §20's other counters in M11. The report is also a snapshot, not a
  monitor: it cannot say how long a dependency has been down, and the outbox backlog age is the
  only duration in it.
- **A degraded API keeps receiving traffic, and that is the design.** Readiness green with Redpanda
  down means clients reach an instance whose screens do not update live; §13's reconnect-and-refetch
  and M13's polling transport are the mitigation, not the probe (ADR 011).
- **The worker no longer fails fast.** A misconfigured broker address produces a warning every five
  seconds rather than an exit, which is easier to miss than a crash. The heartbeat carries
  `brokerConnected` for exactly that reason. Two supervision loops now exist, one per process,
  deliberately not shared (ADR 011).
- **Abandoned outbox rows stay leased for `OUTBOX_LEASE_MS`.** When a batch is cut short by the
  broker dying, the untouched rows keep their claim and are only republished once the lease expires
  — up to 30 s after recovery. Releasing the claim eagerly belongs with M9's lease hardening.
- **`GET /api/config` is the M4 stub of an M13 feature.** It reads `feature_flags` directly: no
  Redis cache, no percentage rollout, and the client fetches it once at bootstrap instead of every
  15 s. With the flag off the screens are correct but receive no live updates, because the polling
  transport — the flag's other, complete branch — is M13's.
- **`GET /api/kitchen/tickets` is not in §17's endpoint list**; it was added because the kitchen
  screen must read the projection. `GET /api/restaurants/:restaurantId/orders` is still unbuilt.
- **The socket has no authentication.** Any browser can subscribe to any restaurant's rooms.
  Deliberate for a demo with no auth anywhere, and worth saying out loud.
- **The projection wait is bounded and can still lose.** The kitchen screen shows `PROJECTION LAG`
  and the ticket appears only when a later event lands or the page is reloaded.
- **One named residue in `expectationFor`:** a cancellation of an order that *was* sent to the
  kitchen, but whose ticket this screen has not seen yet, gets no projection wait — the client
  cannot tell it apart from a cancellation of an `OPEN` order. Bounded by the next event or a
  reload. Closing it would mean putting "did this order ever reach the kitchen" into the
  `OrderCancelled` payload: a display concern in a domain event, which is why it was not done.
- **One pending mutation slot per terminal on the POS, one per order in the kitchen.** Both live in
  memory. M7 and M8 make them durable and give the POS the per-aggregate form the kitchen already
  has.
- **A poison message on the realtime topic is lost to that consumer group permanently.** A
  consumer-side dead-letter topic is the real answer and is not built. The publish side already
  dead-letters through `outbox_events`.
- **The concurrent tests assert invariants, they do not force the interleaving.** §21.1 and §21.10
  cannot fail falsely, but neither is a proof that the unguarded code was broken — the reasoning in
  `build-log.md` is.
- `outbox_events` and `processed_mutations` grow without bound. Archiving is out of scope.

## First command of the next session

```
Read docs/PROGRESS.md. Expand M7 from docs/MILESTONES.md into docs/milestones/M07.md, then implement M7 only. Stop when the Verification block passes.
```

M7 is persistence only — the Dexie schema `orders / pendingMutations / syncMetadata`, local writes
on every action, hydration at startup. **No sync engine**: that is M8, and the §14.1 halt-on-conflict
rule with it. The class of bug to watch for is the one three of the four M4 review rounds found —
client state that outlives the screen that created it, with no explicit owner — because M7 is where
that state stops being in memory and starts surviving a reload.
