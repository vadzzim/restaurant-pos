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
