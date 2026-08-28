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

## M5 review round 2 — the fix that over-generalised

A second Codex pass, over `b15e56a`, found one P1: the previous round's own fix.

`expectationFor` was written as "wait only for an event that creates a ticket, or for one whose
ticket this screen already holds". The second clause is wrong. `OrderPreparing` and `OrderReady`
**necessarily** concern a ticket that exists — `START_PREPARING` requires `SENT_TO_KITCHEN` and
`MARK_READY` requires `PREPARING` — so an empty local list does not mean "there is no ticket", it
means _the projection has not been read yet_, which is the one situation the wait was built for.
Skipping it there skips it exactly when it is needed: the coalesced read can land before the
transition reaches the projection, the event gate has already spent that event's only hint, and the
rail sits in the previous column until another event or a reload.

The condition is inverted: skip only for `OrderCancelled` with no ticket on screen, which is the
one case that is genuinely unsatisfiable, because `CANCEL` is valid on an `OPEN` order. That also
removes the `OrderSentToKitchen` special case, which the new rule covers.

The test I wrote for the old behaviour passed only because it handed the function a `held` list
containing the ticket. The case with an _empty_ list — the whole point of the wait — was never
written down. It is now, for both transitions, and it fails against the previous rule.

**One named residue, recorded rather than fixed:** a cancellation of an order that _was_ sent to
the kitchen, but whose ticket this screen has not seen yet, still gets no wait. The client cannot
distinguish it from the `OPEN`-order case; only the event could say, and putting "did this order
ever reach the kitchen" into `OrderCancelled` would push a display concern into a domain payload
for a case that the next event or a reload already resolves.

Two rounds, two shapes worth keeping: M5's own fix widened a rule past what justified it, and the
justification was sitting in the comment above it. Both this round and the last found the same
thing — a rule stated correctly in prose and then implemented one notch too broadly.

## M6 — the operational half: errors, correlation, health, and one reproducible command

M6 added no feature. Almost everything in it existed in outline and the milestone was about
finishing each outline honestly. Four things were worth writing down.

**Two error paths were producing the wrong answer, and neither had a test.** The single error
handler only recognised `ApiError`, so a body that was not JSON — which Fastify rejects before any
route code runs, with its own `statusCode: 400` — fell through to the unhandled branch and answered
**500 `INTERNAL_ERROR`**. Telling a client that its own malformed request was a server fault is not
a cosmetic bug in a system with an offline queue: §14 branches on exactly that distinction, and a
500 means _retry forever_. Unknown routes had the matching problem, answering Fastify's default
`{message, error, statusCode}` rather than the §17 envelope. Both are handler-level fixes —
`asClientError` honours a 4xx that arrives with one, and `setNotFoundHandler` covers the other — so
there is now no way out of the API that is not a §5 outcome, a §17 envelope or a health report.

`ApiError.code` is `ApiErrorCode` now rather than `string`. Writing the union down forced the
question the §17 example invites: should `ORDER_VERSION_CONFLICT` travel in the error envelope? No.
A conflict is a _successful_ application of the rules and carries a snapshot, a reason and two
version numbers — all of which the envelope would erase, and all three of which §14.1 branches on.
`packages/contracts` had already said so in a comment; the union is that comment made mechanical.

**`traceId` and `requestId` are two fields, and the second one is a fallback for the first.**
`requestId` identifies the HTTP call; `traceId` identifies the work, and the work outlives the call
— it becomes an outbox row, a Kafka message, a projection write and a broadcast, and both consumers
were already logging `traceId` from the event. What was missing was the front end of that chain:
`executeMutation` was passing Fastify's request id as the trace id, so a client could not supply
one. It now reads `x-trace-id`, falls back to the request id when nothing upstream is tracing —
inventing a second uuid there would add a field that correlates with nothing — and both are bound
onto the request's child logger, so Fastify's own lines carry them too. The end-to-end assertion is
in `apps/api/test/errors.test.ts`: a header on the request appears in `outbox_events.trace_id`.

**The health split's only interesting decision is what readiness does _not_ check**, and it is in
ADR 011. The part that took the most thought is the third state: `degraded`. A report that can only
say healthy or broken flattens the exact distinction the architecture is built on, so
`/api/debug/dependencies` grades each dependency `hard` or `soft`, names what its absence costs, and
carries the outbox backlog next to it. Stopping Redpanda now produces a demonstration rather than a
claim: readiness green, mutations `APPLIED`, status `degraded`, backlog counting up.

**The open question about the worker had a sharper answer than "make it match the API".** The worker
exited when Redpanda was down at startup while the API retried. The obvious fix — let it run and let
the publisher fail — is the one that silently destroys data quality: every failed pass increments
`attempt_count`, and at the current settings a broker outage of about three minutes would
dead-letter events whose only fault was arriving at the wrong time. Dead-lettering has to keep
meaning _this event is bad_, because M9 and §18 are built on it. So the worker supervises the
connection **and idles the publisher while disconnected**: the backlog waits untouched and drains on
recovery. The heartbeat carries `brokerConnected` so a worker that is alive but deaf is visible.

**`pnpm verify:integration` closed the reproducibility gap, and the round trip closed a test gap.**
Until now Kafka was in no test at all: the publisher ran against a fake transport and both consumers
were called as functions, so the producer, the topic, the key-to-partition mapping, the consumer
group and the JSON envelope were asserted by nothing. `kafka-roundtrip.integration.test.ts` runs
outbox row → producer → Redpanda → consumer group → `kitchen_tickets` for real. It publishes to its
own topic and its own consumer group, both suffixed per run — against `restaurant.order.events` the
worker the user keeps running for the demo would consume the test's events and write kitchen tickets
for orders that do not exist in the demo database. It is excluded from `pnpm test` so the default
suite stays runnable against PostgreSQL alone.

Two details of the script are decisions, not plumbing. It tears down **only the services it
started** — `docker compose ps` before `up`, then `rm -sf` on the difference, never `down -v` — so
running the tests cannot destroy the demo the user has on screen. And it is a Node script rather
than a shell script, because the user is on Windows and CI is on Linux; one file that runs on both
beats two that drift. CI calls that same command and declares no `services:` block: the script owns
the container lifecycle, and declaring both would bind the same ports twice and verify a different
set of containers than anyone runs locally.

One thing deliberately left alone: `GET /api/config` is still the M4 stub. M6's brief lists it
because §17 lists it, and it exists; the Redis cache, the percentage rollout and the 15-second poll
are M13's, together with the polling transport that is the flag's other branch.

## M6 review — the signal the supervisor was not listening for

A Codex pass over `860b064` found one P1 and three P2s. The P1 is the interesting one, and it is the
same shape as both M5 findings: a rule argued correctly in an ADR and wired to the wrong signal.

**P1 — `DISCONNECT` is not how a broker goes away.** The whole claim of ADR 011 is that the worker
stops publishing during an outage so that `attempt_count` cannot dead-letter good events. The
session was hung on the producer's `DISCONNECT` instrumentation event — which KafkaJS emits for an
_explicit_ disconnect, not for the ordinary case of the broker vanishing under an open socket. So in
the exact scenario the supervision exists for, `died()` was never called, `broker.current()` stayed
defined, and the publisher kept calling `publishOnce`. The protection worked at startup and on a
clean shutdown, and not during an outage.

The fix hangs the session on the one signal the worker is guaranteed to receive: **a failed send**.
The transport handed to the publisher is wrapped so that any publish error resolves `whenDead` and
rethrows.

That alone was not enough. `publishOnce` catches per-event failures and continues to the next row,
so one dead session still charged an attempt to every remaining row of a claimed batch — up to fifty
on a single blip. `PublisherOptions` grew an `isTransportAlive` predicate and the loop breaks on it,
with the untouched rows reported as `abandoned`. They keep their lease and are republished when it
expires, having spent nothing. The regression test asserts exactly that: three claimed rows, one
attempt spent, two at `attempt_count = 0`.

The residue, recorded rather than fixed: abandoned rows stay leased for `OUTBOX_LEASE_MS` (30 s), so
a recovery inside that window waits out the lease before republishing. Releasing the claim eagerly
belongs with M9's lease-reclaim hardening.

**P2 — the first log line had no correlation on it.** Fastify writes `incoming request` — the line
carrying the method and the url — _before_ any `onRequest` hook runs, so replacing `request.log` in
a hook left the one line you reach for first without `requestId` or `traceId`. The fields now bind
in `childLoggerFactory`, which is where the request's logger is built. `resolveTraceId` is a pure
function of the headers and the request id, so the factory and the request decorator cannot
disagree. Testing it needed a seam: `buildApp` takes an optional `logDestination`, and the test
collects the real lines and asserts on `incoming request` itself.

**P2 — a probe timeout is not a bound.** `Promise.race` gives up on a check but cannot cancel it, so
anything that could hang forever left one more pending operation behind per health request for the
length of an outage. Two real cases: the Redis probe used the adapter's client, which runs
`maxRetriesPerRequest: null` — right for broadcasts, wrong for a probe — and `pg` waits forever to
hand out a connection by default. Both are now bounded at the client: the Redis probe refuses to
issue a command unless `pub.status === 'ready'`, and the pool has a `connectionTimeoutMillis`. The
race is a backstop for a slow check, not the mechanism.

**P2 — teardown failure reported PASS.** The script promises to leave the machine as it found it, so
`docker compose rm -sf` failing after green tests is a failed run: it hands the next run, or CI,
containers nobody expects. Its exit code is checked and summarised separately from a test failure,
because the cause is unrelated.

The lesson generalises the one M6 already had. That one was "ask what arrives at a handler, not what
is thrown at it". This one is its twin one layer down: **ask what the failure actually emits, not
what the API has an event named after.** Three of the four findings are the same mistake — trusting
a signal (`DISCONNECT`, an `onRequest` hook, a race timeout) to fire at a moment it does not cover.

## M6 review round 2 — the liveness that belonged to the wrong object

A second Codex pass, over `e86d611`, found that the previous round's own P1 fix had a hole, plus two
narrower ones. The pattern from M4 and M5 repeats exactly: **every round's findings were opened by
the previous round's fix.**

**P1 — the predicate asked the supervisor, not the session.** Round 1 hung the session's death on a
failed send, then wired the publisher's guard to `broker.current() !== undefined` — the
_supervisor's_ state. Those are not the same thing for a window that matters: `died()` resolves
`whenDead`, and the supervisor only clears its `session` after `await fresh.stop()`, which waits for
`kitchen.stop()` to disconnect a consumer. For that whole window the predicate says "alive" and the
rest of the batch goes through the transport that just failed — the exact charge the fix existed to
prevent. Worse, once the supervisor reconnects, the same predicate answers for a _replacement_
session about a transport the publisher is no longer holding.

The session now carries its own `alive` flag, flipped synchronously inside `die()` before the error
is rethrown, and the publisher takes the predicate from the same object as the transport:
`publishOnce(db, connection.transport, { ...options, isTransportAlive: connection.isAlive })`.
`stop()` calls `die()` before it awaits anything, for the same reason.

**P2 — a poison record was tearing down the whole session.** The wrapper killed the session on _any_
send failure, which meant `MESSAGE_TOO_LARGE` — a rejection the broker itself sent back, over a
connection that is perfectly healthy — took down the producer and the kitchen consumer, and
abandoned every unrelated row in the batch. Once per retry, until the row dead-lettered. This is the
mirror image of the argument in ADR 011: I insisted `attempt_count` must keep meaning "this event is
bad", and then let a bad event mean "the broker is gone". `isRecordRejection` splits them —
`KafkaJSProtocolError` means the broker answered, so the session lives and the per-event failure
path handles the row. Anything unrecognised still ends the session, because pausing the publisher
costs a reconnect while carrying on costs an attempt per claimed row.

**P2 — the Redis `status` gate does not cover a half-open socket.** A stalled connection can leave
ioredis reporting `ready` with nothing moving, and a `ping` on the adapter's client would then enter
its unbounded retry queue — the accumulation the gate was added to prevent. The two questions are
different and now have different sources: _is the adapter connected?_ is about the client broadcasts
travel on, and only its `status` can answer; _is Redis answering?_ has to be a real command, and it
goes through a third client with `enableOfflineQueue: false` and a `commandTimeout`, so it fails
instead of hanging.

Both fixes moved out of `index.ts` into `shared/broker-session.ts`, which is what made them
testable: `guardTransport` and `isRecordRejection` now have unit tests, and the entry point is
wiring again. Two rounds of P1s lived in that file precisely because nothing there could be
asserted.

The lesson of round 1 was "ask what the failure actually emits". Round 2 sharpens it: **ask which
object the answer belongs to.** A liveness flag on the supervisor and a liveness flag on the session
read identically at the call site and differ exactly during the failure they exist for.

## M6 review round 3 — "the broker answered" is not "the record is at fault"

A third Codex pass, over `ebdfa14`, found two, both opened by round 2's fixes. Fixed, and the review
cycle stops here: the findings are narrowing into conditions this demo cannot reach, and the
remaining budget belongs to M7.

**P1 — the record/connection split was a blacklist where only a whitelist is safe.** Round 2 asked
"did the broker answer?" and treated every `KafkaJSProtocolError` as a record rejection. But
`TOPIC_AUTHORIZATION_FAILED`, `CLUSTER_AUTHORIZATION_FAILED` and their kind are protocol errors too:
the broker answered, and it will answer the same way for _every_ row of the batch. Keeping the
session alive there charges an attempt to each claimed row and dead-letters healthy events — the
exact invariant ADR 011 exists to hold, broken from the other side than round 1 broke it.

The reasoning error was mine, not the code's: "the connection is fine" and "this row is at fault"
are two claims, and I derived the second from the first. `RECORD_REJECTIONS` is now an explicit list
of the produce errors that are about the record itself — `MESSAGE_TOO_LARGE`,
`RECORD_LIST_TOO_LARGE`, `INVALID_RECORD`, `INVALID_TIMESTAMP`, `UNSUPPORTED_FOR_MESSAGE_FORMAT`,
`CORRUPT_MESSAGE` — and anything else ends the session. The asymmetry decides the default: being
wrong about an unfamiliar code costs one reconnect, while being wrong the other way costs a
dead-lettered order event.

**Round 2's test for this was passing vacuously, and the fix is what exposed it.** It built its
`KafkaJSProtocolError` from a string, but KafkaJS copies `type` and `code` off a protocol _error
descriptor_ — so `error.type` was `undefined` and the assertion held only because the old predicate
never looked at it. The helper now attaches a real descriptor, and there is a second case:
`TOPIC_AUTHORIZATION_FAILED` must end the session. A test that cannot fail is worth less than no
test, because it reads like cover.

**P2 — `commandTimeout` rejects a promise, it does not dequeue a command.** ioredis keeps an ordered
response queue, and a command only leaves it when the socket closes. Against a black-holed Redis the
timeout alone therefore left one more queued `PING` behind on every `/api/debug/dependencies`
request — the accumulation the probe client was introduced to prevent, one level down. A failed
probe now disconnects that client and opens a fresh one. The connection is single-purpose and cheap,
so throwing it away is the cheapest correct answer.

Three rounds, and one sentence covers all of them: **each round's finding was opened by the previous
round's fix.** Round 1 wired a correct signal to the wrong object, round 2 split a condition with the
wrong polarity, round 3 bounded a command without releasing it. All three were in the same forty
lines — the ones that carry ADR 011's one real claim — which is a fair measure of how much attention
the load-bearing part of a milestone deserves relative to the rest.

## M6 review round 4 — the leak the disposable connection opened

A fourth Codex pass, over `5c4ae46`, found one thing, and it was again what the previous round's fix
opened. Round 3 made the Redis probe client disposable: a failed probe disconnects it and opens a
replacement. `close()` disconnects it too — and if a probe is still in flight when shutdown runs, its
failure lands in that same `catch` **after** `close()` has finished, and installs a fresh connection
nobody will ever close. During an outage that client's reconnect timers hold the event loop open, so
the API would not exit on SIGTERM: `docker compose stop` would hang on it.

The fix is a `closed` flag set at the top of `close()`, checked before installing a replacement. Two
lines, and it is the shape the whole M6 review turned out to have: a resource whose lifecycle rule
was stated for the running system and not for the shutting-down one.

**Four rounds, and the finding count fell 4 → 3 → 2 → 1.** Every round's single subject was the same
forty lines around ADR 011's one real claim, and every finding was opened by the previous round's
fix. The stopping point was chosen, not reached: the cycle converged, the last defect was small and
closed, and the remaining budget belongs to M7. The honest summary for the interview is not "the
code was right" but "the invariant was stated precisely and attached to a mechanism imprecisely four
times, and an external reviewer caught each one" — which is also why ADR 011 now spells out the
mechanism and not only the rule.

## M7 — IndexedDB persistence

Nothing broke in a way that cost a debugging session, which is itself the observation: the milestone
was small in code and almost entirely about who is allowed to write what, and that is where the
thinking went.

**The one real trap, found while writing rather than while debugging: `structuredClone` refuses a
Vue proxy.** Everything crossing into Dexie comes out of a store, so it arrives as a reactive proxy
and IndexedDB raises `DataCloneError` on it. Handled in one `plain()` helper in the repository —
the one place that knows the provenance of the values — with a test that stores a `reactive()`
snapshot for real, because `fake-indexeddb` implements structured cloning rather than pretending to.
A mocked Dexie would have passed either way.

**`SYNCING` before the request, `PENDING` after a lost answer, and no write in between.** The first
draft wrote `PENDING` on the way out and flipped to `SYNCING`, which is two IndexedDB round trips in
front of every command to record a distinction that has no gap to describe: M7 forms an intent and
attempts it in the same breath. One write, with the states meaning what they will still mean in M8 —
`PENDING` is an intent nobody is currently attempting, which is what M8's queue picks up, and a row
found as `SYNCING` at startup is a tab that died mid-request. M8 introduces the gap; it does not
have to redefine the words.

**`persistenceError` is deliberately not cleared by a later success.** It was, in the first version,
and a test showed what that means: a failed `savePending` followed by a successful `deletePending`
in the same `send()` leaves the badge off, having told the operator nothing about the write that was
lost. A failed write is never retried, so the fact it states stays true. The badge is about whether
this device can be trusted to survive a reload, not about whether the database is currently up.

**Two guards on hydration, and only one of them is load-bearing in the test.** Hydration calls
`adopt`, so the monotonic-version rule applies, _and_ it refuses to install anything when the store
already holds an order. The second is the one that matters: `adopt` accepts a snapshot for a
_different_ order unconditionally, because that is how a `CREATE_ORDER` response installs a new
aggregate, so without the emptiness check a slow read of the cached order would replace the order the
operator created while it was in flight. This is `refetch`'s guard restated for a second slow
reader — the same finding M4's review round made three times, arriving through the door M7 opened.
The test races the two on purpose: it starts `hydrate`, adopts a different order during its read,
and asserts the cache lost.

**The kitchen's tenant filter is not symmetry with the POS, it is a different rule.** A POS pending
row can be read by terminal alone, because a terminal belongs to one restaurant. Every kitchen row
carries the same `terminalId` — there is one display id and every restaurant shares it — so kitchen
hydration must filter on `restaurantId` too, or `/kitchen?restaurantId=b` restores restaurant A's
unresolved commands onto B's rail and offers to retry them.

Web tests went from 47 to 76. `pnpm verify:integration` was run unchanged and passed: no server code
moved, and that is worth demonstrating rather than assuming.

## M7 review — three findings, all of them about _when_ a write happens

A Codex pass over `fe9d5d1` found three, and they share a subject that the milestone's own brief
did not have a column for. The brief tabulated every piece of client state, its owner, and what
hydration must not do to it — and every finding answered "the right writer, at the wrong moment".

**P1 — the pending row was deleted before the answer that settles it was durable.** `send` did
`deletePending` and only then `adopt`, which persisted the snapshot. The two writes are not atomic
and the tab can die between them. For `CREATE_ORDER` that window is expensive: the row is gone, the
snapshot never arrived, and `createOrder` had already cleared the terminal's pointer before
sending — so the reload shows an empty till, and the operator rings the order up a second time.
Both halves of the identity that could have recovered it, `orderId` and `mutationId`, were in the
row that had just been deleted. Reversed: the answer is cached first, and the worst case becomes a
row that outlived its answer, which Retry resolves as `ALREADY_APPLIED`. **Do not reorder these.**

The fix pulled a second decision out with it. `adopt` had been persisting, which meant the cache
was keyed by whatever screen was showing — but `send` can be answering for a terminal the operator
has already walked away from, and that answer belongs to the terminal that _asked_. So `adopt` is
memory-only again, and the two callers that obtain a snapshot from the server — `send` and
`refetch` — cache it themselves, against the terminal they asked on behalf of. Displaying and
caching turned out to be different responsibilities wearing one function's name.

**P2 — hydration left the canonical read to the view, and the view only does it on one transport.**
The plan was hydrate-then-refresh, with the refresh arriving via the socket's `onConnected`. But
`connection.start` returns without opening a socket when `realtime.websocket_push` is off or
`GET /api/config` fails, so on the flag's other branch — the one M13 exists to complete — the
cached snapshot would sit on screen for as long as the tab stayed open. ADR 013's own sentence
("every screen hydrates and then refetches") was true of one code path and asserted of all of them.
`hydrate` now ends with the read, so it is one operation and cannot be half-called.

**P2 — the owner check used the terminal id, and the id outlives the screen.** `onBeforeUnmount`
calls `clear()`, which empties the order but leaves `activeTerminalId` naming the terminal the view
was rendering. A hydration still reading from disk therefore passed its check against a screen that
no longer existed — and worse, against the _next_ mount of the same terminal. The claim is now a
generation bumped by `useTerminal` and `releaseTerminal`, which is the shape `connection.start` and
`connection.stop` had used since M4. I had reached for the nearest available token instead of the
one that models the lifetime; this is round 1 of the M6 review again — a correct signal attached to
the wrong object — in a different file.

All three regression tests were checked by breaking the fix and watching them fail, one at a time.
The unmount test in particular only bites if it re-enters the same terminal before the read lands:
with `releaseTerminal` merely nulling the id, an id check would still pass on the remount.

**The lesson to carry into M8.** The brief asked "who may write this?" for every piece of state and
that was not enough. The second question is **"for each pair of writes, which order survives a
crash between them?"** — M7 has three such pairs (cache/delete, snapshot/pointer, memory/disk) and
got one of them wrong. M8's sync engine is the third writer of this state and the first that runs
without a screen asking it to, so it will have more pairs, not fewer.

## M7 review round 2 — one finding, left open on purpose

A second Codex pass over `2666d4a` found one thing, and it was opened by round 1's fix, which is
now the fifth consecutive milestone where that sentence is true.

**P2 — the cache write is not monotonic.** Round 1 moved persistence out of `adopt` and into
`send` and `refetch`, for a good reason: the cache is keyed by the terminal that asked, and only
those two callers know which terminal that was. But it moved the _write_ and left the _rule_.
`acceptsSnapshot` still guards `order.value` and no longer guards anything on disk, so two
overlapping refetches answering v5 then v4 leave the screen at v5 and `orders` at v4.

What it costs is worth stating precisely, because it is smaller than it first looks and not zero.
A reload does not show v4 for long: `hydrate` now ends with a canonical read. But it shows it until
that read answers, and a command sent in that window carries `baseVersion: 4` and comes back
`409` — a conflict the client invented, presented to the operator with the same banner as a real
one. That is the failure mode: not lost data, a manufactured conflict.

**It is deliberately not fixed in this session**, and the fix is specified in `PROGRESS.md` as the
next session's first commit: the comparison goes inside one Dexie `readwrite` transaction over
`orders` in the repository, reusing `acceptsSnapshot` rather than restating it. Putting it in the
store — read the stored version, compare, then write — would reproduce the same race one level
down, which is the whole shape of the finding a second time.

**The habit to carry forward is narrower than "state has an owner".** Splitting a function into two
responsibilities means asking which of its invariants belonged to which half. `adopt` held two: a
display rule and a durability rule that happened to be the same check. I moved the code and did not
ask, and the check stayed with the half that no longer needed it.

## M7 review round 2, fixed — the cache write that was not monotonic

The fix is the one the previous session specified, with one addition it did not.

`acceptsSnapshot` moved out of `stores/order.ts` into `apps/web/src/domain/order-snapshot.ts`.
The alternative — leaving it where it was and importing it from the repository — would have made
`persistence/` depend on `stores/`, which is a layering inversion and, because `order.ts` already
imports `local-store.ts`, a real ESM cycle. It happens to work (the function is hoisted and nothing
touches `localStore` at module evaluation), and "happens to work" is not a reason. The rule is
about order snapshots, not about screens, so it now lives where both layers can reach it and
neither owns it.

`saveOrder` takes the comparison inside its existing `readwrite` transaction: read `orders` by the
incoming id, apply `acceptsSnapshot`, write only if it passes. Inside, not around — a caller that
read the version and then wrote would move the same race down one level, which is the finding
again. The read is by the incoming id, so the "a different order is always accepted" branch cannot
fire here; what is left of the rule is the version comparison, which is exactly the half a cache
needs. That asymmetry is why the same function serves both callers without a flag.

**The pointer is not under the rule, and that was the decision worth making explicitly.**
`saveOrder` writes two facts and only one of them is versioned. `syncMetadata.currentOrderId`
answers "which order is this device on", and the stale answer is evidence for that just as much as
the fresh one — both callers were working on this order when they asked. Refusing to move the
pointer alongside a refused snapshot would leave a terminal pointing at nothing after `createOrder`
cleared it, purely because two answers arrived in an unlucky sequence. So the snapshot write is
conditional and the pointer write is unconditional, in one transaction.

Three tests, all checked by neutralising the guard and watching them fail: the out-of-order pair
(v5 then v4 stays at v5), the ordinary pair (v4 then v5 moves), and the pointer moving under a
refused snapshot. The second exists because the cheapest way to pass the first is to make the
cache refuse everything.
