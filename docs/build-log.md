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

## M4 review round 2 — three more races, and one comment that was simply false

**Concurrent kitchen loads could take a visible ticket back off the screen.** The list is replaced
wholesale, so two overlapping `load` calls both wrote it — and the answer to the _first_ event,
delayed by its own wait for a lagging projection, could land after the answer to the second. With
repeats dropped by `eventId`, nothing would arrive to correct it. Reads are now coalesced through
`createCoalescingLoader`: one read in flight, expectations queued, `apply` called from one place.

Serialising alone would not have been enough, and getting that right needed a sharper rule than
the one the first fix implied: **an expectation may only be judged by a read issued after it was
raised.** A read already in flight was sent before the event existed, so it proves nothing about
it even when it happens to contain the effect. Hence a round that finds work queued runs again
instead of trusting its own response. The first version of the test asserted the opposite — that a
single read containing both was enough — and hung; the test was wrong, not the code, and the
corrected version now states the rule explicitly.

**Any new command destroyed the one identity that could resolve the previous one.** `pending`
survived a transport failure, but nothing stopped the next `ADD_ITEM` from overwriting it, and
`clear()` — "New order" — dropped it silently. Either way the first mutation's outcome became
permanently unknowable: no retry could ever produce `ALREADY_APPLIED` for a `mutationId` nobody
holds any more. With one slot, one unresolved mutation halts the terminal: `send` refuses a
differing identity, every command is disabled, `clear()` keeps the slot, and the banner offers
Retry or an explicit Discard that says the outcome will stay unknown. It is §14.1's shape — the
queue for this aggregate stops until a human decides — which is why M8 generalises it rather than
replacing it. `MutationIdentity` grew `terminalId` and `restaurantId` so a retry is self-contained
and is re-sent as the terminal that sent it.

**A slow refetch could reinstall an order the screen had left.** `acceptsSnapshot` lets a
_different_ order id through, because that is exactly what a freshly created order looks like
arriving in a mutation response. Correct there, wrong for a refetch: a `GET` of order A completing
after a `clear()` or after order B was created passed the check and overwrote B. `adopt` cannot
tell the two callers apart, so `refetch` now checks for itself that the order it asked about is
still on screen.

**`connectConsumer` leaked a connected consumer when `subscribe` or `run` threw.** The handle is
only returned on full success, so a failure after `connect` left an open connection the supervisor
could not see, and every retry opened another. Cleanup moved inside, next to the thing it owns.

**A cancelled `start` could still relabel the transport.** The generation check came _after_
`resolveTransport` had already written `PUSH` / `PUSH DISABLED` / `UNKNOWN`. `resolveTransport` is
now side-effect free and returns the value; `start` writes it only once it knows its claim still
stands.

**The poison-message comment claimed something untrue.** It said `processed_events` was left
unwritten "so a later build can reprocess it". Returning from `eachMessage` counts as success, so
KafkaJS commits the offset and this consumer group is never offered that message again — no later
build will see it. The behaviour is right (throwing would stall the partition forever behind one
bad message and freeze every screen in the restaurant), the description was not. It is now stated
as a terminal skip, logged at `error` with the raw payload so it is recoverable by hand from the
topic while retention lasts, and a consumer-side dead-letter topic is named as the real answer and
as out of scope. A test asserts the level, because a lost broadcast reported at `warn` is a lost
broadcast nobody finds.

Twelve regression tests were added. Three of them were run against the pre-fix sources and fail
there; the coalescing-loader tests are structural and the consumer-cleanup path needs a broker, so
neither of those was demonstrated that way.

## M4 review round 3 — the two holes the round-2 fixes opened

An independent Codex pass over `091406f` found both, and both were created by that commit rather
than surviving it.

**A retried mutation could paint another restaurant's order onto the screen.** Round 2 made
`MutationIdentity` self-contained so a retry is re-sent as the terminal that sent it, and made
`clear()` keep the pending slot. Together, in a store that is a singleton while the terminal is a
route parameter, that let one browser tab walk from `/pos/pos-1` to `/pos/pos-3` — a different
tenant — press Retry, and adopt POS-1's order onto POS-3's screen. Every command POS-3 sent after
that would come back `CROSS_TENANT_MUTATION`: the server right, the screen lying. The pending slot
is now a map keyed by terminal, which is what it always should have been — an unresolved mutation
belongs to the device that sent it. `send` refuses an identity whose terminal is not the active
one, and re-checks after the await, because the route can change mid-request. The response still
resolves the mutation; it just is not painted onto a terminal that did not ask.

**A failed read stranded the expectations queued behind it.** `drain` had no `catch`, so a rejected
read threw straight out of the `do/while`; `finally` cleared `running` and nothing restarted the
loop, leaving whatever had queued during that read unserved forever — and the gate had already
recorded those events, so no redelivery would come to correct it. Round 1 asked for expectations
not to be lost and round 2 delivered that only on the happy path.

The fix went one level down rather than only wrapping the call. `refetchUntil` now spends a failed
read from the same budget as an unsatisfied one: while waiting for a projection, a single blip and
a slow consumer are indistinguishable and both are answered by trying again. Only if _no_ read
succeeded does it throw, because there is no value to hand back. `drain` catches that, reports it
through a new `onError`, gives up on its own batch — the same concession the budget already makes
when a projection never catches up — and carries on with what is waiting. The kitchen screen shows
`READ FAILED` with the last good read still on it, rather than looking merely quiet.

`refetch` also grew a `catch`: a socket event calls it without awaiting, so a rejection surfaced as
an unhandled promise rejection and nowhere else.

Five regression tests were added. Three were run against the pre-fix sources and fail there.

## M4 review round 4 — a read failure with no owner

A second Codex pass over `56d8c94` found one P2, again in what the previous round had just added.

**A failed refetch was reported on whatever screen happened to be showing.** Round 3 gave `refetch`
a `catch` so a socket-triggered read could not surface as an unhandled rejection — but wrote the
message without the staleness guard its own success path had two lines below. A read of order A
failing after the operator moved to order B put A's error under B. It also never cleared: a later
successful read left the message standing, so a transient blip looked permanent.

The message now goes to its own `readError`, set only while the order it concerns is still on
screen and cleared by the next successful read of that order. Splitting it from `lastError` is the
real fix rather than a second guard: a refresh that could not be made and a mutation that was
refused are different facts with different lifetimes, and sharing one field is what let one outlive
its cause. `clear()` resets both.

Three regression tests; two fail against the pre-fix sources.

The pattern across four rounds is worth naming: every round's findings were opened by the previous
round's fix, and three of the four were the same mistake — state that outlives the screen that
created it, without an explicit owner. Round 3 gave the pending mutation an owner (its terminal).
This one gives the read failure one (its order).

## M5 — the remaining six commands and the whole of §8

Nothing broke in a way that needed a fix; what this milestone produced instead is a set of rulings
where the spec left two readings open. They are recorded here because each one is a question an
interviewer can reasonably ask, and "it seemed right at the time" is not an answer.

**§8's last bullet had to be rationed.** "A stale operation already reflected in server state:
treat as idempotent where semantically safe" would, applied enthusiastically, swallow the matrix —
almost every conflict can be argued into being already satisfied. It was granted to exactly two
cases: removing a line that is not there, and cancelling a cancelled order. Both have the property
that the operator's intent is met by the state as it stands. The tempting third, `CHANGE_QUANTITY`
to the quantity already stored, was refused: §8 says concurrent quantity changes conflict and the
server is canonical, the version guard is what decides that race, and a value comparison in front
of it would be a second mechanism answering the same question. Note also that §8's `CANCELLED`
reject list names seven mutation types and `CANCEL` is not one of them — the idempotent reading of
a double cancel is the spec's, not an invention.

**A repeated kitchen transition conflicts.** `MARK_READY` on an order that is already `READY`
returns `INVALID_STATUS_TRANSITION` rather than `ALREADY_APPLIED`. "Out-of-order transitions
conflict" is the rule, and a repeat is out of order. A genuine retry of the _same_ mutation never
reaches the question: §9 answers it from `processed_mutations` first. This matters for the demo —
two displays pressing Ready producing one success and one refusal is the headline of §21.10.

**`PAY` carries no amount.** The payload is `{ method }` and `payments.amount_cents` is the order's
own `total_cents`, read inside the mutation's transaction. A client-supplied amount would be a
second source of truth for money and would need a mismatch rule; the version guard already refuses
a payment built on a total that has moved, and does it earlier.

**Which statuses accept `PAY` was already decided in M3** and was left alone: `ALLOWED_TRANSITIONS`
permits `OPEN → PAID` and `READY → PAID`. Paying while the kitchen is cooking is
`INVALID_STATUS_TRANSITION`. That is a real restaurant taking a real position — bar tab at the
counter, table when the food is up — and M5 had no reason to reopen a table M3 wrote in full.

**`CHANGE_QUANTITY` naming a line the order does not have is a conflict, not a 400.** Another
terminal may have removed it a second ago. `ITEM_NOT_IN_ORDER` joined `ConflictReason`; a `400`
would tell the operator their request was malformed when in fact the world moved.

**`guardedVersionBump` lost its optional status parameter.** M3 had two SQL statements, one with a
status and one without. `decide()` already returns the status the order should end in — the current
one, for an item mutation — so writing it unconditionally collapses eight cases into one statement.

**`SUPPORTED_MUTATION_TYPES` was deleted.** It existed to let the type system say that M3
implemented three of the nine. After M5 it is `MutationType` with extra steps, and a second name
for the same set invites a reader to hunt for the difference.

### Two things that needed a decision the spec does not contain

**The kitchen has no order version to command with.** It renders `kitchen_tickets`, whose only
version is `source_event_version`. That is a real `baseVersion` — every event reaching the kitchen
room carries the order version it was written at, and items are frozen after `SENT_TO_KITCHEN` — but
it can lag, and then the command conflicts. Accepted as the designed outcome rather than engineered
away; `docs/adr/012-kitchen-command-base-version.md` records the reasoning and the two rejected
alternatives.

**The projection needed a third result.** `advanceTicket` can find no ticket at all, because
`CANCEL` is valid on an `OPEN` order the kitchen never saw. That is `recorded`, not `stale`: "the
projection is behind" and "there was never a ticket" are debugged differently, so the update is
followed by an existence check rather than collapsing both into one return value.

### Verification

`pnpm typecheck`, `pnpm lint` and `pnpm build` green. 155 tests pass against a real PostgreSQL:
61 domain (including the §8 matrix — six statuses × eight non-creating mutation types, written out
by hand rather than generated, so a rule that changes has to be changed twice), 37 api, 16 worker,
41 web. §21.4, §21.9 and §21.10 are present and named by their spec number, alongside a lifecycle
test that walks one order through all nine mutation types and asserts nine outbox rows at versions
1…9.

## M5 review — the one answer that asserts state without writing it

A Codex pass over `f6888e6` found three, one of them real enough to be worth the whole round.

**P1 — `ALREADY_APPLIED` acknowledged state it had not locked.** A `REMOVE_ITEM` for a line the
order does not have decides `already-applied`, throws, and **rolls its transaction back**; the
acknowledgement was then written by a separate, unguarded read-and-insert. An `ADD_ITEM` for that
very product can commit in the gap. The caller was told their removal was reflected, and handed a
canonical order that visibly still contained the line.

Every other answer in this system is safe because it is a write: the versioned UPDATE of §6 is
what decides who wins, and a stale mutation simply fails to match. This one path writes nothing to
guard — it only asserts — which is exactly why it slipped through the model that protects
everything else. The fix locks the order row (`select … for update`) and takes the decision again
under that lock, inside one transaction with the `processed_mutations` insert. It is the only
pessimistic lock in the write path and it is narrow: one row written, nothing external called.

The revalidation also improves the answer when it fails. `apply` on re-decide means the operation
is meaningful again at a version this client no longer holds → `ORDER_VERSION_CONFLICT`; a domain
`conflict` on re-decide is reported by its own reason, so an order cancelled in the gap says
`ORDER_CANCELLED` rather than a generic version complaint.

Worth noting which cases were _not_ exposed. `CREATE_ORDER` already-applied is stable because no
mutation changes `table_number`; `CANCEL` on a `CANCELLED` order is stable because `CANCELLED` is
terminal. Only `REMOVE_ITEM` sits on a non-terminal status whose decision a concurrent write can
invalidate — which is to say the bug arrived with M5.

**Both regression tests are deterministic, not hopeful.** A held transaction owns the order row
while the removal runs, and the test polls `pg_stat_activity` until the removal is genuinely
waiting on that lock before releasing it. If the acknowledgement is unguarded nothing ever blocks
and the test fails with `nothing ever blocked on the order row`. Verified against the pre-fix
sources: both fail, with that message. The `finally` around the release is not decoration — the
first draft left the holding transaction waiting on a gate nobody opened and hung the suite instead
of reporting the failure.

**P2 — the kitchen expected a ticket that was never going to exist.** M5 added `OrderCancelled` to
the kitchen room and, in the same commit, a comment on `KITCHEN_EVENT_TYPES` explaining that an
event which moves no ticket must not reach the kitchen — with `OrderPaid` given as the example. But
`CANCEL` is valid on an `OPEN` order, the projection then records the event without building
anything, and `KitchenView` still raised an expectation for that order. `ticketsSatisfy` can never
be met, so every such cancellation spent the whole retry budget and raised `PROJECTION LAG` over a
fault that did not exist.

The rule now lives in `expectationFor`, next to the projection knowledge it depends on: only
`OrderSentToKitchen` can create a ticket, so anything else earns a wait only if this screen already
holds a ticket for that order. Cancelling an order that _is_ on the rail still waits, as it must.

**P3 — one slow command froze the whole rail.** `KitchenView` had a single `busy` flag disabling
every command, retry and discard on every card while any one request was in flight. The store
deliberately tracks unresolved commands per order, and the view threw that away at the last step. A
`Set` of busy order ids replaces it. Not unit-tested — there are no component tests in this project
— but the store-level rule it mirrors is.
