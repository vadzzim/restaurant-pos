# Progress / Handoff

> This file is read first in every new session. Keep it short and accurate.
> Update it at the end of every milestone, before committing.

## Current state

**Last completed milestone:** M7 — the three §14 Dexie tables, local writes on every action, and
hydration at startup under the ownership rules M4's review established.
**The entire order lifecycle is demoable end to end, a broker outage is demoable, and now so is
reloading the tab mid-order.**
**Next:** M8 — offline queue, sequential sync, §14.1 halt-on-conflict. Model: **Opus**.
Size: **L**. The M7 review's open P2 is closed: the cache write is monotonic.

M0 `9a87b86`, M1 `3b498e8`, M2 `2ed4ce3` + `d43c194`, M3 `9637c92` + `507700f`, M4 `afc77c5` and
four review commits through `50d4ac7`, M5 `f6888e6` plus two review commits through `c8dde81`,
M6 `860b064` plus five review rounds through `fa1255a`, M7 `fe9d5d1` plus its first review round at
`2666d4a` and its second in this commit. The tree passes typecheck, lint,
build and **219 tests** (61 domain, 52 api, 22 worker, **83 web**) against a real PostgreSQL, plus
**one integration test** against a real Redpanda that runs only under `pnpm verify:integration`.
Ten of the sixteen mandatory §21 tests exist and are named by their spec number: 21.1, 21.2, 21.3,
**21.4**, 21.5, 21.6, **21.9**, **21.10**, 21.11, 21.15.

## What exists

- `CLAUDE.md`, `docs/spec.md`, `docs/MILESTONES.md`, `docs/build-log.md`.
- `docs/milestones/M01.md` … `M07.md` — the completed briefs.
- ADRs 001, 003, 004, 005, 006, 007, 009, 011, 012, **013** accepted.
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
- **The client's durable state (M7):** `apps/web/src/persistence/db.ts` — the Dexie database, schema
  version 1, `orders / pendingMutations / syncMetadata`; `local-store.ts` — the repository, the
  `persistenceError` ref and the `plain()` unwrapper; `domain/order-snapshot.ts` — the one
  `acceptsSnapshot` both memory and disk obey; `hydrate` on the order store and `hydrateCommands`
  on the kitchen store; `fake-indexeddb` in the vitest setup.
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
  takes the command out of ioredis's ordered response queue. It is **not** reopened once `close()`
  has run — a probe still in flight at shutdown fails afterwards, and a replacement installed then
  would keep reconnect timers alive and stop the API exiting on SIGTERM.
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
  answers `ALREADY_APPLIED`) or Discard (accept an unknown outcome). **Both are durable since M7**:
  the identity survives a reload in `pendingMutations`, and Discard deletes the row rather than only
  the memory. What M8 adds is not durability but a *queue* — more than one unresolved mutation per
  aggregate, synced in order, halting on a conflict.
- **Client state that outlives a screen has an explicit owner.** `adopt` refuses a snapshot older
  than the one held for that order; `refetch` re-checks that the order it asked about is still
  current; `connection.start`/`stop` claim a generation. This class of bug is what three of the
  four M4 review rounds found. **M7 added a writer to every one of them**: hydration goes through
  `adopt`, fills a pending slot only when it is empty, and claims a **generation** — `useTerminal`
  and `releaseTerminal` — because the terminal id outlives the screen and an id check would let a
  departed view write into its successor. M8 adds the next writer, the sync engine, to the same
  state.
- **`adopt` displays; `send` and `refetch` cache.** Caching is keyed by the terminal that *asked*
  the server, which is not always the terminal on screen — an answer can land after the operator
  has walked to another till. Putting the write inside `adopt` keyed all three callers by whatever
  was showing, and the M7 review found it.
- **A pending row is deleted only after the answer that settles it is cached.** The two IndexedDB
  writes are not atomic. Deleting first leaves the one state that loses money: a `CREATE_ORDER`
  with no row, no snapshot and no pointer, so the reload shows an empty till and the operator rings
  the order up twice. **Do not reorder these two writes.**
- **The cache write is monotonic, and the rule that makes it so has exactly one home.**
  `acceptsSnapshot` lives in `apps/web/src/domain/order-snapshot.ts`; `adopt` applies it to memory
  and `saveOrder` applies it to disk, inside the one `readwrite` transaction that reads, compares
  and writes. **Do not restate it in a caller** — round 2 of the M7 review was exactly the disk
  half of the rule going missing when the write moved out of `adopt`. The **pointer** is not under
  the rule: `syncMetadata.currentOrderId` moves even when the snapshot is refused, because it says
  which order this device is on, not which version of it is newest.
- **`hydrate` ends with a canonical read, and that belongs to the store, not the view.** The
  socket's `onConnected` refetch does not run when `realtime.websocket_push` is off or
  `GET /api/config` fails, so a view-level refresh would leave the cache on screen indefinitely on
  the transport M13 exists to complete.
- **The three §14 tables are written but not yet read by a sync engine (M7).** `orders` is a cache
  and is pruned; `pendingMutations` is the durable fact, keyed by `mutationId`, **never
  regenerated**; `syncMetadata` is per terminal and holds the pointer to the order that device is
  working on. M7 writes only `SYNCING` (before a request goes out) and `PENDING` (back, when no
  answer came); `CONFLICT`, `BLOCKED` and `SYNCED` exist in the union and are M8's to write. ADR 013.
- **A storage failure can never break a command.** Every repository call resolves with a neutral
  value and records the failure in the exported `persistenceError` ref, shown as `NOT DURABLE`. The
  ref is **not** cleared by a later success: a failed write is never retried, so the fact stays true.
- **Everything crossing into Dexie goes through `plain()`.** IndexedDB clones what it stores and a
  Vue reactive proxy raises `DataCloneError`. One `toRaw` helper in the repository, where the
  provenance of the values is known. `fake-indexeddb` implements cloning for real, so the test
  catches it; a mocked Dexie would not.
- **The kitchen's hydration filter is by restaurant *and* terminal, the POS's by terminal alone.**
  A POS terminal belongs to one restaurant; every kitchen display shares `kitchen-display` across
  all of them. Dropping the restaurant filter puts another tenant's commands on the rail.
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
- Full scope, nothing cut. **Twenty milestones total, thirteen still to run.**
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
- **Client durability is IndexedDB through Dexie, in the three §14 tables** — not a Pinia
  persistence plugin, which serialises whole-store state to `localStorage` and would restore
  derived fields whose restoration is meaningless (ADR 013). The snapshot is a cache; the
  `mutationId` is the fact worth keeping.

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
- **Each of rounds 2, 3 and 4 found what the previous fix opened, exactly as M4 and M5 did.** Round
  1 wired a correct signal to the wrong object — a liveness flag on the supervisor and one on the
  session read identically at the call site and differ precisely during the failure they exist for.
  Round 2 split a condition with the wrong polarity: a blacklist where only a whitelist is safe,
  because "the broker answered" does not imply "this row is at fault". Round 3 bounded a command
  without releasing it. Round 4 made a resource disposable without saying what that means during
  shutdown. **All four were in the same forty lines** — the ones carrying ADR 011's one real claim.
  Round 3 also caught a test that could not fail: it built a `KafkaJSProtocolError` from a string,
  so the field it meant to assert on was `undefined`.
- **Five rounds, findings 4 → 3 → 2 → 1 → 0.** The cycle converged to a clean report. The honest
  line for the interview is not "the code was right" but "the invariant was stated precisely and
  attached to a mechanism imprecisely four times, and an external reviewer caught each one".
- **M7's review found three, and all three were about *when* a write happens rather than whether
  it does.** The pending row was deleted before the answer that settles it was cached; hydration
  left the refresh to a view that only performs it on one of two transports; and the owner check
  used the terminal id, which outlives the screen. The brief had listed the owners in a table
  before any code and still missed all three — because the table asked "who may write this?" and
  every finding answered "the right writer, at the wrong moment". **Add the second question to the
  next milestone's brief: for each pair of writes, which order survives a crash between them?**
  That is the M8 question exactly: the sync engine is the *third* writer of this state, and it is
  the first that runs without a screen asking it to.
- **Round 2 found one, and it was opened by round 1's fix — the fifth milestone running.** Pulling
  the persist out of `adopt` moved the write and left the rule behind: `acceptsSnapshot` still
  guards memory and no longer guards the disk. Splitting a function into two responsibilities means
  asking which of its invariants belonged to which half, and I moved the code without asking.

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
- **One pending mutation slot per terminal on the POS, one per order in the kitchen.** Durable
  since M7, but still **one** slot: while it is occupied that terminal takes no new commands. M8
  replaces the slot with a queue and gives the POS the per-aggregate granularity the kitchen
  already has.
- **The screens are still not optimistic.** §14 says the UI updates optimistically and never waits
  for the server; that sentence needs the queue, so M7 left it alone and the screens still show the
  canonical answer. Worth saying out loud rather than claiming §14 is done.
- **The client database is shared by every tab on the origin.** Two POS tabs on the same terminal
  id write the same pointer and the same pending slot. The in-memory slot already assumed one
  screen per terminal, so nothing changed — but a demo that opens two tabs on `/pos/pos-1` would
  find it.
- **A cached snapshot is briefly stale after a reload**, between hydration and the first refetch.
  That is what the cache is for, and it is visibly wrong for a moment against a server that moved
  on while the tab was closed.
- **A poison message on the realtime topic is lost to that consumer group permanently.** A
  consumer-side dead-letter topic is the real answer and is not built. The publish side already
  dead-letters through `outbox_events`.
- **The concurrent tests assert invariants, they do not force the interleaving.** §21.1 and §21.10
  cannot fail falsely, but neither is a proof that the unguarded code was broken — the reasoning in
  `build-log.md` is.
- `outbox_events` and `processed_mutations` grow without bound. Archiving is out of scope.

## First command of the next session

```
Read docs/PROGRESS.md. Two commits this session, in this order.

**Commit 1 — close the open P2 from the M7 review's second round.** Do this first, before
reading anything about M8: it is roughly twenty lines, it is in the code M8 is about to build
on, and leaving it open means M8's sync engine inherits a cache that can move backwards.

`localStore.saveOrder` overwrites unconditionally. `adopt` refuses a snapshot older than the
one held; the two callers that persist — `send` and `refetch` in `apps/web/src/stores/order.ts`
— do not, because pulling the write out of `adopt` in the first review round moved the write
and left the rule behind. Two overlapping refetches answering v5 then v4 leave the screen at v5
and IndexedDB at v4; a mutation response racing a newer refetch is the same shape.

Three things about the fix:

- **The comparison goes in the repository, not the store.** A caller that reads the stored
  version and then writes in two calls reproduces the race one level down. It must be one
  Dexie `readwrite` transaction over `orders` that reads, compares and writes.
- **The rule is `acceptsSnapshot`'s, and there must be exactly one of it.** Import it rather
  than writing a second version — a rule stated twice is a rule that will disagree with itself.
  Note the asymmetry it already encodes: a *different* order id is always accepted.
- **The pointer is a separate question from the snapshot.** `saveOrder` writes both. Decide
  explicitly whether a rejected snapshot should still move `syncMetadata.currentOrderId`, and
  say why in the comment. (It should: the pointer is about which order this device is on, not
  about which version of it is newest.)

Test it against a real out-of-order pair, and check the test fails without the fix. Then
commit on its own: `M7 review 2: the cache write that was not monotonic`.

**Commit 2 — M8.** Expand M8 from docs/MILESTONES.md into docs/milestones/M08.md, then
implement M8 only. Stop when the M08 Verification block passes.

Seven things worth knowing before you plan, so the session does not rediscover them:

1. The storage is built and the schema will not change. `apps/web/src/persistence/db.ts` holds
   the three §14 tables at schema version 1; `local-store.ts` is the repository. M7 writes
   `SYNCING` before a request goes out and `PENDING` back when no answer came. `CONFLICT`,
   `BLOCKED` and `SYNCED` are in the union, unwritten, waiting for you. If you need a new index,
   that is a Dexie version 2 — do not edit version 1's store definition.
2. The sync engine is the **third** writer of state that already has two, and the first that
   runs without a screen asking it to. `adopt`, `refetch`, `pendingByTerminal`,
   `connection.start/stop` and `createCoalescingLoader` each have a rule; M7's `hydrate` and
   `hydrateCommands` claim a generation and fill only empty slots. Read the ownership table at
   the top of `docs/milestones/M07.md` before touching a store.
3. **Ask the second question this time.** M7's brief tabulated "who may write this?" and all
   four review findings still landed — three of them "the right writer at the wrong moment",
   the fourth "the write moved and the rule did not". So for every pair of writes M8 adds, put
   in the brief: *which order survives a crash between them, and which invariant guards each
   half?*
4. A `mutationId` is never regenerated — **except by a rebase, which is the one place §14.1
   says it must be.** A rebase re-issues a blocked mutation with a *new* id at a *fresh*
   baseVersion, sequentially, one at a time, each subject to §8. Everything else — retry,
   hydration, a reconnect — reuses the stored id so §9 answers `ALREADY_APPLIED`.
5. The halt is per aggregate, and the POS still has one slot per terminal. Giving the POS the
   per-order queue the kitchen already has is part of M8, not a refactor to skip.
6. `Simulate Offline` intercepts at the API-client layer (`apps/web/src/api/client.ts`), not in
   the stores and not via DevTools — the demo has to be deterministic. Nothing auto-resolves: a
   conflict surfaces the canonical state next to the local intent and waits for discard or
   rebase, because silent auto-rebase is last-write-wins in disguise.
7. Verification runs `pnpm -F @pos/web test` plus lint/typecheck/build, and §21.7 and §21.8 are
   named tests. `pnpm verify:integration` must stay green; M8 should not need server changes,
   and if it seems to, say so before making one.
```

M8 is the offline queue, the sequential per-aggregate sync engine, and §14.1's halt-on-conflict in
full. It is an **L** milestone on **Opus** because the correctness is in the interleaving: one
mutation at a time per aggregate, other aggregates unaffected, and a conflict that stops a queue
without stopping the client.

The class of bug to watch for is unchanged and now has a third instance waiting: client state with
an owner, and a new writer that does not honour it. M7 added the second writer; the review found
four ways it was added at the wrong moment. The sync engine is the third.
