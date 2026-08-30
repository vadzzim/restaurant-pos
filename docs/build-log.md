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

## M8 — the queue, and the halt

The milestone that turns M7's storage into §14's client. Four things are worth recording, three of
them because they were decisions and one because it was a bug the brief's own second question found
before the code did.

**The optimistic view is derived, and that is what removed the worst crash window.** The obvious
implementation writes the predicted order into `orders` as each mutation is queued. That is a pair
of writes for one intent, and a crash between them leaves either a predicted order nothing will
ever sync, or a queue row whose effect the screen has forgotten. Folding the queue over the
canonical snapshot on read has neither problem — the projection is a pure function of two persisted
things, so a reload reproduces it exactly — and it keeps a table documented as canonical free of
guesses. The brief asked "for each pair of writes, which order survives a crash between them?" and
the best answer available turned out to be "make it not a pair".

**`baseVersion` is stamped from the projected version.** This is the single decision that makes
§19.2 work: four mutations queued offline drain in order with nothing re-stamped, because a client
that is the only writer can predict the versions the server will produce. The alternative — restamp
each mutation from the canonical version as it goes out — also makes §19.2 pass, and silently
rebases the whole queue onto whatever the server holds. That is last-write-wins with no one
deciding, which is exactly what §14.1 exists to prevent.

**The send gate is a derivation, not a status lookup.** A group is sendable only when every row in
it is `PENDING` or `SYNCING`. The `CONFLICT` + `BLOCKED` writes are one transaction, but the gate
does not depend on that: a crash mid-halt, or a rebase that stopped part-way, both leave a group
the derivation still refuses. It also turned out to be the thing that makes the rebase loop safe —
after re-issuing the head, the followers are still `BLOCKED`, and a gate that had read only the
head's status would have sent them at versions the rebase had already invalidated.

**The bug the second question caught.** Since M8 the queue is the _only_ path to the server, so
`savePending` failing silently — M7's rule, and correct then — became "the command is dropped and
nobody is told". M7's guarantee is that a storage failure never breaks a command, and the queue
quietly repealed it. `savePending` now reports whether the row is there, and a device whose
IndexedDB refuses writes sends the mutation directly through the same `attempt` the pass uses.
Every repository call inside it is already failure-tolerant, so on such a device those writes are
no-ops and what is left is the request and its answer. The existing M7 test caught this within a
minute of the queue landing, which is the argument for that test having existed.

**One thing found while writing the demo, not by a test.** The halt is per aggregate and the screen
is per order, so they come apart: press "New order" while the first order's mutations are still
unsent, and it is the first order the server later refuses. The halted group was then counted by
the pending badge and reachable by nothing — a queue no human could resolve, which is worse than a
queue that stops. `haltedElsewhere` lists them and `focusOrder` goes back to one. New commands are
still refused while the order _on screen_ is halted: a halted order is resolved, not walked away
from.

**And one thing about the tests.** `vi.useFakeTimers()` stalls `fake-indexeddb`, which schedules
its transactions on real timers — every engine test timed out. `vi.useFakeTimers({ toFake: ['Date'] })`
is what gives the queue distinct, controlled `createdAt` values without freezing the database the
tests exist to run against.

## M8 review round 1 — three P1s, all in the seams the queue opened

A Codex pass over `8f72739` found five things. The three P1s are fixed here; the two P2s are in
`PROGRESS.md` under Known problems with the fix each needs.

**P1 — the background answer moved the durable pointer.** This is the same shape as the finding
that opened this session, one milestone later. In the M7 review I established that `saveOrder`
moves `syncMetadata.currentOrderId` even when it refuses the snapshot, and the reasoning was
sound _for the callers that existed_: two answers for the same order, the stale one still evidence
that the terminal is working on it. M8 then gave that function a new caller — a sync engine that
answers for every order the terminal ever queued, including ones the screen left — and the rule
came along without its precondition. Order A finishing in the background moved the pointer off
order B, and the next reload came back to the wrong till.

The fix splits the write rather than adding a flag: `cacheOrder` writes the snapshot,
`saveOrder` writes the snapshot and the pointer, and the monotonic comparison lives in one
`putSnapshotIfNewer` that both call inside their own transaction. The pointer now belongs to the
three actions that move the screen, plus a caller that has just read the order on screen.

**The lesson, and it is the same one twice.** M7's review round 2 was "the write moved and the rule
did not". This is "the rule stayed and its caller changed". Both are a conditional invariant whose
condition is written only in a comment. The habit that would have caught it: when a function gains
a caller of a _kind_ it did not have before — here, one with no screen behind it — re-read every
"because" in its doc comment and ask whether the new caller satisfies it. Two of the four sentences
in `saveOrder`'s comment silently assumed a screen.

**P1 — the halt blocked another terminal's rows.** `haltQueue` selected followers by `orderId`
alone. Two tabs on one origin share the database, and two terminals can hold queued mutations for
one order, so a conflict on POS-1 marked POS-2's later rows `BLOCKED` — halting a terminal that had
no conflict of its own and could not resolve one, because its Discard and Rebase act on rows it
does not own. The rest of the queue is strictly per terminal; this predicate was the one place that
forgot. The order is the consistency boundary on the _server_; a queue belongs to the device.

**P1 — a re-issued mutation was sent even when its swap had not committed.** `reissue` returned the
synthetic row unconditionally, and `guarded` had already swallowed the failure. The old `CONFLICT`
row then survives, so a later reload and rebase re-issues the same intent under yet another fresh
id: one intent applied twice, which is the exact failure a stable `mutationId` exists to prevent.
It now returns `undefined` and the rebase loop stops. This is the second place in M8 where
`guarded`'s neutral value is not neutral — `savePending` was the first — and both were found by
asking what the caller does with a write that silently did not happen.

All three regression tests were checked by reverting each fix and watching them fail. The pointer
one needed rewriting to do so: the first version let the current order's own answer land last and
put the pointer back, which hid the bug. The sequence that exposes it is the one the operator
actually performs — step back to an older order, queue something there, return to the current one,
and let the background drain.

## M8 review round 2 — the two P2s

Both were the sync engine treating a category of thing as a category it is not.

**A §17 error envelope is not a transport failure.** `postMutation` throws `ApiRequestError` for
the envelope and the catch could not tell `PRODUCT_NOT_FOUND` from a socket hang-up, so the row
went back to `PENDING` and every trigger re-sent it — and because a transport failure ends the
pass, the orders behind it were never tried, with no banner saying why. The permanent codes now
halt the aggregate exactly as `MUTATION_ID_REUSED` does, which is the honest description: the
server refused this mutation and will refuse it again, so a human chooses Discard or Rebase.

The classification is an explicit whitelist with the default the other way, and that is the point
worth keeping: `INTERNAL_ERROR` and any unfamiliar code stay transport. An unknown code then costs
one pointless retry; halting by default would stop an aggregate behind a red banner over a 500 that
cleared itself. The worker's `RECORD_REJECTIONS` made the same call for the same reason, and it is
the third time in this project that the right answer was "whitelist the specific, default to the
forgiving".

**What the coalescing loop coalesced was a boolean.** `run(terminalId)` on a busy engine set
`again = true` and the loop repeated with the terminal it had started with, so a route change
during a pass — POS-1 to POS-2 — left the new screen's queue unsent, and with
`realtime.websocket_push` off there is no reconnect trigger to rescue it. The pending request is
now the terminal id itself. Re-requesting the same terminal, which is the ordinary mid-pass
enqueue, behaves exactly as before; the flag was simply carrying less information than the call
site had.

**One move that was not a fix.** `ApiRequestError` came out of `api/client.ts` into `api/errors.ts`,
because the engine has to ask `instanceof` about it and the store tests replace the whole of
`api/client` with a mock — the engine was asking a mocked module for a class it does not define,
and eight unrelated tests failed with a message about the mock. `OfflineError` had already been put
in its own module for the same reason; the second occurrence is what made the rule visible. **A
class that a non-mocked module needs `instanceof` on does not belong in a module the tests mock
wholesale.**

Both regression tests were checked by reverting each fix. The permanent-error one also asserts the
half that is easy to lose: the order _behind_ the halted aggregate still syncs.

## M9 — the lease, and the two windows nothing was watching

The publisher already had backoff, dead-lettering and a lease before this milestone started. What
it did not have was any answer to the question the brief made mandatory — _for each pair of writes,
which order survives a crash between them?_ — and asking it found one real bug, one named gap, and
one place where the schema was lying by omission.

**The bug: a batch could outlive its own lease.** `publishOnce` claimed up to `OUTBOX_BATCH_SIZE`
rows for `OUTBOX_LEASE_MS`, then published them one after another with nothing checking how much of
that lease was left. With the shipped defaults — fifty rows, thirty seconds — a broker taking 600 ms
a send finishes the batch after the lease has gone, and the last rows are published by a worker that
no longer holds them. That is worse than the duplicate §10 already accepts: another worker can have
claimed the same order's _next_ event in the meantime, so the two publishes race and the events can
reach the topic out of version order. Everything downstream — the per-partition ordering guarantee,
the projection's `source_event_version` guard — assumed this could not happen. The pass now measures
its lease from before the claim (the claim's own round trip is spent out of the same budget),
refuses to start a send that will not comfortably finish inside it, and hands the rest of the batch
back. A tenth of the lease is deliberately never used: the local clock is not the database's.

**The named gap: abandoned rows kept their claim.** M6 taught the pass to stop when the broker dies
mid-batch, which was right, but the untouched rows stayed leased for up to thirty seconds for work
nobody was doing. The release is one statement, guarded on `claimed_by = :workerId` so a lease that
expired and was re-taken is never stolen back, and its failure mode is exactly the old behaviour —
which is what makes it safe to run outside any transaction. The same release now covers all three
ways a pass gives up: the transport died, a human paused the publisher, or the lease is nearly up.

**The schema was lying by omission.** A worker that dies mid-publish leaves a lease that expires and
a row another worker takes over. Nothing recorded that this had happened. `attempt_count` must not
move — a reclaim says a _worker_ died, not that the event is bad, and charging it would let a
rolling restart dead-letter healthy events — so a row could be reclaimed forever with no trace. That
is a publisher crashing on one specific event, and it was invisible. `reclaim_count` is now
incremented inside the claim itself: the candidate rows are selected in their own CTE so the UPDATE
can see who held each row _before_ it, because `RETURNING` gives back new values only. ADR 010
records why this is counted and deliberately not a dead-letter trigger.

**The controls are a table, not an environment variable.** §18's `Pause Outbox Publisher` and
`Delay Outbox Publishing` are thrown by one process (the API, once M12 gives them buttons) and
obeyed by another, and a switch a human threw has to survive a worker restart. So they are a
singleton row the worker polls every `OUTBOX_POLL_MS`. Two details matter: a failed read keeps the
**last known** value rather than reverting to the defaults — a database blip must not silently
un-pause a publisher at the worst possible moment — and a pause is checked _between rows_, not only
between passes, because a publish delay large enough to demonstrate is large enough to make a pass
take a minute. `pnpm -F @pos/worker outbox pause|resume|delay <ms>|status` writes the same row.

**§21.12 without faking the crash.** The window is "the record reached Redpanda and `published_at`
was never written". `publishOnce` opens exactly two transactions — the claim, then the mark — so a
`Db` proxy that rejects the _second_ one is the crash itself, rather than a row edited afterwards to
look like one. The lease is then expired by moving `claim_until` into the past instead of sleeping:
the behaviour under test is "an expired lease is re-claimable", not "time passes", and a sleep long
enough to be reliable on a loaded machine would have turned every one of these tests into a
stopwatch race.

**§21.13 had to be an integration test.** The window is entirely about Kafka's offset bookkeeping,
so a fake that calls the handler twice proves nothing beyond §21.6, which has existed since M3. The
test commits the offset for the first event, applies the second without committing it, disconnects,
and lets a second consumer in the same group find out what the group still believes. Kafka
redelivers exactly one event, `processed_events` answers `duplicate`, and the ticket's `updated_at`
is unchanged — not merely its state. It runs under `pnpm verify:integration`, which now has two
broker tests instead of one.

**§21.16's concurrency half needs no clock at all.** Worker A's claim commits before its first send;
that is the shape of the §10 protocol. Gating worker B on A's first send therefore means B provably
runs while A holds every row, and `claimed: 0` is a proof rather than a race that usually passes.

**One repair on the way past.** `packages/db/drizzle.config.ts` pointed at `./src/db/schema.ts`,
which has never existed in this repo; `drizzle-kit generate` had been failing since M1 and the 0000
migration was the only one anyone had needed. Fixing the path produced exactly the expected diff
against the stored snapshot, which is the reassuring outcome.

## M9 review round 1 — the guard that bounded the wrong half

A Codex pass over `ed9a0b7` found four things: one P1 and three P2s. All four are fixed here, and
the P1 is the interesting one, because it is a case of the code and the prose agreeing with each
other and both being wrong.

**The P1: the lease bounded what came _before_ a send, and not the send.** M9's new guard refused
to _start_ a publish that would not finish inside the remaining lease — but it computed "would not
finish" from the artificial `publish_delay_ms` alone. The send itself was unbounded. KafkaJS
defaults to retrying with backoff and a 30 s request timeout, so a `send()` can comfortably outlive
a 30 s lease, and then the worker marks published a row another worker has already reclaimed.
`sendWithinLease` now races the publish against what is left of the lease.

**And the claim in the brief was too strong.** The M9 brief said publishing under a stale lease
"is the one way this design produces a _reordered_ duplicate rather than a plain one". Working out
how to bound the send properly showed that the reorder it feared cannot actually happen, for a
reason already in the design: a successor event is unclaimable until its predecessor is published,
so the only record a slow worker can land late is a **duplicate of an event already on the topic**,
carrying an `event_id` both consumers have in `processed_events`. What the guard really buys is
narrower and still worth having — this worker stops publishing, and stops writing `published_at`,
under a claim it no longer holds, and a hung producer stops holding the publish loop. The brief and
the code comment now say that instead. KafkaJS cannot cancel a request in flight, so the abandoned
send _may still land_; `onLeaseOverrun` tears the broker session down, which closes the socket and
is the nearest thing to cancellation on offer.

**P2: a pause thrown during the delay arrived a delay late.** The controls were read once per row,
before the wait. With `delay 3000` and a poll interval of 500 ms, "pause takes effect between rows"
was true only in the sense that it took effect three seconds later. The switch is now re-read after
the sleep, and the row that was waiting is released unsent. The test does not race a timer for
this: the fake control getter answers "running" on its first call and "paused" from the second, so
the assertion is about _how many times the value is read_, which is the actual behaviour under test.

**P2: `delay` accepted values that were a permanent pause in disguise.** With the shipped 30 s
lease, any delay of 27 s or more consumes the whole lease budget before the first send, so every
pass claims rows, waits, releases them and publishes nothing — for ever, silently.
`maxPublishDelayMs` is half the budget (13.5 s at the default lease), the switch refuses anything
larger and says why, and the worker logs a warning if a pass ever spends its lease without
publishing, because the row can still be written by hand.

**P2: `setInterval` is a metronome, not a gap between reads.** A control read slower than
`OUTBOX_POLL_MS` overlapped the next one — during exactly the database trouble the "keep the last
known value" rule exists for. Overlapping reads pile onto the pool and can settle out of order,
which would let an older snapshot overwrite a newer pause. The watcher now schedules the next read
only when the current one settles. It also takes a reader function rather than a `Db`, which is
what makes all of this testable without a database that can be made slow to order — the four new
control tests came with that change.

## M10 — the print job, and the one place a job and a record may disagree

M10 was first on the drop list and was built anyway. The reason it earned its place is not BullMQ
as a résumé keyword: it is that printing is the only effect in this system that leaves the database
entirely, so it is the only place where the effect and its record **cannot** be one transaction.
ADR 010 rejected BullMQ for the outbox because a job and a row would be two sources of truth for one
fact; here that dual-write is unavoidable, and the milestone is about what makes it safe. ADR 014
records the answer.

**The load-bearing decision was where the `print_jobs` row gets written.** The obvious placement is
the enqueue: the consumer projects a ticket, writes a `PENDING` row and adds a job. That is wrong,
and it is wrong in a way that only shows up in the reconciler. With a row written at enqueue time,
"a ticket with a `PENDING` row" covers both _a job is running right now_ and _the job is gone and
nothing will ever print this_, and telling them apart needs a timeout — a guess. Writing the row in
the **processor** instead makes the sweep's question exact: a `kitchen_tickets` row with no
`print_jobs` row means nothing has ever tried to print that ticket. A crash between the projection
commit and the `add`, a redelivery that answered `duplicate` (§21.13) and therefore enqueued
nothing, and a Redis that lost every key all leave that same evidence, and one mechanism repairs all
three. Staleness is still needed for rows that _do_ exist and have gone quiet, but it is now the
minority case rather than the whole design.

**The pair question again, and the answer that shaped the consumer.** The enqueue happens after the
projection's transaction commits — §7 forbids the network call inside it, and a queue holding a job
for a projection that rolled back would print a ticket for an order that does not exist. That order
means the enqueue can be lost, which is fine. What is not fine is the enqueue _failing the message
handler_: a rejected `eachMessage` leaves the Kafka offset uncommitted, so an event whose projection
is already applied is redelivered — for ever, if Redis is what is broken. So the enqueue logs and
returns, and the sweep is the repair. That is the third milestone running where the interesting bug
was not "who writes this" but "in what order, and what does a crash in between leave behind".

**Two counters for one process, deliberately not reconciled.** BullMQ's `attemptsMade` and
`print_jobs.attempt_count` count the same failures and are allowed to diverge: the queue owns the
_schedule_ and the row owns the _verdict_. A job re-enqueued by the sweep starts a fresh BullMQ
attempt series against a row that remembers every attempt before it, so a printer that has been down
all afternoon dead-letters once rather than once per enqueue. Anyone reading a BullMQ dashboard will
see a different number from `/debug`, and that is the documented cost.

**`removeOnFail: true`, and the trap that forced it.** BullMQ keeps terminal jobs under their
`jobId`, and the `jobId` here is the ticket hash — which is what makes a duplicate `add` a no-op
while a job is live. Left in place, a _failed_ job under that id would silently swallow every later
`add` for the same ticket: the sweep's repair and a human's manual retry would both return success
and do nothing. The visible record of a failure is the `print_jobs` row, so the queue keeps neither
completed nor failed jobs and the id is always free.

**Two smaller judgements, both recorded because they are not obviously right.** The sweep skips
`CANCELLED` tickets — it can run minutes late, and paper for an order the floor already cancelled
helps nobody — while the live path does not, so an order cancelled a second after being sent still
prints. And the fake printer's idempotency ledger is an in-memory `Map`, not a table: a real
device's dedup window is its own memory and forgets on a power cycle, and modelling it durably would
look more robust while claiming a guarantee §12.3 explicitly does not have.

**Three mechanical notes.**

- `bullmq@5` bundles `ioredis@5`, and the worker had been given `ioredis@6`. Passing an `ioredis@6`
  client where BullMQ wants its own is a type error under `exactOptionalPropertyTypes`, with a
  twelve-line trace that ends at a protected field on `AbstractConnector`. The worker now pins
  `ioredis@^5.11.1`; the API stays on 6 for the Socket.IO adapter, which is a different package
  graph and does not meet BullMQ's types.
- `pnpm install` reports `msgpackr-extract` as an ignored build script. It is an optional native
  accelerator for BullMQ's serialiser and its absence is a silent JavaScript fallback, so nothing
  approves it.
- The `NOT NULL` column added to `print_jobs` has no default, which would fail on a table with rows.
  Nothing has ever written `print_jobs` — it was created empty in M2 and this is its first user — so
  the migration is safe exactly once, and this is the note for the next person who reads it.

## M10 review round 1 — the soft dependency that could stop the kitchen

An external review of the M10 commit returned two findings. The first is the sixth milestone
running where the rule was stated correctly and attached to the wrong mechanism.

**P1 — `maxRetriesPerRequest: null` on the queue's producer connection.** That setting is BullMQ's
requirement for the connection its `Worker` _blocks_ on, and I applied it to both connections
because one helper built both. On the producer it means the opposite of what it means on the worker:
a command issued while Redis is unreachable never settles. The kitchen consumer awaits
`queue.add()` inside `eachMessage`, after committing its projection, so an unreachable Redis leaves
that handler suspended — the offset is never committed, and the consumer projects nothing further.
Redis is soft everywhere in this system (ADR 011, ADR 014), and this made it the one dependency that
could stop the kitchen. The `enqueueTicket` comment even promised the opposite: "it never throws"
was true, and useless, because it never _returned_ either.

**Bounding it needed two guards, not one, and that is the part worth remembering.** The obvious fix
— a finite `maxRetriesPerRequest` and a `commandTimeout` on the producer — only covers a connection
that was ready and then broke: the command reaches ioredis's offline queue and the timeout rejects
it. If Redis was never reachable, BullMQ is still inside `RedisConnection.waitUntilReady`, no
command has been issued at all, and there is nothing for a command timeout to bound; it waits for as
long as ioredis keeps reconnecting, which is for ever by default. So `createPrintQueue` now also
races the `add` against `PRINT_ENQUEUE_TIMEOUT_MS`. Neither guard gives up on the _connection_ —
ending it would have been the third wrong answer, because the queue must work again when Redis comes
back.

Two dead ends are worth recording. `enableOfflineQueue: false` does not help, for the same reason
the command timeout does not: the wait happens before any command exists. And BullMQ's
`skipWaitingForReady` moves the wait rather than removing it — `init()` then runs `loadCommands` and
a version check, which would reject through the bounded connection and leave `initializing` in a
permanently rejected state, killing the queue for the lifetime of the process.

The test is a unit test with no infrastructure at all: a queue pointed at `redis://127.0.0.1:1`,
where every connection is refused immediately. It asserts the enqueue _rejects_, and that it does so
within ten times its bound — the assertion is "bounded", not "fast". With the race removed it hangs
until vitest's 30-second timeout, which is how it was checked to be capable of failing.

**P2 — the Compose `app` profile pointed the worker at itself.** `PRINTER_URL` defaults to
`http://localhost:3000/api/printer/print`, which is right for `pnpm dev` and wrong inside a
container where `localhost` is the worker. Every print would have been refused and every ticket
dead-lettered. The worker service now sets `PRINTER_URL: http://api:3000/api/printer/print` and
depends on `api`. Nothing caught it because the `app` profile is a convenience that no test starts —
the same blind spot as before, now with one more thing behind it.

The shared shapes moved to `apps/worker/src/shared/redis.ts`: `BLOCKING_CONNECTION` for the BullMQ
worker, `producerConnection(timeout)` for everything that enqueues, and one `connectRedis` that
always attaches the `error` listener. Having the two named side by side is the point — the bug was
that they looked like one thing.

## M10 review round 2 — bounding the caller is not releasing the work

Round 1's fix opened round 2, for the seventh milestone in a row. Two findings, both about waits
that nobody was watching.

**P1 — the abandoned `add` kept the ticket.** Racing `queue.add()` against a timeout freed the
kitchen consumer, which is what round 1 set out to do, and did nothing whatsoever about the work
it walked away from: BullMQ was still inside `waitUntilReady`, holding the job and its promise
against a readiness that was not coming. One retained ticket per event, for the whole outage. The
consumer kept projecting, so the symptom was not a stall but memory — a soft dependency taking the
worker down slowly instead of quickly. **A timeout is a statement about the caller, never about
the callee**, and the round 1 comment came close to saying so while missing the consequence: "a
late add is harmless" is true about correctness and says nothing about what is being held until
then.

The fix is to refuse before starting anything: if the ioredis client is not `ready`, `enqueue`
throws without touching BullMQ. Nothing is handed over, so nothing is retained.

**Two designs were tried, and the second is the one worth explaining.** The first was to _wait_,
bounded, for the client to become ready and only then `add` — no accumulation either, and no
spurious failure at boot when the client is a few milliseconds from ready. But it makes every event
during an outage cost the full bound before the consumer can move on, which slows the kitchen
projection to one event per `PRINT_ENQUEUE_TIMEOUT_MS` — the same class of problem, milder, and it
would have come back as round 3. Refusing immediately keeps the consumer at full speed and costs
only a ticket enqueued inside the window between the connection opening and reaching `ready`. That
connection is built at boot, long before the consumer group has joined, and the sweep repairs the
window if it is ever hit. So there are now three guards, each covering something the others cannot:
the status check stops work being _started_, `commandTimeout` bounds work that _was_ started, and
the race covers the seam where the client is ready when checked and drops before `add` reads it.

**P2 — shutdown could hang for ever.** `printWorker.close()`, `printQueue.close()` and especially
`printWorkerRedis.quit()` do not _reject_ when Redis is unreachable — they wait for a reply that is
never coming, and `quit()` on a connection with `maxRetriesPerRequest: null` waits by design. The
`try`/`catch` around them was therefore decorative: nothing after `stopPrinting()` would ever run,
`closeDb()` included, and only SIGKILL would end the process. Every step is now bounded by
`PRINT_SHUTDOWN_TIMEOUT_MS` and both clients are `disconnect()`ed unconditionally afterwards —
local, synchronous, and no reply required. The printer CLI had the same ordering bug and the same
fix.

The sharpest part of this finding is where the reviewer found the evidence: **the round 1 test
already did `redis.disconnect()` before `queue.close()`**, with a comment saying why, because it
would otherwise hang. The knowledge was in the repository, in a comment, in the same commit, and it
had not been carried the twenty lines into the production path. A test that has to work around a
behaviour is reporting a bug.

`settleWithin` in `apps/worker/src/shared/timeout.ts` is now the one place that pattern lives —
three call sites, the enqueue, the shutdown and the CLI — and it keeps the "attach a handler up
front so an abandoned rejection is never unhandled" rule with it.

## M10 review round 3 — one finding fixed, one investigated and rejected

Two findings this round. The interesting outcome is that only one of them was real, and proving the
other one wrong took longer than fixing the first.

**P1 — `printer retry` fast-failed against a healthy Redis.** Round 2's rule is that `enqueue`
refuses while the client is not `ready`, and the justification was written for a long-running
process: the worker opens its connection at boot, so by the time a Kafka event arrives the client
has been ready for seconds. The CLI has no such head start — it connects and enqueues microseconds
apart — so `printer retry` would almost always be refused, **after** having reset the dead-lettered
row to `PENDING`. The command reported failure, the ticket waited for the stale-row sweep, and
§19.9's last step was broken by a guard written for a different caller.

The fix separates the two lifetimes explicitly: `waitUntilReady` in `shared/redis.ts` for
short-lived callers, the status check for long-lived ones, and the CLI waits **before** it writes
anything, so an unreachable Redis leaves the row untouched. The general lesson is one this
repository keeps relearning: a rule justified by "the caller will have connected by then" is a rule
about _one_ caller, and it belongs where that assumption is checkable.

**P2 — the duplicated blocking connection: investigated, does not reproduce.** The report was that
`printWorker.close()` can overrun, because BullMQ duplicates the ioredis client it is given for its
blocking commands, so disconnecting ours does not reach the duplicate; the suggested fix was a
forced worker teardown. It is a good hypothesis — the duplicate is real (`worker.js` builds it with
`.duplicate()`), it is `private` in the typings, and `Worker.close` memoises its promise, so a
graceful attempt genuinely cannot be escalated afterwards.

It does not happen, and the reason is two lines inside BullMQ. `close(false)` runs
`whenCurrentJobsFinished(false)` first, and that calls `blockingConnection.disconnect(true)` — a
**local** socket destroy, no Redis round trip — before anything sends a `QUIT`. By the time
`blockingConnection.close(false)` reaches `_client.quit()`, that client is already at status `end`,
so the call rejects immediately and BullMQ swallows it as a connection error. The duplicate is
ended either way, and no reconnect timer survives to keep the process alive.

This was checked rather than argued. A forced close was implemented first, and it needed two extra
mechanisms to be safe — an in-flight counter to replace the graceful wait, and a `process.on
('unhandledRejection')` guard, because disconnecting under an outstanding `BZPOPMIN` leaves a
rejection with no owner. Then two tests were written to prove the fix was necessary, and **neither
could tell the two versions apart**: not a Redis that was never reachable, and not one that stops
answering mid-connection, which was simulated with a TCP proxy in front of the real Redis that
keeps the sockets open and drops the bytes. Both close paths finished in milliseconds. The whole
change was reverted: it was a forced teardown, an unhandled-rejection handler and an abandoned
print attempt per restart, all to fix something that was not happening.

What survives is one cheap unit test asserting the _property_ — closing the print worker finishes
even when Redis was never reachable — because the mechanism belongs to BullMQ and may change. The
ready-then-unreachable half of that property is **not** covered: the proxy that reproduces it also
produces unhandled `Connection is closed.` rejections from the fault itself, which would make the
suite red for a reason that has nothing to do with this code. That gap is recorded in
`PROGRESS.md` rather than papered over with a test that ignores errors.

## M11 — the debug dashboard

### The two-process problem, answered by not solving it

§20's counter list mixes facts that happen in the API with facts that happen in the worker, and
`/debug` is served by the API. The obvious design ships the worker's counters somewhere the API can
read them, and the obvious somewhere is Redis. That would have been eight or nine counters in
Redis, every one of them a fire-and-forget write on a hot path, all of them zero after a `FLUSHALL`
and none of them agreeing with the database they describe.

The rule taken instead: **derive from the database wherever the fact already has a row.** Published
events are `outbox_events.published_at`. Printed tickets are `print_jobs.state`. Consumed events are
`processed_events`, grouped by `consumer_name`. Conflicts and blocked mutations are `conflict_log`.
The idempotency ledger is `processed_mutations`. All of that is durable, fleet-wide, survives a
restart of either process, and needs no transport at all — the worker writes rows and the API reads
them, which is what the outbox pattern already made true.

Exactly one counter is left with no row anywhere: a redelivery that dedup suppressed. Both consumers
`INCR` one Redis key whose name comes from `sharedCounterKey()` in `@pos/contracts`, so the two
processes cannot spell it differently. When Redis is unreachable it reads `null`, never `0` — and
that is the point rather than an edge case: `known-problems.md` said a Redis outage was invisible,
and a zero here would have been the most convincing way to keep it that way.

Three sources, and the page names all three. A `process` counter resets with the API and says so; a
`database` counter is durable and says so; a `shared` counter can be unreadable and says so. A
fourth, `client`, is counted in the browser and persisted in Dexie, because the server genuinely
cannot observe an offline sync: a queued mutation that finally arrives is indistinguishable from one
typed a second ago.

### Two endpoints over one table, on purpose

`GET /api/debug/events` and `GET /api/debug/outbox` both read `outbox_events`. That looks like
duplication and is not: one asks _what happened_ — newest first, with the consumers that recorded
each event — and the other asks _what is stuck_ — dead-lettered first, then unpublished, with
attempts, `reclaim_count` and the last error. Merging them gives either a log with retry columns
nobody reads or a queue with a history nobody wanted. `outbox` also owns `print_jobs`, because both
halves are at-least-once pipelines with a dead-letter state and the question asked of them is the
same one.

The conflict endpoint returns a page of rows and takes its totals from the counter query rather than
from `rows.length`. Fifty out of four hundred calling itself the total would have been the one
number on a page about honesty that lied.

### Presence: the mechanism is the TTL, not the disconnect handler

Presence is written only by the `presence` heartbeat, never by `subscribe`: the client is the one
thing that knows its pending-mutation count and its §18 offline switch, and an entry derived from a
subscribe would be a guess at half its fields. The key is `SET … PX`, one round trip, so there is no
window in which a presence key exists without a lifetime.

A disconnect deletes the key eagerly, and that is a courtesy. What makes the panel correct is the
TTL: a browser killed, a lid closed, or the API instance holding the socket dying are all cases the
handler never runs for. Stale is marked at two missed beats rather than one — a poll lands at an
arbitrary point in the interval, so a one-beat threshold would call every healthy terminal stale
about half the time — and a stale entry is shown, not hidden, because "POS-1 was here nine seconds
ago" is information and dropping it would make a struggling terminal look like one that never
connected.

### The review round: a leak that only appears when the page is doing its job

One P1. `createConsumerLagProbe` memoised the admin _client_ and awaited `connect()` between the
check and the assignment. `/debug` polls every two seconds and a probe is allowed to take as long as
its timeout, so overlapping calls are the ordinary case rather than a race worth waving away: two
calls each build a client, one is overwritten while still connected, and nothing ever disconnects
it. A leaked KafkaJS admin keeps its retry timers alive, so the API would stop exiting on SIGTERM —
the same failure M10 spent three rounds on, in a new place. The fix memoises the _promise_, clears
it on failure so a dead connection is not remembered as the connection, and `close()` awaits a
connection still being opened rather than ignoring it. A test opens two probes against a held-open
`connect()` and asserts one client is built and one disconnected.

Two P3s and a P2 went to the review backlog unfixed, per the discipline: `readDatabaseCounters` runs
three times per poll cycle, a `terminalId` is not checked against `TERMINALS`, and one socket can
leave one stale presence entry behind for its TTL.

### One pre-existing defect, found by trying to run the thing

The milestone's own verification asks for every section to populate against live traffic, and that
needs a worker. It would not start: `import { KafkaJSProtocolError } from 'kafkajs'` is a
`SyntaxError` under Node's own ESM loader, because KafkaJS is CommonJS and Node detects its named
exports by static analysis of the module body — `Kafka` is found that way and `KafkaJSProtocolError`
is not. The import has been there since M9 and **every test passed against it**, because vitest and
tsup both rewrite the import into a `require`. So the worker suite was green against a process that
could not boot. Fixed by destructuring the default export, which is the interop Node itself
suggests, with the reasoning in a comment so nobody tidies it back.

The lesson is narrower than "test the built artefact": it is that a test runner which transpiles
modules cannot answer a question about module loading, and the only thing that can is starting the
process. The same session also found the demo database two migrations behind, which no test could
have found either, for the same reason — the test database is created and migrated by the suite.

## M12 — the failure simulator

Eleven controls, and the only decision that mattered was made before any of them was drawn: what
the write surface is. `/debug` had been read-only since M11 and §17 lists a single debug write, so
the obvious outcome was five endpoints for four switches. ADR 015 records what happened instead —
the eleven divide by **where the switch lives**, and once that is the axis, the answer falls out.
Four are rows in PostgreSQL and share one endpoint pair; the other seven are things a _client_ does
and never reach the API at all.

`Replay Last Kafka Event` was the interesting one. The obvious build is a Kafka producer in the API,
and it is wrong: the publisher is the only thing in this system that writes to the topic, so a
producer here would put an event on it that the outbox has no record of re-sending — and §19.6 is
precisely a claim about the outbox path. So the replay is an `UPDATE`: the newest published row goes
back to claimable, the worker sends it again, `processed_events` catches it. No new infrastructure,
and the demonstration is the real machinery rather than a re-enactment of it. The statement reads
`published_at` in a CTE rather than from `RETURNING`, which gives back the `null` it just wrote —
the same trap `claimBatch` has a comment about — and takes its row `FOR UPDATE SKIP LOCKED`, so two
presses replay two different events instead of one waiting on the other.

`readOutboxControls`/`setOutboxControls` moved from the worker into `@pos/db` when the API became
their second writer, next to `printer-controls.ts`, which had made the same move for the same
reason. `maxPublishDelayMs` moved into `@pos/contracts` for a third caller: the worker honours the
ceiling, the CLI validates a typed value, and now the API validates a clicked one — three copies of
the formula would have been the alternative.

The seven client controls hang off `postMutation`, not off a store. That is the same decision M8
made for the offline switch, and it holds for the same reason: a control the sync engine could
route around is not a control. Two of them are latches rather than actions, because `/debug` is its
own route — a `Disconnect WebSocket` that closed an open socket would do nothing pressed from a page
where no screen holds one. The latch is read by the connection store's `start`, and a watcher
re-runs `start` so a switch thrown while a POS is up takes effect without leaving the page.

### The review pass

One P1, in the milestone's own feature. `applyVersionConflictArm` spent the arm when it rewrote the
request, but two things in front of the send can refuse to send: the offline gate throws before
`fetch`, and a dead network throws during it. So arming `Create Version Conflict` on `/debug` and
walking to a POS that happened to be offline consumed the arm silently, and the operator would press
again and again with nothing happening — the exact failure a demo switch must not have. The arm now
returns a `spend()` the caller invokes only after the request has actually reached the server. Two
tests pin it, one per way of not sending.

Also corrected: the effect log told the operator that `Fail Printer` would be seen "within one
`OUTBOX_POLL_MS`". It would not — the fake device reads its row on every print rather than polling
it, so that switch is immediate. Not a defect in the code, a false sentence in the product, which on
a page whose entire purpose is to say where numbers come from is the same kind of mistake.

Two P3s went to the backlog unfixed: the replay does not reset `attempt_count`, and `busy` holds one
control name so two overlapping presses under-disable one button.

### What the automated verification cannot cover

Item 5 of the M12 brief is a by-hand pass over all eleven controls in a browser. The four
server-side ones were exercised against a running API over HTTP — pause, delay, fail printer, and a
replay that came back naming `OrderSentToKitchen v3` — which is a stronger check than `inject`,
because it proves the routes are reachable in the assembled process. The seven client ones are
covered by unit tests that send real bodies through `fetch`, but "the badge changes and the presence
row goes stale" is a claim only a browser can settle, and this session did not open one.

## M13 — Feature flags and the polling fallback

The milestone is two halves of one sentence from §15: _turning the flag off degrades latency, it
does not cause an outage._ The flag machinery was the small half — a cache port, a hash, one
endpoint pair — and the transport was the large one, because that sentence is only true if the other
branch is a real implementation.

**The polling transport reuses the screen's own `refresh`.** The POS never treated a socket event as
data — it treated it as a reason to refetch — so the second transport had nothing new to invent: it
calls the same canonical read on a timer. That is why the two branches differ in latency and in
nothing else, and it is what `connectPolling` is: a timer, a guard against overlapping refetches, and
a presence beat.

**Presence had to leave the socket.** `[M11, P2]` was written as harmless because `PUSH DISABLED`
meant no live updates at all; the moment polling worked, a working terminal would have been invisible
on the one panel the rollout demo depends on. The beat moved into `realtime/presence-beat.ts`, which
both transports drive — an `emit` on one side, `POST /api/presence` on the other — and
`PresenceEntry` gained `source`, so `/debug` now names the transport each report arrived on. Riding
the beat on the 15 s config poll was the alternative: three times too slow for `PRESENCE_TTL_MS`, and
a GET that writes.

**The rollout is a fact, not a hope.** `flagBucket` is FNV-1a over `${key}:${restaurantId}`, and the
two seeded restaurants land on 1 and 24, so any percentage between 2 and 24 puts POS-1 on push and
POS-3 on polling at the same time. A test pins both numbers: if the hash changes, the demo
percentage changes with it, and that is the kind of thing that is discovered in front of an audience
otherwise. Recorded with the rest of the reasoning in **ADR 008**, the last unwritten one.

The flag routes are M12's simulator pair again, deliberately: a zod enum on the path segment, a
patch body, the new state in the response (ADR 015). Two debug write surfaces built two ways would
be two things to reason about for nothing.

### The review pass

One P1, and in this milestone's own new code. The 15-second config re-poll rebuilt the connection
whenever the answer _changed_ — and `UNKNOWN` is a change. A single failed `GET /api/config` would
therefore have closed a working socket and left the screen with no transport until the next poll:
a blip turned into the outage the flag exists to avoid. `UNKNOWN` is now ignored by the re-poll; a
client keeps what it has until the endpoint answers with a transport again. A test covers it.

Nothing went to the backlog this time. Three entries left it instead: the `[M11, P2]` presence
defect is fixed, and the two apologies — for `GET /api/config` being an M4 stub and for
`Force Polling Transport` reaching a dead branch — describe features that now exist.

### What the automated verification cannot cover

333 → 363 tests, all green, plus the three integration checks. What no test here settles is the
demo itself: two browser windows, `/pos/pos-1` reading `PUSH` and `/pos/pos-3` reading `POLLING`
with the percentage at 10, and both staying correct through a mutation. The store tests drive the
same code paths with fake timers, but "side by side on screen" is a claim only a browser can make,
and this session did not open one.

### The Codex review of M13

Two findings, one of them in the P1 fix above — which is the useful kind of second opinion.

**[P1, fixed]** The 15-second poll had stopped rebuilding on `UNKNOWN`, but the rebuild itself still
went through `start()`, and `start()` tore the connection down and then fetched `/api/config` again.
So the guard covered the poll's own request and left the _second_ one uncovered: one failure there
and a working client dropped to `UNKNOWN` for an interval — exactly the outage the guard was added
to prevent, one call further down. Installing a transport is now `open(options, resolved)`, which
takes an answer already in hand and does not await anything, so the old connection is closed and the
new one built in the same turn. `start()` is `resolve` then `open`, and it no longer tears anything
down before its await: a superseded `start` now leaves a working connection alone instead of having
already closed it. Two tests: one counts the config requests a switch makes, one lets every request
after the poll's own fail and still expects a running polling transport.

**[P2, backlog]** A cache fill that missed can land _after_ a concurrent flag write deleted the key,
restoring the pre-toggle rows for one `FLAG_CACHE_TTL_MS`. Real, and the window is narrow enough
that the cost is one extra poll interval on one demo toggle; written up in `known-problems.md` as
`[M13, P2]` with a versioned fill named as the fix.

## M14 — Production images and the multi-instance smoke test

### The path the event takes, and why the obvious test would have been a coin flip

§19.10 reads "a mutation on instance A reaches a client connected to instance B", and the obvious
test is exactly that sentence: POST to A, listen on B. It would have been worthless. Nothing in
`apps/api` broadcasts from the mutation handler — the only `RealtimeEmitter` producer is
`modules/realtime/consumer.ts` — so the event travels outbox → worker → Kafka → the realtime
consumer group → _one_ replica → the Redis adapter → the rest. Both replicas are in that group, so
which one consumes is not ours to choose, and on the runs where B consumed, B's client would have
received the event without any cross-instance hop at all. The test would have passed with the
adapter removed, half the time.

So the test attaches a client to **both** replicas and asserts both receive it. Whichever replica
consumed, the other one's delivery crossed Redis, and asserting the two sockets saw the same
`eventId` is what distinguishes one consumption fanned out from two independent consumptions.

### Three things the images taught, all of them at the second attempt

**`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`.** Switching an existing install to `--prod` makes
pnpm rebuild the modules directory, and it refuses to remove one unattended unless `CI=true` says it
is unattended. Two of the three images died on it.

**`localhost` is `::1` in the Node image.** The API bound to `0.0.0.0` was listening, serving and
healthy, and the healthcheck's busybox `wget http://localhost:3000/...` answered "connection
refused" because it tried the IPv6 address first. `docker compose up --wait` then reported
"dependency failed to start" on a working container. The healthchecks name `127.0.0.1`.

**The image is the only correct production build in the repository.** The container's bundle came
out at 307 kB against the host's 446 kB, 97 modules against 100. The container's was the right one:
the host bundle still carried Vue's dev warnings and 60 references to the devtools hook.
`loadEnv()` in `vite.config.ts` is not read-only — a `NODE_ENV` in the files it reads is promoted
to `process.env.VITE_USER_NODE_ENV`, which is what Vite consults for the build's mode, and the
repository-root `.env` says `development` for the API's benefit. Every `pnpm build` since M1 has
emitted a development bundle. One `delete process.env.VITE_USER_NODE_ENV` after the load, and the
host now builds what the image builds. This is the milestone paying for itself: the defect was
invisible until something built the app in a place with no `.env`.

### Two runners, one lifecycle

`verify-integration.mjs` and the new `verify-multi-instance.mjs` do the same four things — bring up,
run steps, tear down only what this run started, write to a file — so that moved into
`scripts/lib/compose-run.mjs`. The one non-obvious piece is `snapshot()`: the "what was already
running" reading has to be taken _before_ anything is started, and the multi-instance script starts
the infrastructure itself (the schema has to exist before a replica's readiness probe runs), so it
takes the snapshot explicitly rather than leaving it to the first `up()`.

### The review pass

No P1. The three defects this milestone found were found by running it, not by reading it, and all
three are fixed above. Four P2/P3 went to the backlog: the smoke run writes its two throwaway orders
into the demo database rather than a test one; nginx resolves the replica names once at startup;
`worker-prod` has no healthcheck, so `--wait` proves it is running and not that it is publishing;
and the CI `images` job builds the images without ever starting one.

### What the automated verification cannot cover

365 tests unchanged, plus the three integration checks and the new §19.10 run. What no test settles
is the browser half of the two-replica story: `verify:multi --keep` puts the built app on :8081 in
front of both replicas, and two tabs landing on different instances and seeing each other's orders
is a claim only a browser can make. This session did not open one.

### The Codex review of M14

One finding, and a real one.

**[P1, fixed]** `verify-multi-instance.mjs` migrated and seeded whatever `DATABASE_URL` named, while
`docker-compose.multi.yml` hard-codes `postgres:5432/pos` for the replicas. The two agreed only
because this machine's `.env` happens to point at the same container. Anywhere else the run would
have written reference rows into an unrelated database and then failed, because the stack's own
database would still be unmigrated — a verification that damages one database while reporting a
failure of another. The schema steps now name `STACK_DATABASE_URL` explicitly; `run()` in
`compose-run.mjs` grew an `env` override for it, and `runSteps` passes a step's options through.

The override is enough because Node's `--env-file` yields to a variable already in the environment —
checked, not assumed — so it reaches `db:migrate` past the `--env-file-if-exists=../../.env` in
`@pos/db`'s own script. Proved by re-running the whole verification with
`DATABASE_URL=…/pos_wrong_db` in the shell: PASS, and the name never appears in the log.

`verify-integration.mjs` does not have the same defect and was left alone: it starts no application
containers, so there is no hard-coded address for a host-side one to disagree with.

## M15 — POS UX for rush, and BAR-1

### The screen was the thing that waited

`PosView` set one `busy` flag around every action, and every action ended in `enqueue()` →
`await sync()` → a network round trip. Every menu tile and every ± button was therefore disabled
until the server answered a tap on any one of them. Locally that is invisible; with a 1.5 s delay
injected into `fetch` it locks the till out for the whole round trip on every tap. §14 says the UI
updates optimistically and never waits, and the store already obeyed it — `enqueue` writes the queue
row and calls `refreshQueue()` _before_ it syncs, and `projected` is a pure function of cache +
queue. The optimism was there. The view threw it away.

### Why the fix had to go into the store

Deleting the flag alone would have introduced a genuine defect. `identityFor` stamps `baseVersion`
from the **projection**, so a second tap that computes its identity before the first tap's row is in
`queue` stamps a version the server has already consumed — `ORDER_VERSION_CONFLICT`, and a queue
halted over a race the operator never caused. The `busy` flag was serializing the local phase as a
side effect of disabling the screen, and nothing else was.

So the ordering moved to where it belongs. `enqueue` split into `stage` (validate, `savePending`,
`refreshQueue`) and `settle` (sync, or `attemptOnce` on a storage-less device), and `serialize()`
chains only the _local_ phase. `command()` runs its halt check, `identityFor` and `stage` inside one
link, because all three read the projection. The network attempt is deliberately outside the chain —
that is the whole point. Public promise semantics are unchanged, so the 153 existing tests were
untouched.

`test/rush-taps.test.ts` drives the store the way the screen now does, without awaiting. Confirmed
it pins the defect by disabling `serialize` and re-running: `[3, 3, 3, 3]` instead of `[3, 4, 5, 6]`.

### BAR-1

`/pos/:terminalId` already routed `bar-1`; what was missing was that **nothing in the UI linked
anywhere but POS-1** — the demo driver typed URLs. A terminal switcher is most of what "wired up"
meant. `TerminalDescriptor` gained `profile`, and `BAR_MENU` sits beside `TERMINALS` in contracts
rather than becoming a `category` column: a column would be a migration + contract + API + seed
change to drive one client-side filter that no server code would ever read. `profile` is projected
out of the seed's `terminals` insert for the same reason. Four drinks were added to the seed so a
filtered bar screen is a screen and not two tiles.

### What the browser said

Driven at 1024 × 768, on `PUSH`, with `fetch` delayed 1.5 s for mutation POSTs.

- Six taps issued as fast as they could be clicked: six mutations, `v7`, **nothing greyed out**, tile
  badges and total tracking every tap, queue drained to zero with no conflict. Under the old flag
  the same run would have been six sequential 1.5 s waits.
- BAR-1 in one tap: drinks only, amber, tabs not tables. A reload restored the open tab (§14).
- Caught one defect in the browser that no test would have: covers read `Tab 2` and the heading
  prefixed the noun again — `Tab Tab 2`. Covers are bare values now, and a test says so.
- The conflict banner was proved on a real race — POS-1 offline at v2, a `curl` mutation as POS-2
  advancing the server to v3, POS-1 back online. Headline, two large buttons, evidence one tap below
  and complete. Rebase reapplied the line on top of POS-2's, `v4`.

### Two defects found in M12, not fixed here

The `Create Version Conflict` switch tampers `baseVersion - 1`, which on an order at v1 sends 0 and
is refused by zod as invalid rather than conflicting; and `spend()` only runs if the POST _returns_,
so that failed tamper leaves the arm armed and wedges every later mutation from the tab. Both are in
`known-problems.md` — they are M12's code, not this milestone's, and they are one pass together.

### The Codex review of M15

Five P1s, all one family: the serialization moved into the store, but **not everything that reads
the projection moved with it**. My own review pass checked that `identityFor` was inside a link and
stopped there. Three fixed here, two logged.

**[P1, fixed] The steppers computed their absolute quantity in the template.**
`changeQuantity(item.productId, item.quantity + 1)` read the _rendered_ row. `CHANGE_QUANTITY`
carries an absolute value on purpose (M8: a delta sent twice after a lost response applies twice),
so with taps no longer waiting, one `+` could overwrite every add still queued behind it, and two
quick `+` both sent the same number — 1 → 2 instead of 1 → 3. The wire format has not changed; what
changed is _where_ the absolute value is computed. `command()` now takes a **plan** — a function
evaluated inside the serialized link — and `stepQuantity(productId, delta)` resolves the line from
the projection there, including the below-one case that becomes `REMOVE_ITEM`. The template passes
a delta and knows nothing else. Confirmed the tests pin it: capturing the line before the link
turns 1 → 2 → 3 back into 2, 2, and three tests fail.

**[P1, fixed] The order pointer moved outside the chain.** `createOrder` set `currentOrderId` and
called `setCurrentOrder` before enqueueing, so opening the next cover while the last taps were still
staging re-pointed them mid-flight — stamped for an order whose `CREATE_ORDER` was queued _behind_
them, halting on a missing aggregate. Both `createOrder` and `clear()` now do their pointer work
inside a `serialize` link, so earlier taps finish against the order they were rung up on. `command()`
also captures the intended order at invocation and refuses if it no longer matches — a guard, not
the mechanism: on its own it would _drop_ the tap, which is why the pointer move had to be
serialized too. Confirmed: moving the pointer back outside leaves only `CREATE_ORDER` in the queue.

**[P1, fixed] `committing` did not close the item controls.** Send, Pay and Cancel set the flag on
the press but are staged a link later, and `can.order` still said OPEN in that gap — an item tap
landing there is queued behind the status change, where §8 refuses it and halts the order over
something the operator could not have known. `canTouchItems = can.order && !committing` now gates
every tile, stepper and Remove. Item taps still never set the flag, so they still never disable each
other. Verified in the browser: on the Send press every item control greys out at once, while the
mutation is still in flight.

**Not fixed, logged as `[M15, P2]`:** same-millisecond rows have no deterministic sort key
(pre-existing, already noted in `sync-engine.test.ts`, but M15 makes collisions likelier); and the
storage-less `attemptOnce` fallback is outside the chain, so on a device with no IndexedDB rapid
taps still share a `baseVersion`. Both need their own change and neither is what M15 introduced.

`enqueue()` fell out as dead code once `createOrder` staged inline, and was deleted. 181 web tests.

## M16 — `/demo`, the guided walkthrough

The ten §19 scenarios became **data** (`apps/web/src/domain/demo-script.ts`), rendered by
`DemoView.vue`, with **one** `SimulatorPanel` at the foot rather than a second set of buttons —
`/debug` already renders those eleven controls and they are the same module state. A step names a
control and links to its row by anchor; the control names now come from one `CONTROL_LABELS` map
that the panel's buttons read too, because a step saying "press X" beside a button reading "Y" is
the single defect this milestone cannot ship.

`demo-script.test.ts` reads the **real** `SimulatorPanel.vue` and `router.ts`, not a copy of what
they are believed to contain: every control a step names must have an anchor on the panel, and every
route a step links to must exist in the router.

**Two M12 defects fixed, both in `Create Version Conflict`, both named in advance by M15's handoff.**
The arm sent `baseVersion - 1` from v1, and `mutation-routes.ts` validates an existing order's
version as `min(1)` — so it produced a 400 `VALIDATION_ERROR` and halted nothing. The threshold is
now v2. And `spend()` ran only after `postMutationTo` returned, so that 400 left the arm armed and
tampered with every later mutation from the tab; it is now spent on an `ApiRequestError` too — the
server answered — but still not on the offline gate or a dead socket, which is what the original
guard was for.

**`onBeforeUnmount` stopped calling `clear()`.** M15's handoff left this as a deliberate decision and
it turned out to be load-bearing: the one-shots are armed on `/demo` and live in the tab (ADR 015),
so with the order dropped on every route change an arm could only ever be spent on the `CREATE_ORDER`
a re-emptied till has to start with — three of the eleven controls were undemonstrable on an item.
The new `detach()` drops the in-memory view and leaves the pointer on disk for the next `hydrate()`.
It cannot simply skip the clear: the store outlives the component, and POS-1's order sitting in
`order.value` while POS-2 mounts would be drawn on POS-2 until its own read answered. `clear()` is
untouched and still what **New table** means.

### What the browser found that the tests could not

Four defects, all in the first walk, none reachable from a unit test:

- **A route badge rendered black on black.** `styles.css` had `a { color: inherit }` _unlayered_, and
  in Tailwind v4 unlayered CSS beats a layer whatever its specificity — so it had been overriding
  every `text-*` utility on a link since M1. `/demo` is the first page to put one there. Both anchor
  rules moved into `@layer base`.
- **The scenario claim rendered raw backticks** — it was plain interpolation while every other field
  went through `renderInline`.
- **Two steps named Table 8 and Table 9, which are not on the cover pad** (`coversFor('dining')` is
  1–6, 11, 12). Exactly the "improvisation" the milestone is judged on. Now tested against
  `coversFor`.
- **Three single-asterisk emphasis spans** reached the reader as literal asterisks; `renderInline`
  knows `**bold**` and backticks only. Now tested.

**And one the walk disproved outright.** §19.3's last step claimed the conflict row gains a
resolution after a Rebase. It does not: `conflict_log.resolution` is written `null` by the handler
and **nothing anywhere updates it**, because Discard and Rebase happen in the browser and are never
reported back. So `blockedMutations` only climbs, under a note calling it "a client queue still
halted". The step now says that, and says to read the `BLOCKED` badge for the live answer — a
counter and a gauge are different things. Logged as `[M16, P2]`; the endpoint that would fix it is
new API surface and not this milestone's.

Three scenarios walked end to end against a real stack, reading only the page. §19.4: the arm
survived the walk, the till kept Table 4, one tap advanced the version by exactly one,
`duplicateMutationsPrevented` +1 while `mutationIdReuseRejected` stayed at 0. §19.7: paused, sent an
order, backlog to 7 rows and 86 s, no ticket on the kitchen, resumed, drained to 0 and the ticket
appeared. §19.3: armed, the create at v0 and the first item at v1 both declined, three fast taps →
`ADD_ITEM` sent at v1 against a server at v2, two `BLOCKED` behind it, the evidence panel listing
every `mutationId` and `baseVersion`, and a Rebase that reapplied all three to v5.

§19.10 is named as the test it is (`pnpm verify:multi`); §19.9's manual retry is named as the CLI it
is. `PlaceholderView.vue` had no remaining reference and was deleted. 202 web tests.

### M16 review round — Codex, two P1s

**[P1, fixed] The guided page forgot which scenario you were on.** `selectedId` was a `ref` in
`DemoView.vue`, and six of the ten scenarios route to a till or to `/debug` and back — every one of
those round trips unmounts the view, so the reader came back to §19.1 and had to hunt for the
scenario they were three steps into. Precisely the improvisation M16 exists to remove, and I had
seen it during the browser walk and misattributed it to HMR reloading the module.

The selection moved into the query (`/demo?scenario=duplicate-mutation`) as a writable `computed`
over `route.query`, so there is no ref to fall out of sync with the URL and no watcher loop. A query
parameter rather than the hash, because the hash is already how a step jumps to a control's row.
Unrecognised values fall back to §19.1 rather than blanking the page. And `linkTo()` makes a step's
own "come back here" link carry the selection, which the browser's Back button gives for free but a
`RouterLink` to a bare path does not. Verified: select §19.4, follow `/pos/pos-1`, come back by
either route, still §19.4 — and `/demo?scenario=kitchen-race` is now a link you can hand to someone.

**[P1, fixed] §19.8 raced the wrong button.** The scenario set up a ticket in **New** and then had
both displays press **Start preparing**. That is a real race on the same version guard, but §19.8 is
_"both press Ready"_, and from `New` the card offers `Start preparing` and nothing else —
`COMMAND_LABELS` maps `SENT_TO_KITCHEN → preparing` and `PREPARING → ready`. So the scenario as
written could not perform the clause it was named after. A setup step now moves the ticket to
**Preparing** in one window, says out loud that it is setup and why, and the race is on **Mark
ready** from a version both displays hold.

Guarded where guarding is possible: `demo-script.test.ts` now asserts `DemoView.vue` reads
`route.query.scenario` and that the step link goes through `linkTo`. The suite has no component
harness, so this is a source assertion in the same family as the existing panel-anchor checks — a
rule this easy to undo by accident should not be unguarded. 203 web tests.

---

## M17 — PWA

**The gap M17 closes is narrower than "make it work offline".** That part has worked since M8: the
queue and the last snapshot are Dexie's (ADR 013). What did not work was _reloading_ while offline —
index.html, the JS and the CSS come from the server, so the tab never reached the code that knows
how to be offline. So the worker caches the shell and deliberately stops there; ADR 017 records why
it must not grow a second copy of the data.

**The policy is a pure module, and it is an allow-list.** `src/sw/cache-policy.ts` has no `fetch`,
no `caches`, no DOM and no imports, so `cache-policy.test.ts` runs it in Node and walks every
endpoint in `src/api/client.ts` asserting `passthrough`. `passthrough` is not a strategy that
fetches — the handler returns without calling `respondWith`, so the request is performed by the
browser as if nothing were installed. Non-`GET` is decided before any path is looked at, and there
is a test that reordering that check breaks. `/api/menu` is the single cached API response.

**Built as a second, nested Vite build** (`vite/service-worker-plugin.ts`, `apply: 'build'`) rather
than a second `rollupOptions.input`: an app entry is an ES module that shares code-split chunks and
would need `{ type: 'module' }` registration. `lib` + `iife` gives one self-contained classic script
at a stable `/sw.js`, and `define` injects the per-build cache name. It needed `tsconfig.sw.json`,
because `WebWorker` and `DOM` declare `self`, `fetch` and `caches` with different types and cannot
share a `lib` array — hence also the one cast in the worker, `self as unknown as
ServiceWorkerGlobalScope`.

**The icons are generated by a committed script.** `apps/web/scripts/make-icons.mjs` writes the
three PNGs with `zlib` and about eighty lines of pixel arithmetic — a header, one IDAT of filter-0
scanlines, an IEND. Three flat-colour icons did not justify a native `sharp`/`canvas` dependency in
a repository whose selling point is that it installs on a laptop nobody configured.

**The browser check could not be run, and that is written down rather than glossed.** The session's
browser pane refuses to register any service worker: a one-line probe worker failed with the same
"unknown error occurred when fetching the script" while `fetch('/sw.js')` from the same page
returned 200 and the right content type, and no external Chrome was connected. Manifest, all three
icons at their declared sizes, and the production bundle itself were verified there through
`pnpm -F @pos/web preview` (added in this milestone — the worker only exists in a production build,
so :5173 cannot exercise it). The worker's own behaviour is covered instead by
`test/service-worker.test.ts`, which drives the real `install`/`activate`/`fetch` handlers against a
fake `CacheStorage` and a fake network: the shell falls back to the cached document when the network
is gone, `activate` drops the previous build's cache, the menu serves stale then revalidates, and a
`POST .../mutations` is neither answered nor stored. The remaining hands-on check is the first
entry in the M17 backlog, with the exact steps.

**Review pass: no P1.** Four findings, all P2/P3, in `known-problems.md`.

### M17, Codex round — the first install cached the document but not the bundle

**[P1, fixed] Runtime caching cannot see the load that installs the worker.** The milestone brief
argued against a precache manifest on the grounds that "the hashed bundle is cached as it is fetched
by the very load that installed this worker". That sentence is wrong, and it was wrong in exactly
the case M17 exists for. Registration happens on `window.load`, by which point the page has already
fetched its JS and CSS; the worker did not exist for those requests and `clients.claim()` does not
replay them. First install → `hadController` is false, so no reload → the tab is controlled by a
worker holding only `index.html`. Offline hard reload then served the cached document, whose script
missed `cacheFirst` and rejected: a blank app. Every unit test passed throughout, because each one
had already primed the cache through the worker.

The fix keeps the reasoning that motivated the original decision. `install` fetches `index.html`
with `cache: 'reload'`, caches it, and **reads the asset list out of that HTML** —
`shellAssetUrls()` in `cache-policy.ts`, a regex over `src=`/`href=` whose every hit is re-checked
through `classifyRequest` and kept only if the policy calls it an `asset`. So the precache list
cannot be wider than the allow-list, and there is still no generated file threaded through the build
to go stale. Assets are `Promise.allSettled` — only a missing document may fail the installation,
because a single 404 must not leave the worker stuck `installing`. Checked against the real
`dist/index.html`: the list is the two emitted bundle files plus the manifest and the icon.

**[P2, fixed with it] A navigation to a real resource poisoned the shell entry.** `mode ===
'navigate'` was tested before the path, so a tab pointed straight at `/api/health/ready` was
classified `shell` and its JSON written under `/index.html` — after which the next offline POS load
renders a health check. The navigate branch is now **last**: a path that names a real resource is
that resource whatever the mode, and only paths that resolve to the document reach it. Fixed in the
same pass because it corrupts the one cache entry the P1 fix depends on.

Codex's third finding — the menu revalidation not held by `event.waitUntil`, so the browser may kill
the worker mid-refresh — is correct and is in the backlog. Eleven seeded products that change with
the seed do not justify reopening the round. 246 web tests.

### M17, browser round — the hands-on check, and the P1 only a real browser could show

The check the milestone could not run was run, by driving a real Chrome over CDP from a throwaway
script: launch on a fresh profile with `--remote-debugging-port`, attach to the page target,
and — crucially — **make it offline by killing the preview server**, not by DevTools throttling,
which does not reliably reach the worker's own fetches.

**[P1, fixed] `Vary: Origin` made the precached bundle invisible to the page.** The first offline
reload served `index.html` from the cache and then failed both `/assets/*.js` and `/assets/*.css`
with `ERR_FAILED`: title correct, `#app` empty, nothing rendered. `Cache.match` honours the cached
response's `Vary` by comparing the _stored request's_ headers with the incoming one's. `precacheShell`
fetches from inside the worker, where there is no `Origin`; the page then asks for the same bundle
through `<script crossorigin>`, which sends one. Vite's preview server answers `Vary: Origin`, so
the two did not match and the fallback `fetch` hit a dead server. Every cache read now passes
`{ ignoreVary: true }`, which is correct and not merely convenient here — one representation per
URL, and for `/assets/` the content hash is the name.

The first attempt to diagnose it lied: `cache.match(new Request(url, { mode: 'cors' }))` from the
page _hit_, because a Request constructed in JS carries no `Origin` until it is actually sent. What
settled it was `Network.responseReceived` / `Network.loadingFailed` with `fromServiceWorker`, which
showed the document served by the worker and the script not served at all.

**The fake `CacheStorage` now models `Vary`**, so this class of defect is a test rather than a
browser session: the new case fails without `ignoreVary` and passes with it — verified by flipping
the constant.

**[P1, fixed] `registration.update()` threw an uncaught rejection offline** — "Failed to update a
ServiceWorker … unknown error occurred when fetching the script" — because it was `void`ed instead
of chained, so the `catch` below never saw it. A red error in the console of exactly the scenario
the worker exists for. Returned into the chain.

**Verified end to end, server killed:** document, stylesheet, script, manifest and icons all served
by the worker; the app mounts; **Table 5, Burger ×2, $24.00, V3** still on screen after an ordinary
reload, a fresh navigation, and a hard reload alike; the header degrades to `WS DISCONNECTED` with
the designed `READ FAILED` banner. On restart: `WS CONNECTED`, `PUSH`, order intact. Chrome parsed
the manifest with **no errors** and the cache held exactly `/index.html`, both `/assets/` files,
the manifest and the icon.

One gap stays and is in the backlog: `/api/menu` is fetched by the uncontrolled first load, so the
product grid is empty after an offline reload until the app has been loaded once more. 247 web tests.

**Then `/api/menu`, which lost the same race.** The product grid was empty after an offline reload
for exactly the reason the bundle was: the first page load fetches the menu before the worker
controls anything, so runtime caching never sees it. `precacheShell()` now adds it beside the
document's assets, and `MENU_PATH` is exported from `cache-policy.ts` so the path is not written
twice. It is not a hole in "the worker owns the shell, never data": it is the one API response on
the allow-list, it is the seeded product list rather than anything a terminal owns, and the order
stays Dexie's. Best-effort like the assets, so an API that is down while the static server is up
cannot leave the worker stuck `installing` — that case is a test.

Confirmed in Chrome with the server killed: the cache holds `/api/menu`, the offline reload serves
it `fromServiceWorker`, and the reloaded page draws all eleven products beside the surviving order.
250 web tests.

**And the last of Codex's three: the menu revalidation is now held by `event.waitUntil`.**
Answering from the cache settles the `respondWith` promise, which ends the event's lifetime, and a
worker with no pending work may be killed at any moment — taking the refresh with it and leaving
the menu stale for good. `staleWhileRevalidate` takes the `FetchEvent` rather than the `Request`
and registers the refresh on it. Legal at that point because the event is still active: the promise
handed to `respondWith` has not settled. The `catch` stays and now does two jobs — offline the
refresh rejects, and a rejected promise given to `waitUntil` fails the event.

**Writing the test exposed a hole in the harness.** `dispatch` awaited `Promise.all(pending)`, which
snapshots the array — but a handler registers `waitUntil` only after its first `await`, so the
menu's refresh was pushed _after_ the snapshot and never awaited. The first version of the
rejection test therefore passed with the `catch` removed. `dispatch` now drains in waves until no
new promise appears, and both halves of the fix were verified by flipping them: without `waitUntil`
one test fails, with `waitUntil` but no `catch` two do. 251 web tests.

## M18 — Playwright E2E

§21's last line, and the one test that crosses every process. It went in without a fight; the
interesting part is what the _harness_ had to learn, which is that a test needing running
applications is a different problem from a test needing running infrastructure.

**`lib/compose-run.mjs` grew `startService`, `waitForOutput`, `waitForHttp` and `crashedServices`.**
The two existing runners only ever run steps that finish. This one needs an API and a worker that
do not, so the runner now owns long-lived children and stops them in `finish()` before the Compose
teardown — including under `--keep`, which is about containers a developer wants to poke at and was
never about leaving an API holding `:3000`. They are spawned **without** `shell: true`, unlike
`run`: a shell wrapper on Windows means `kill` reaps the wrapper and leaves the real process on the
port. And `stop()` sets a flag before it kills, because on Windows `kill` is a terminate and the
exit code is always 1 — without it every clean run ended in `exited with code 1`.

**The first run reported FAIL with the spec passing, and it was right to.** `EADDRINUSE
127.0.0.1:3000`: the user's API from the previous session was already there, so the child this
script started lost the bind and shut down — while the spec sailed through against the _incumbent_.
That is the whole reason `crashedServices()` exists rather than trusting Playwright's exit code.
The fix is the courtesy `snapshot()` already extends to containers: probe `/api/health/ready` for
two seconds first and reuse what answers, saying so in the RESULT line. `waitForHttp` grew an
`optional` flag so a probe that finds nothing reads as an observation rather than as a failure.
The residue is a P2 in `known-problems.md` — a reused API may be running code this run did not
build.

**Then the third trial run failed, and it was the most useful failure of the milestone.** The
ticket never appeared: `brokerConnected: false` for the whole run, the `kitchen` group still
rebalancing when the 45 s assertion gave up. Run 1 had joined after 14.8 s, run 2 after 28.5 s,
run 3 not at all — an escalation, which is the shape of a leak rather than of a slow machine.

The cause is in the harness, not the pipeline: **on Windows `child.kill()` is `TerminateProcess`, so
the worker never runs its shutdown and never sends `LeaveGroup`.** Its place in the group is held
until the session times out (30 s), and while a rebalance is in flight _no member consumes_ — so
each run inherited the previous run's zombie and paid for it out of the spec's budget. Each run
also created the next one.

The fix is to charge it to the right account. `Worker started` is liveness — the broker connection
is supervised behind it — so the script now also waits for `broker connected`, and for the API's
`realtime consumer running` when it started the API itself, with a 120 s budget named
`GROUP_JOIN_TIMEOUT_MS`. A group join is setup; only what happens after the assignment exists is
the pipeline's, and `PIPELINE_TIMEOUT_MS` is now honestly a poll interval plus a broker round trip.
Making the kill graceful would be the deeper fix and needs a shutdown channel the worker does not
have; the residue is a P3.

Worth keeping in mind: none of this bites CI, where the kill is a real SIGTERM and each run gets a
fresh broker.

**No test hooks in the production markup.** Locators are roles, labels and text; the product name
is read out of a tile's `aria-label` rather than hard-coded, because the menu is seed data. The
kitchen card is found by a cover unique to the run — the rail accumulates across runs and the demo
database is deliberately never reset. The two POS assertions before `Send to kitchen` prove the
_client_ (§14 draws the queue folded onto the last snapshot, so `SENT_TO_KITCHEN` appears before
the server has answered); the `PENDING` badge going away is what says the server took all three;
and `PREPARING` arriving back on the POS is the only assertion here that no single process could
satisfy on its own.

**One P1 from the review pass, mine.** Every return path in the script goes through
`runner.finish`, which stops the children — except a throw. An orphaned worker holds a place in the
`kitchen` group, so this run's crash would be paid for by the next run's rebalance. Wrapped.

Green: `pnpm test:e2e` PASS, lint, typecheck (three projects now — `tsconfig.e2e.json` exists
because Playwright resolves like a bundler), build, 251 web tests.
