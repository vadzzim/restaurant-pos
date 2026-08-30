# Progress archive

> **Write-only. Never read this file at the start of a session.**
>
> This is a frozen snapshot of the sections that used to live in `PROGRESS.md` and made it grow to
> 60 000 characters — an accumulating list of invariants, and summaries of review rounds whose full
> reasoning is in `build-log.md`. They were moved here on 2026-08-30, before M11.
>
> What replaced them:
>
> - **The invariants a milestone needs** are now written into `PROGRESS.md`'s
>   _First command of the next session_ block by the session that finishes the previous milestone.
>   That block is the context pack: the outgoing session knows what the next one needs, so it names
>   it, in thirty lines rather than three hundred.
> - **Review history has exactly one owner: `build-log.md`.** The summaries below were the second
>   copy. Nothing new is appended to this file.
>
> Search it with `grep` when you need one specific fact. Do not read it whole.

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
- **A mutation whose answer never came back keeps its identity and is simply still in the queue.**
  The next trigger re-sends it with the same `mutationId`, so §9 answers `ALREADY_APPLIED`. There is
  no Retry button on the POS any more and no `sameMutation`/`identityFor` — the row _is_ the
  identity. **The kitchen still keeps one slot per order** with its own Retry and Discard: it
  already halts at the aggregate, and the engine never touches its rows because they carry
  `KITCHEN_TERMINAL_ID`.
- **§14.1 in full, and nothing resolves itself.** A `409` (and `MUTATION_ID_REUSED`, and `REJECTED`)
  marks that row `CONFLICT` and every later row for the same order `BLOCKED`, in one transaction;
  other orders keep syncing. The operator **discards** the halted group or **rebases** it — one at a
  time, a new `mutationId` each, the fresh `baseVersion` taken from the snapshot the previous step
  returned rather than from a refetch. `CREATE_ORDER` rebases at 0. A rebased row keeps its
  `createdAt` so it stays in front of what it is blocking.
- **Client state that outlives a screen has an explicit owner.** `adopt` refuses a snapshot older
  than the one held for that order; `refetch` re-checks that the order it asked about is still
  current; `connection.start`/`stop` claim a generation. This class of bug is what three of the
  four M4 review rounds found. **M7 added a writer to every one of them**: hydration goes through
  `adopt`, fills a pending slot only when it is empty, and claims a **generation** — `useTerminal`
  and `releaseTerminal` — because the terminal id outlives the screen and an id check would let a
  departed view write into its successor. M8 adds the next writer, the sync engine, to the same
  state.
- **`adopt` displays; `send` and `refetch` cache.** Caching is keyed by the terminal that _asked_
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
- **The pointer belongs to the actions that move the screen, and to nothing else.**
  `createOrder`, `focusOrder` and `clearCurrentOrder` write it; `saveOrder` also writes it, and its
  callers are the ones that have established the screen is on that order. The sync engine uses
  **`cacheOrder`**, which writes the snapshot and not the pointer — it drains every order this
  terminal queued, including ones the screen left, and an answer for one of those says nothing
  about which order the device is on. M8's first review round found exactly that: order A answered
  in the background moved the pointer off the order B the operator was ringing up, and the next
  reload came back to the wrong one.
- **`hydrate` ends with a canonical read, and that belongs to the store, not the view.** The
  socket's `onConnected` refetch does not run when `realtime.websocket_push` is off or
  `GET /api/config` fails, so a view-level refresh would leave the cache on screen indefinitely on
  the transport M13 exists to complete.
- **The three §14 tables, and the engine that reads them.** `orders` is a cache and is pruned;
  `pendingMutations` is the durable fact, keyed by `mutationId`, **never regenerated except by a
  rebase**; `syncMetadata` is per terminal and holds the pointer to the order that device is on.
  Still **Dexie schema version 1** — M8 needed no new index. ADR 013, ADR 002.
- **The disk is the queue; the store holds a mirror it re-reads after every write.** Never edited
  in place. The engine writes rows the screen did not ask for, so a second in-memory copy would
  drift; a stale mirror is a display bug, a divergent copy is a lost mutation.
- **The optimistic view is derived on read and never stored** — `projectQueue(canonical, queue)` in
  `apps/web/src/domain/project-queue.ts`. This is what keeps `orders` canonical and what removes the
  worst crash window in the milestone: there is one write per intent, not two. The _rules_ come from
  `decide()` in `@pos/domain`, the same function the API calls; only the item arithmetic is
  restated, because the server's is an atomic SQL upsert. **Do not write a prediction into
  `orders`.**
- **`baseVersion` is stamped from the projected version, not the canonical one.** A `CREATE_ORDER`
  at 0 projects v1, so the `ADD_ITEM` behind it is stamped at 1. That is what makes §19.2 drain
  with nothing re-stamped, and what makes §19.3 conflict on the first mutation. **Do not re-stamp
  at send time** — that is a silent auto-rebase of the whole queue.
- **The send gate is a derivation, not a status lookup**: a group is sendable only when every row in
  it is `PENDING` or `SYNCING` (`isSendable` in `sync/engine.ts`, used by the engine and by the
  store's `halted`). It survives a crash mid-halt and a rebase that stopped part-way; a gate that
  read the head's status would send followers the rebase had already invalidated.
- **`SYNCING` is not durable state.** It means "this tab, right now", so hydration rewrites every
  `SYNCING` row for that terminal back to `PENDING` before the first pass.
- **The engine has no timers.** It runs on an enqueue, on hydration, on the socket connecting, on
  `navigator.onLine`, on the offline toggle flipping, and on **Sync now**. A pass that hits a
  transport error stops and waits. A retry loop would make the offline demo non-deterministic.
- **A §17 error is not automatically a transport failure.** `PERMANENT_API_ERRORS` in
  `sync/engine.ts` is an explicit whitelist — `VALIDATION_FAILED`, `PRODUCT_NOT_FOUND`,
  `ROUTE_NOT_FOUND`, `ORDER_NOT_FOUND` — and those **halt the aggregate** like a conflict does,
  because retrying a request the server will refuse identically is a loop, not a recovery, and it
  starves every order behind it. `INTERNAL_ERROR` and anything unfamiliar stay transport: the row
  goes back to `PENDING`. **Do not invert that default** — the same asymmetry, and the same
  reasoning, as `RECORD_REJECTIONS` in the worker.
- **What the engine coalesces is the terminal, not the fact that something asked.** A trigger
  during a running pass records _which_ terminal it wants and the next iteration uses that one. A
  boolean flag repeated the pass with the terminal it started with, so a route change mid-pass left
  the new screen's queue unsent with no later trigger to save it.
- **`ApiRequestError` lives in `api/errors.ts`, not in `api/client.ts`.** The engine asks
  `instanceof` about it and the store tests replace the whole of `api/client` with a mock; importing
  the class from a mocked module is a failure with nothing to do with what those tests check.
- **`Simulate Offline` is in `apps/web/src/api/client.ts`, per terminal, and blocks reads too.**
  §19.3 depends on POS-1 not learning that POS-2 cancelled the order. **Not in the stores**, which
  would grow a second code path, and not via DevTools.
- **A storage failure can never break a command.** Every repository call resolves with a neutral
  value and records the failure in the exported `persistenceError` ref, shown as `NOT DURABLE`. The
  ref is **not** cleared by a later success: a failed write is never retried, so the fact stays true.
  **`savePending` is the one exception to the neutral value**: it returns whether the row is
  actually there, because since M8 the queue is the only path to the server and a silently dropped
  row would be a silently dropped command. The caller sends it directly through the engine's
  `attemptOnce` instead. A device that cannot store loses offline-first, not the order.
- **Everything crossing into Dexie goes through `plain()`.** IndexedDB clones what it stores and a
  Vue reactive proxy raises `DataCloneError`. One `toRaw` helper in the repository, where the
  provenance of the values is known. `fake-indexeddb` implements cloning for real, so the test
  catches it; a mocked Dexie would not.
- **The kitchen's hydration filter is by restaurant _and_ terminal, the POS's by terminal alone.**
  A POS terminal belongs to one restaurant; every kitchen display shares `kitchen-display` across
  all of them. Dropping the restaurant filter puts another tenant's commands on the rail.
- **A list replaced wholesale is never loaded concurrently.** `createCoalescingLoader` runs one read
  at a time. The rule: an expectation may only be judged by a read _issued after_ it was raised.
- **The publisher claims only an order's earliest unpublished event**, so that order's events reach
  Redpanda in version order regardless of retries or worker count.
- **The lease bounds the send, not just the wait before it.** The budget is measured from _before_
  the claim — the claim's own round trip is spent out of it — a tenth is deliberately never used,
  the pre-send check counts the `publish_delay_ms` about to be incurred, and `sendWithinLease` races
  the publish itself against what is left. Review round 1 found the version that bounded only the
  delay. **Be precise about what this buys**, because the first version of this line was not: a
  record already handed to KafkaJS cannot be recalled and may still land late. What the guard
  prevents is this worker publishing — and writing `published_at` — under a claim another worker now
  holds, and a hung producer holding the whole loop. A late record can only ever be a _duplicate_ of
  an event already on the topic, because a successor is unclaimable until its predecessor is
  published, and `processed_events` absorbs it. `onLeaseOverrun` ends the broker session, which
  closes the socket: the nearest thing to cancellation KafkaJS offers.
- **Three things end a pass early, and all three release the claims they will not use**: the
  transport died, a human paused the publisher, or the lease is nearly up. The release is guarded on
  `claimed_by = :workerId` so a lease that expired and was re-taken by another worker is never
  stolen back, and its failure mode is "the lease expires as before" — which is why it can live
  outside a transaction. `PublishRunResult.stoppedBecause` says which of the three it was.
- **An attempt means "this event failed"; a reclaim means "a worker died".** A stopped batch spends
  no `attempt_count`, and a row taken from an expired claim increments `reclaim_count` instead —
  never `attempt_count`, and never towards a dead letter (ADR 010). The claim query selects its
  candidates in their own CTE for exactly this: `RETURNING` gives back new values, so the previous
  claimant has to be carried through the CTE to be seen at all.
- **`markPublished` is deliberately not guarded on `claimed_by`.** If the lease did expire under a
  worker, the record still reached the topic, and refusing to record that would republish it for
  ever. A concurrent duplicate is the at-least-once guarantee working; a row that can never be
  marked published is not.
- **The §18 publisher switches live in `outbox_controls`**, one singleton row, polled every
  `OUTBOX_POLL_MS`. The process that flips them is not the process that obeys them, and a switch a
  human threw must survive a worker restart — so not an environment variable and not Redis. **A
  failed read keeps the last known value**: reverting to the defaults would un-pause a paused
  publisher exactly when the database is unhealthy. **One read at a time** — the interval is the gap
  between reads, not a metronome, or a slow database gets overlapping reads that can settle out of
  order and overwrite a newer pause with an older snapshot. The watcher takes a _reader function_,
  not a `Db`, which is what makes that testable. `pnpm -F @pos/worker outbox status|pause|resume|
delay <ms>` is the writer until M12, and it **refuses a delay above `maxPublishDelayMs`** — half
  the lease budget — because a larger one is a permanent pause that does not say so.
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
- **`print_jobs` is written by the print processor and by nothing else** (ADR 014). That is what
  gives the sweep an exact question: a `kitchen_tickets` row with no `print_jobs` row means nothing
  has ever tried to print that ticket. Anything M11 adds must read that table, never write it — the
  one exception is `resetDeadLetteredJob`, which is a human's decision and lives behind the CLI.
- **BullMQ owns the print schedule; the row owns the verdict.** `attempt_count` and BullMQ's
  `attemptsMade` are allowed to differ, and only the first one dead-letters anything.
- **The print queue's `jobId` is the ticket hash, and terminal jobs are never retained.** A retained
  completed or failed job under that id would silently swallow every later `add` for the ticket,
  including the sweep's repair and a human's retry.
- **Redis is still soft** and readiness still checks PostgreSQL only, print queue or not (ADR 014) —
  and that claim rests on **three** guards in `createPrintQueue`, each covering what the others
  cannot. The client's status is checked _before_ anything is handed to BullMQ, so an outage starts
  no work and retains no tickets; `commandTimeout` on the producer connection bounds an `add` that
  was started; and a timeout race covers the seam where the client is ready when checked and drops
  before BullMQ reads it. None of them ends the connection, so the queue recovers on its own.
  **A timeout is a statement about the caller, not about the callee** — that is the round 2 lesson
  and it applies to anything else that walks away from work in this repository.
- **That refusal is for long-lived callers only.** A process that connects at boot can refuse an
  enqueue while the client is not ready, because by the time work arrives it will be. A short-lived
  one — the `printer` CLI — connects and enqueues microseconds apart, so it calls
  `waitUntilReady()` first, and **before** it writes anything: round 3 found `printer retry`
  resetting a dead letter to `PENDING` and then failing to queue it against a healthy Redis.
- **BullMQ's worker duplicates the Redis client it is given**, for its blocking commands, and that
  duplicate is `private`. Shutdown depends on `Worker.close()` ending it — which it does, by
  disconnecting it locally before any `QUIT` — and `Worker.close` memoises its promise, so a
  graceful close can never be escalated to a forced one afterwards. Round 3 proposed forcing it;
  the investigation is in `build-log.md` and the answer was no.
- **Nothing in the print pipeline's shutdown may be unbounded.** `close()` and `quit()` against an
  unreachable Redis wait rather than fail, so `stopPrinting()` bounds every step by
  `PRINT_SHUTDOWN_TIMEOUT_MS` and then calls `disconnect()` — local and synchronous — on both
  clients regardless. Without that, `closeDb()` and the process exit are unreachable.
- **The `PRINTER_URL` default is right for `pnpm dev` and wrong in a container.** The Compose `app`
  profile sets it to `http://api:3000/api/printer/print`; inside that container `localhost` is the
  worker. M14's production images need the same care.
- **The worker pins `ioredis@5`** to match the copy BullMQ bundles; the API stays on `ioredis@6` for
  the Socket.IO adapter. Mixing them is a type error, not a runtime one, and the error names a
  protected field on `AbstractConnector` rather than the version skew.

## Decisions already made

- Fastify over NestJS, Drizzle over Prisma.
- Full scope, nothing cut. **Twenty milestones total (M0–M19), ten still to run** — M10 through
  M19. Earlier copies of this line undercounted.
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

## Review-round summaries (superseded by `build-log.md`)

### M10's three review rounds, in one place

Every one of them was about a **wait nobody was watching**, and each was opened by the previous
one's fix — the seventh milestone in a row where that has been true.

| Round | Finding                                                                                                                                                                | Where the rule was attached wrongly                                                                                                                                     |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `maxRetriesPerRequest: null` on the queue's _producer_ connection meant an `add` that never settles, inside `eachMessage` — a soft dependency able to stop the kitchen | one helper built both connections, so BullMQ's requirement for the connection its **worker blocks on** landed on the one a **consumer awaits**                          |
| 1     | the Compose `app` profile pointed `PRINTER_URL` at `localhost`, which inside that container is the worker                                                              | a default that is right for `pnpm dev` and wrong everywhere else, and no test starts that profile                                                                       |
| 2     | the abandoned `add` still held the ticket: BullMQ waits inside `waitUntilReady`, one retained job per event for the length of the outage                               | **a timeout is a statement about the caller, never about the callee**                                                                                                   |
| 2     | shutdown could hang for ever — `close()` and `quit()` against an unreachable Redis wait rather than fail, so `closeDb()` and the exit were unreachable                 | round 1's own test already worked around it with `disconnect()` before `close()`, and that knowledge never travelled twenty lines                                       |
| 3     | `printer retry` was refused against a healthy Redis, _after_ resetting the dead letter to `PENDING`                                                                    | round 2's readiness guard was justified by "the worker connects at boot" — true of one caller, and the CLI is the other                                                 |
| 3     | _(rejected)_ force-close the print worker so BullMQ's duplicated connection cannot hang the shutdown                                                                   | implemented, then reverted: two tests could not tell the fixed version from the unfixed one, because `Worker.close()` disconnects that socket locally before any `QUIT` |

The honest line for the interview is not that the print job was right, but that **its one invariant —
"Redis is soft, and nothing about printing may stop an order or a kitchen ticket" — was stated
correctly in an ADR and attached to the wrong mechanism three times**, and that the fourth round
returned nothing. The rejected finding is worth telling too: a fix whose test cannot distinguish it
from its absence is a fix for something that is not happening, and removing it took out more risk
than it left behind.

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
- **M7's review found three, and all three were about _when_ a write happens rather than whether
  it does.** The pending row was deleted before the answer that settles it was cached; hydration
  left the refresh to a view that only performs it on one of two transports; and the owner check
  used the terminal id, which outlives the screen. The brief had listed the owners in a table
  before any code and still missed all three — because the table asked "who may write this?" and
  every finding answered "the right writer, at the wrong moment". **Add the second question to the
  next milestone's brief: for each pair of writes, which order survives a crash between them?**
  That is the M8 question exactly: the sync engine is the _third_ writer of this state, and it is
  the first that runs without a screen asking it to.
- **Round 2 found one, and it was opened by round 1's fix — the fifth milestone running.** Pulling
  the persist out of `adopt` moved the write and left the rule behind: `acceptsSnapshot` still
  guards memory and no longer guards the disk. Splitting a function into two responsibilities means
  asking which of its invariants belonged to which half, and I moved the code without asking.
- **M10's lesson came from the pair question a third time, and it moved a write rather than fixing
  one.** The obvious place to insert the `print_jobs` row is where the job is enqueued; putting it
  in the _processor_ instead is what makes "a ticket with no row" mean "nothing has ever tried to
  print this". The same table, the same column, one step later in the sequence, and the difference
  is that the reconciler stops having to guess. **When a repair mechanism needs a timeout to tell
  two states apart, suspect the write that created the ambiguity, not the repair.**
- **M10's review round is the M6 lesson again, one library down.** `maxRetriesPerRequest: null` is
  BullMQ's requirement for the connection its worker _blocks_ on; I set it on both connections
  because one helper built both, and on the producer it means "wait for ever" — inside a Kafka
  consumer's `eachMessage`. The rule ("Redis is soft") was stated correctly in an ADR written the
  same day and attached to the wrong object, which is now the sixth time. **Two connections that
  differ only in options are two things, and a helper that builds both hides which is which.** The
  second half is newer: bounding it needed _two_ guards, because a connection that broke and a
  connection that was never ready fail at different layers — and the obvious single fix covers only
  the first.
- **M10: 2 → 2 → 2 → 0, the second cycle in this repository to converge to a clean report.** The
  table under **Current state** has all six findings; the shared shape is that every one was a wait
  nobody was watching, in a milestone whose ADR is about a dependency being soft.
- **Round 3 broke the streak in a useful way: one finding was real and one was not.** The real one
  was round 2's own fix applied to a caller it was not written for. The other — force-close BullMQ's
  worker so its duplicated connection cannot hang the shutdown — was implemented, then tested, and
  **neither of two tests could tell the fixed version from the unfixed one**, because BullMQ already
  disconnects that socket locally before trying to `QUIT` it. It was reverted along with the
  in-flight counter and the `unhandledRejection` guard it had needed. **A fix whose test cannot
  distinguish it from its absence is a fix for something that is not happening** — and reverting it
  removed more risk than it added, because the forced close abandoned an in-flight print on every
  restart.
- **Round 2 was opened by round 1's fix, as every round has been since M4.** The timeout freed the
  caller and left BullMQ holding a ticket per event for the length of the outage: **a timeout is a
  statement about the caller, never about the callee.** Its second finding is worse to have written
  than to read — round 1's own test called `redis.disconnect()` before `queue.close()`, with a
  comment saying it would otherwise hang, and that knowledge never travelled the twenty lines into
  the shutdown path. **A test that works around a behaviour is reporting a bug.**
