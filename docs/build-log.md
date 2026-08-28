# Build log

Significant issues only: what broke, the root cause, and the fix. One short paragraph each.
Trivial typos are not recorded.

## M0 — scaffolding

Nothing broke. No code yet.

## M1 — monorepo and infrastructure

The registry's current TypeScript 7 release exceeded `typescript-eslint`'s supported peer range,
so the workspace was pinned to the current TypeScript 6 release. TypeScript 6 also deprecated
`baseUrl`; path aliases now use explicit relative targets and need no compatibility suppression.

Review caught that the optional Compose app profile relied on locally prebuilt shared packages,
used a localhost API proxy inside the web container, required an ignored `.env`, and could not
report Console as healthy. The profile now installs with a container-safe layout, builds shared
packages, uses a service-aware proxy, treats `.env` as optional, and checks Console's `/health`.

Redpanda started successfully but stayed unhealthy because `rpk cluster health` in the pinned
image no longer accepts `--brokers`. The healthcheck now uses the supported
`--exit-when-healthy` flag; a direct `rpk cluster info` confirmed the broker itself was running.

## M2 — schema, migrations, seed

Nothing broke at the database level: the generated migration applied to the clean database on the
first attempt, and the seed was idempotent from the start.

Two small friction points. Drizzle's `db.execute<T>` constrains `T` to `Record<string, unknown>`,
so the row shapes in `db:check` are intersection types rather than plain interfaces — an interface
has no index signature and is rejected. And Prettier tried to reformat the generated
`drizzle/meta/*.json` snapshots, which would put the repository permanently at odds with
`drizzle-kit generate`; `apps/api/drizzle/` is now in `.prettierignore`.

## M3 — vertical slice, backend

**The path aliases from M1 had to go.** `tsconfig.base.json` mapped `@pos/*` to package _sources_.
As soon as one package imported another (`@pos/domain` needs `@pos/contracts`), `tsc` pulled the
dependency's source into the dependent's program and failed on `rootDir`, after quietly emitting
`index.js` and `index.d.ts` next to `packages/contracts/src/index.ts`. Resolution now goes through
each package's `exports` field to `dist`, which is what the workspace already built before every
command. Test suites alias the sources explicitly in their own Vitest config, so a stale `dist`
cannot hide a broken change while developing.

**`Db` could not be inferred.** `type Db = ReturnType<typeof createDb>['db']` is circular once
`createDb` returns an object typed with `Db`. It is now `NodePgDatabase<typeof schema>`, stated
outright.

**Raw rows carry text timestamps.** Drizzle installs its own `pg` type parsers, so `created_at`
from `tx.execute` is a string, not a `Date`. The publisher wraps it in `new Date(...)`; the typed
query builder is unaffected.

**Root `pnpm test` raced against itself.** The api and worker suites share one `pos_test` database
and truncate the same tables, and pnpm runs workspace scripts in parallel by default. The root
script now passes `--workspace-concurrency=1`.

**A concurrent retry answered CONFLICT.** Two copies of the _same_ mutation in flight: the loser's
versioned UPDATE matched zero rows, so it returned `409 CONFLICT` even though its own effect had
just been applied by the winner. A client would have halted its queue over its own retry (§14.1).
The conflict path now looks the `mutationId` up after the rollback and answers `ALREADY_APPLIED`
when the winner's row is there. Caught by a test written for exactly that race.

## M3 review — three races the tests did not cover

**`isUniqueViolation` never matched anything.** Drizzle wraps driver failures in a
`DrizzleQueryError` whose `cause` holds the pg `DatabaseError`, so the `23505` check read `code`
off the wrapper and always saw `undefined`. The whole "a concurrent duplicate committed first"
branch was dead and the API would have answered `500`. The check now walks the `cause` chain.

Worse than the wrapper: that branch returned the winner's stored result unconditionally. Two
concurrent mutations sharing a `mutationId` but carrying **different** payloads would have handed
the loser a result for an operation it never requested — the exact silent drop §9 forbids. Both
race paths (primary key, and losing the versioned UPDATE) now compare `request_hash` and answer
`MUTATION_ID_REUSED` on a mismatch.

**Concurrent `CREATE_ORDER` walked around the tenant guard.** The guard runs at the top of the
transaction, where a not-yet-created order looks like no order at all. Two restaurants creating the
same client-generated `orderId` therefore both passed it; the loser then compared only
`tableNumber` and, on a match, returned `ALREADY_APPLIED` **with the other tenant's order**. The
insert-conflict path now re-checks `restaurant_id` before it compares content.

**The outbox could publish an order's events out of version order.** A failed publish sent one
event back for a retry while the loop kept publishing later events of the same order;
`UPDATE ... RETURNING` does not preserve the subquery's order; and two workers could claim adjacent
versions into separate batches. The Kafka key preserves only the order in which messages are
actually sent, so a consumer could legitimately see v2 before v1. The claim now takes **only the
earliest unpublished event per aggregate** — a successor becomes claimable when its predecessor is
published — and the batch is ordered explicitly through a CTE. A dead-lettered event stops blocking
its successors on purpose, so one poison event cannot freeze an order forever.

That claim rule costs throughput per order, so a pass that published something no longer waits a
poll interval before the next one; otherwise a three-event order would take seconds to reach the
kitchen.

Five regression tests were added, and all five fail against the pre-fix sources.

## M4 — vertical slice, frontend

**Fastify's logger is not `pino.Logger`.** The realtime modules were written against
`import type { Logger } from 'pino'` and handed `app.log`, which is a `FastifyBaseLogger`. The two
are pino-compatible at runtime but not assignable at the type level. Both modules now take
`FastifyBaseLogger`, which is also the honest signature: these things log through the API's logger,
they do not own one.

**`socket.io` had to be kept out of `buildApp()`.** Attaching it there would have made every
`fastify.inject` test open a Redis connection and a Kafka client. `buildApp()` stayed routes-only
and the socket server plus the consumer moved into `index.ts`; the 23 API tests still run with no
broker and no Redis, which is what keeps them fast enough to run narrowly.

**TypeScript would not narrow the mutation response through `||`.** `if (status === 'APPLIED' ||
status === 'ALREADY_APPLIED')` narrows the true branch but leaves `MutationAppliedResponse` in the
false branch, because its discriminant is itself a union of the two literals. A `switch` with both
cases falling through narrows correctly. Worth remembering: the four §5 responses will be matched
on in several more places before M8.

**An endpoint the spec's §17 list does not have.** The kitchen screen reads `kitchen_tickets`
(§12.1, §16) and no listed endpoint returns that projection —
`GET /api/restaurants/:restaurantId/orders` reads the `orders` aggregate. Added
`GET /api/kitchen/tickets?restaurantId=…`, under the `/api/kitchen` prefix §17 already establishes
for the two command endpoints. The alternative was to have the kitchen read `orders`, which would
have made the consumer's idempotency invisible on the one screen it exists to serve.

**`TERMINALS` moved from `@pos/db` to `@pos/contracts`.** The POS resolves its restaurant from the
terminal id in the URL, and there is no endpoint that maps one to the other. Rather than add one or
duplicate the list in the browser, the list became shared vocabulary and the seed imports it.

**`vue/html-self-closing` disagrees with Prettier** on `<input />`. Turned off, alongside the two
template rules that were already off for the same reason.

**Vite had to proxy the WebSocket upgrade.** Socket.IO shares the API's HTTP server, so
`'/socket.io': { target, ws: true }` sits next to the `/api` proxy; without it the client falls
back to polling against the Vite dev server and never connects.

## M4 review — four correctness holes between consumers and inside the client

**A broadcast can outrun the projection it tells you to read.** The realtime consumer and the
kitchen consumer read the same topic on independent groups, so nothing orders them. When realtime
won, the kitchen screen did its one refresh against a `kitchen_tickets` table that had not been
written yet — and because the gate had already recorded that `eventId`, a redelivery would have
been dropped and there is no periodic refresh in M4. The ticket stayed invisible until a reload.
The refresh callback now receives the event, and the kitchen store reads until the projection
reports `source_event_version >= event.version`, on a bounded backoff, surfacing `PROJECTION LAG`
when the budget runs out rather than spinning. The POS deliberately does _not_ do this: it reads
`orders`, written by the same transaction that wrote the outbox row, so one read always suffices.

The same finding exposed a second cost: the kitchen was joining `restaurant:{id}` as well as
`kitchen:{id}`, so every `OrderItemAdded` woke a refetch that could never converge. The kitchen now
joins only its own room, and `roomsFor` routes through a named `KITCHEN_EVENT_TYPES` set that M5
extends when `OrderPreparing` and `OrderReady` arrive.

**`GET /api/orders/:id` was not a consistent read.** `loadOrderSnapshot` issues two SELECTs. The
mutation handler calls it inside the transaction that wrote both tables, so it is consistent there
— but the new read route called it bare, and under PostgreSQL's default READ COMMITTED every
statement takes a fresh snapshot. A mutation committing between the two returned the old header
with the new items: a `totalCents` matching neither version, shown to the operator as fact. The
route now reads in a `repeatable read`, `read only` transaction. A wrapping transaction alone would
not have fixed it — the isolation level is the fix.

**The realtime consumer never recovered from a crash.** The start loop exited on first success and
nothing watched the consumer afterwards. A malformed message would throw out of `eachMessage`,
KafkaJS would exhaust its retries and stop the consumer, and the API would go on serving reads and
writes with every screen silently frozen until someone restarted the process — the half-dead state
this architecture exists to avoid. Two fixes: `parseDomainEvent` validates the envelope with zod
and _skips_ what it cannot understand (logged, and deliberately not recorded in `processed_events`,
so a later build can reprocess it), and `superviseRealtimeConsumer` listens for
`consumer.events.CRASH` and rebuilds the consumer when KafkaJS reports `restart: false`.

**A retried creation could produce a second order.** The client minted a fresh `orderId` _and_ a
fresh `mutationId` on every attempt, so a lost response followed by a second press created a second
order — the one write neither the version check nor `mutationId` can catch after the fact, and
exactly the hole that the decision to drop `POST /api/orders` was supposed to close. The client now
keeps the identity of a mutation whose answer never arrived and reuses it, so the retry resolves as
`ALREADY_APPLIED` under §9. It applies to every type, not just creation: retrying `ADD_ITEM` with a
new `mutationId` would report a conflict over an operation that had in fact succeeded — safe, and a
lie to the operator. The pending mutation is shown as `PENDING` with a Retry button; M8 replaces
the single slot with the durable queue, same reasoning, different storage.

**An older refetch could roll the screen back.** Socket events fire refetches without waiting for
each other, so two `GET /api/orders/:id` calls can overlap and the older answer can land last.
`adopt` now refuses a snapshot older than the one held for the same order — exact, because the
version is monotonic per aggregate. The gate checks the _event_'s version; nothing was checking the
_response_'s.

**A slow `start` leaked past `stop`.** `start` awaits `GET /api/config` before opening a socket,
and in that gap the component can unmount or the terminal in the URL can change. The late `start`
then installed a socket nobody would close, and two overlapping `start`s overwrote each other's
handle, leaving the first socket open forever. Both now claim a generation; a `start` whose claim
has been superseded closes what it built instead of installing it.

Ten regression tests were added: envelope validation and poison-message handling, the bounded
projection wait and its backoff, the monotonic snapshot rule, mutation-identity matching, and a
snapshot invariant asserted while writes run concurrently. That last one checks that the total
always agrees with the items returned alongside it; it does not force the interleaving, so it can
only ever fail truthfully.
