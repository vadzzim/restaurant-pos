# Spec — Restaurant POS Distributed Systems Demo

Distilled from `prompt_01.md` + `prompt_02.md`, then revised after an external design review.
**This is the canonical requirements document.** The original prompts are never read again.

## 0. Goal

A technically convincing demo for a Lead Full-Stack Engineer (Node.js & Vue) interview at
IDT / NRS. It demonstrates: offline-first architecture, concurrent editing from multiple
terminals, optimistic concurrency control, idempotent APIs, transactional outbox,
Kafka-compatible event streaming, idempotent consumers, WebSockets, reconnect synchronization,
domain conflict resolution, PostgreSQL transactions, Redis, IndexedDB, observability,
failure simulation, and safe delivery.

The guiding design assumption:

> Networks fail, clients retry, messages may be delivered more than once, processes crash,
> users work offline, WebSocket messages may be missed, and two devices may concurrently
> modify the same business entity.

The system must make these failure modes **explicit, observable and safe**.

None of the following may be faked. All of it must actually work: IndexedDB storage, offline
mutations, sync after reconnect, version conflicts, idempotency, PostgreSQL transactions, the
outbox, publishing to Redpanda, idempotent consumers, WebSocket updates, two terminals modifying
the same order.

Where a pattern cannot be honestly implemented — a WebSocket emit cannot be transactional with a
database write — the spec says so explicitly rather than pretending. See §12.

## 1. Stack

**Frontend:** Vue 3, TypeScript, Vite, Pinia, Vue Router, Tailwind, Dexie.js (IndexedDB),
Socket.IO client, PWA.

**Backend:** Node.js, TypeScript, **Fastify** (modular architecture; NestJS only if it materially
simplifies things — by default it does not), zod, pino.

**Data:** PostgreSQL + **Drizzle ORM**, chosen so that concurrency-sensitive SQL stays explicit.
Real migrations.

**Infrastructure:** Redis, **Redpanda** (Kafka-compatible broker), Docker Compose, GitHub Actions.

**BullMQ** is used for exactly one thing: the kitchen ticket printing job (§12.3), which is
**at-least-once and may print a duplicate ticket** — see §12.3 for why that is the right choice
and not a gap. It is deliberately **not** used for outbox retries — see §10.

Exactly three application processes: `web`, `api`, `worker`. Do not create more.

## 2. Repository

pnpm workspaces, monorepo:

```
apps/api  apps/web  apps/worker
packages/contracts  packages/domain  packages/config
docs/  docker-compose.yml  pnpm-workspace.yaml  .github/workflows/
```

Shared DTOs, events and types live in `packages/contracts`. Pure domain logic — conflict rules,
status transitions, total calculation — lives in `packages/domain` with no dependency on the
database or HTTP.

The backend is structured by domain, not by technical layer:

```
apps/api/src/modules/{orders,kitchen,sync,events,debug}/{domain,application,infrastructure,api}
apps/api/src/shared/
```

## 3. Domain

Two restaurants in the seed, so that multi-tenancy is concrete rather than hypothetical:
`Demo Restaurant` and `Second Restaurant`.

Terminals: `POS-1`, `POS-2` and `BAR-1` in `Demo Restaurant`, plus `POS-3` in
`Second Restaurant`. The second-tenant terminal is not decoration — it is what makes the
cross-tenant rejection (§21.11) and the per-restaurant feature-flag rollout (§15) demonstrable
rather than theoretical.

Menu, in cents: Burger 1200, Cheeseburger 1400, Pizza 1500, Caesar Salad 1000, French Fries 500,
Cola 300, Coffee 400.

**Order is the consistency boundary (the aggregate).**

```ts
type OrderStatus = 'OPEN'|'SENT_TO_KITCHEN'|'PREPARING'|'READY'|'PAID'|'CANCELLED';

interface Order {
  id: string; restaurantId: string; tableNumber: string;
  status: OrderStatus; version: number; totalCents: number;
  createdAt: string; updatedAt: string;
}
interface OrderItem {
  id: string; orderId: string; productId: string;
  name: string; quantity: number; unitPriceCents: number;
}
```

Money is integer cents only.

**Tenant scoping is mandatory.** Every mutation carries a `restaurantId` and the handler verifies
it matches the order's own `restaurant_id`. A mismatch is rejected with
`403 CROSS_TENANT_MUTATION` before any version check. This is not authentication — it is a
consistency guard, and it is tested (§21.11).

## 4. Database schema

Tables: `restaurants`, `terminals`, `products`, `orders`, `order_items`, `payments`,
`processed_mutations`, `outbox_events`, `processed_events`, `kitchen_tickets`, `conflict_log`,
`feature_flags`, `print_jobs`.

- `orders`: plus `version int not null default 1`, `status`, `total_cents`, FK to restaurant.
- `processed_mutations`: `mutation_id (unique)`, `terminal_id`, `order_id`, `request_hash`,
  `result_json`, `processed_at`.
- `outbox_events`: `id`, `aggregate_id`, `aggregate_type`, `event_type`, `event_version`,
  `payload jsonb`, `created_at`, `published_at nullable`, `attempt_count`,
  `next_attempt_at`, `last_error`, `dead_lettered_at nullable`,
  plus the lease columns `claimed_by nullable` and `claim_until nullable` required by §10.
- `processed_events`: `event_id`, `consumer_name`, `processed_at`;
  **unique(event_id, consumer_name)**.
- `kitchen_tickets`: the kitchen read model built by the kitchen consumer — `order_id (unique)`,
  `restaurant_id`, `table_number`, `items jsonb`, `state`, `source_event_version`,
  `created_at`, `updated_at`. This is a real projection, which is what makes the consumer's
  idempotency demonstrable (§12.1).
- `conflict_log`: `id`, `order_id`, `terminal_id`, `mutation_id`, `mutation_type`,
  `client_base_version`, `server_version`, `server_status`, `resolution`, `created_at`.
- `payments`: linked to the originating mutation so a repeated `PAY` cannot create a second
  payment.
- `feature_flags`: `key (unique)`, `enabled`, `rollout_percent`, `updated_at`.
- `print_jobs`: `id`, `order_id`, `ticket_hash`, `state`, `attempt_count`, `last_error` —
  the durable record behind the BullMQ print job. It records what we *believe* was printed;
  it cannot know what physically emerged from the device (§12.3).

Index intentionally, only against real query patterns: `orders.restaurant_id`, `orders.status`,
`outbox_events` partial index `where published_at is null and dead_lettered_at is null`
ordered by `next_attempt_at`, `processed_mutations.mutation_id`,
`processed_events(event_id, consumer_name)`, `kitchen_tickets(restaurant_id, state)`.
Do not index every column blindly.

## 5. Mutation protocol

One canonical entry point for **every** order state change, including kitchen transitions:

```
POST /api/orders/:orderId/mutations
{ "mutationId": "uuid", "terminalId": "pos-1", "restaurantId": "...", "baseVersion": 7,
  "type": "ADD_ITEM", "payload": { "productId": "burger", "quantity": 1 } }
```

Types:

```
CREATE_ORDER | ADD_ITEM | REMOVE_ITEM | CHANGE_QUANTITY | SEND_TO_KITCHEN
START_PREPARING | MARK_READY | PAY | CANCEL
```

`START_PREPARING` and `MARK_READY` are full mutations with `mutationId` and `baseVersion`, not a
side door. Two kitchen displays pressing "Ready" concurrently must produce one success and one
conflict, exactly like two POS terminals. The kitchen HTTP endpoints in §17 are thin adapters that
construct these mutations and call the same handler.

**Order creation is a mutation too, for the same reason.** A creation endpoint outside the protocol
would be the one unprotected write in the system: a lost HTTP response followed by a client retry
would create two orders. So the **client generates the `orderId`** (a UUID) and creation is
`CREATE_ORDER` with `baseVersion: 0`, submitted to `POST /api/orders/:orderId/mutations` like
everything else. A retry hits the same `mutationId` and returns `ALREADY_APPLIED`; the same
`orderId` arriving with a different `mutationId` and identical content returns the existing order;
different content is a conflict.

This also buys something the demo needs: a terminal can **create an order while offline**, because
creation is just another queued mutation rather than a round trip that has to succeed first.

Responses:

```
200 { "status": "APPLIED",         "order": {...}, "serverVersion": 8 }
200 { "status": "ALREADY_APPLIED", "order": {...}, "serverVersion": 8 }
409 { "status": "CONFLICT", "reason": "ORDER_CANCELLED",
      "clientBaseVersion": 7, "serverVersion": 8, "canonicalOrder": {...} }
409 { "status": "MUTATION_ID_REUSED", "reason": "PAYLOAD_MISMATCH" }
403 { "status": "REJECTED", "reason": "CROSS_TENANT_MUTATION" }
```

## 6. Optimistic concurrency

Every order carries a `version`. Updates are guarded by a version comparison in explicit SQL:

```sql
UPDATE orders SET version = version + 1, updated_at = now()
WHERE id = $1 AND version = $2;
```

Zero affected rows means: read the current state and return an appropriate domain conflict.
Silently overwriting newer state is forbidden.

## 7. Transaction boundaries

One transaction per mutation:

```
BEGIN
  tenant scoping check (restaurantId matches the order)
  idempotency check (processed_mutations, including request_hash comparison)
  domain rule validation against current state
  UPDATE orders ... AND version = baseVersion
  order_items change / payment insert
  INSERT processed_mutations
  INSERT outbox_events
COMMIT
```

Never call external services from inside a transaction. Do not hold long transactions.
Publishing to Kafka directly from the HTTP transaction is forbidden.

## 8. Conflict resolution rules

These live in one domain component (`packages/domain`), never scattered across controllers.
Generic last-write-wins is unacceptable.

- **There is no automatic merge.** Any mutation whose `baseVersion` is stale returns `409`,
  including two independent `ADD_ITEM`s that would in principle commute. An earlier draft promised
  to "merge independent additions where safe", which contradicted the strict versioned UPDATE in
  §6 — a stale `baseVersion` never matches, so the merge could never have run. Merging happens
  only through the explicit rebase in §14.1, driven by a human.
  Server-side replay of provably commutative operations is a real alternative, and it is the road
  not taken: it is a small CRDT, it is where subtle bugs live, and it quietly reintroduces
  last-write-wins for the cases it gets wrong.
- `CANCELLED`: reject `ADD_ITEM`, `REMOVE_ITEM`, `CHANGE_QUANTITY`, `SEND_TO_KITCHEN`,
  `START_PREPARING`, `MARK_READY`, `PAY`.
- `PAID`: reject any modification.
- Concurrent quantity change to the same item: return a conflict; server state is canonical.
- `SEND_TO_KITCHEN` after cancellation: reject.
- Kitchen transitions must follow the status order: `START_PREPARING` requires
  `SENT_TO_KITCHEN`; `MARK_READY` requires `PREPARING`. Out-of-order transitions conflict.
- Item mutations after `SENT_TO_KITCHEN`: reject — the kitchen is already cooking. This is the
  domain rule that makes the offline conflict scenario realistic rather than contrived.
- A stale operation already reflected in server state: treat as idempotent where semantically safe.

Every conflict is written to `conflict_log` and shown in `/debug`.

## 9. Idempotency

A client-supplied `mutationId` plus a unique constraint on `processed_mutations.mutation_id`.
A repeat of the same mutation returns the previously stored result and **does not apply the
effect twice** — no duplicated items, payments or events. The `processed_mutations` insert is
atomic with applying the change.

`request_hash` is a hash of `(type, payload, orderId)`. If a `mutationId` arrives again with a
**different** hash, that is a client bug or an id collision, not a retry: reject with
`409 MUTATION_ID_REUSED` and never return the cached result. Returning the cached result for a
different request would silently drop a real operation.

A repeated `PAY` must not create a second payment.

## 10. Transactional outbox

The order change and the event insert happen in the same transaction. A separate worker then
publishes, in **three short steps with no network call inside a transaction** — §7 forbids that,
and holding `FOR UPDATE SKIP LOCKED` across a Kafka round trip would violate it:

```
-- step 1: claim a batch by lease, then COMMIT immediately
BEGIN
  UPDATE outbox_events SET claimed_by = :workerId, claim_until = now() + :leaseTtl
  WHERE id IN (
    SELECT id FROM outbox_events
    WHERE published_at IS NULL AND dead_lettered_at IS NULL
      AND next_attempt_at <= now()
      AND (claim_until IS NULL OR claim_until < now())
    ORDER BY next_attempt_at
    LIMIT :batch
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
COMMIT

-- step 2: publish to Redpanda, outside any transaction

-- step 3: another short transaction marks published_at, or records the failure
```

`SKIP LOCKED` keeps two workers off the same row during the claim itself; the lease keeps them off
it during publication. A worker that crashes mid-publish leaves a lease that simply expires, and
the row becomes claimable again.

**The consequence is explicit and accepted: publication is at-least-once.** A crash between
step 2 and step 3 republishes the event on the next pass. That is exactly why consumers are
idempotent (§12) and why §21.12 tests this specific window. The alternative — holding a database
lock open across a broker call — trades a duplicate for a stalled connection pool, which is worse.

**Retries live in PostgreSQL, not in a second queue.** On failure the worker increments
`attempt_count`, records `last_error`, and sets `next_attempt_at` with bounded exponential
backoff. After a configured attempt ceiling the row is dead-lettered (`dead_lettered_at`) and
surfaced in `/debug` — it is never dropped.

An external review correctly noted that adding BullMQ here would introduce a second source of
truth for the same retry: the job could say "retry" while the row says "published". PostgreSQL is
already a durable queue with the transactional guarantee we need, so it owns this. BullMQ's real
use is §12.3. This trade-off is written up in `docs/adr/010-db-outbox-retries.md` and is a
deliberate interview talking point.

Document why the outbox solves the database/Kafka dual-write problem.

## 11. Events and topics

Envelope in `packages/contracts`:

```ts
interface DomainEvent<T = unknown> {
  eventId: string; eventType: string; aggregateId: string; restaurantId: string;
  version: number; occurredAt: string; traceId?: string; payload: T;
}
```

Events: `OrderCreated`, `OrderItemAdded`, `OrderItemRemoved`, `OrderQuantityChanged`,
`OrderSentToKitchen`, `OrderPreparing`, `OrderReady`, `OrderPaid`, `OrderCancelled`.

Topic `restaurant.order.events`, **partitioned by `orderId`**, which preserves event ordering
within a single order. State explicitly in the docs: Kafka guarantees ordering only inside a
partition; make no claim about global ordering.

## 12. Consumers

Two consumers, with honestly different guarantees. `processed_events` carries
unique(event_id, consumer_name) for both.

### 12.1 Kitchen consumer — transactional, genuinely idempotent

Its side effect is a database write, so the full pattern holds:

```
BEGIN
  check the event has not been processed (processed_events)
  upsert kitchen_tickets (the projection)
  INSERT processed_events ('kitchen', event_id)
COMMIT
```

Already processed means: skip safely and increment "duplicate events prevented". The projection
is what `/kitchen` reads. Because the effect is a real row, replaying an event and observing that
the ticket does not change is a genuine demonstration, not a claim.

Events arriving out of version order are ignored when `event.version <=
kitchen_tickets.source_event_version`, so redelivery cannot move the projection backwards.

### 12.2 Realtime consumer — at-least-once, with a stated crash window

A WebSocket emit **cannot** be transactional with a `processed_events` insert. This spec does not
pretend otherwise. The chosen semantics:

- record the event as processed, then emit;
- a crash between commit and emit loses that broadcast — this window is real and documented;
- the client therefore treats WebSocket delivery as a hint, not a source of truth: it deduplicates
  by `eventId`, ignores payloads with `version` not greater than what it holds, and refreshes the
  canonical snapshot on reconnect and on a periodic timer;
- duplicate emits are harmless because of that client-side filtering.

This is the correct answer to "what if WebSocket messages are missed", and the three mechanisms
above are where it is implemented rather than merely asserted.

### 12.3 Kitchen ticket printing — the BullMQ job

Printing a ticket is an effect on an external device, so it cannot join the database transaction
and it needs its own retry policy, visibility and dead-letter state. That is a genuine second
responsibility, distinct from the outbox, and it is where BullMQ belongs.

Flow: the kitchen consumer commits its projection, then enqueues a BullMQ job keyed by
`order_id`. The job posts to a fake local printer endpoint that can be made to fail on demand
from `/debug`. `print_jobs` holds the durable record, and failures retry with bounded backoff and
end in a visible dead-letter state. If the enqueue itself is lost in a crash, a periodic sweep
reconciles missing tickets from `kitchen_tickets`.

**This is at-least-once, and a duplicate ticket can physically print.** `ticket_hash` deduplicates
the *database record*, not the paper: if the printer emits the ticket and the worker dies before
recording success, the retry prints it again. Nothing in a database can prevent that unless the
device itself honours an idempotency key.

That is a deliberate choice, not an oversight. A missing ticket loses an order; a duplicate ticket
wastes paper. For a kitchen, at-least-once is the correct trade, and the same reasoning is why real
POS printers expose an idempotency key — which the fake printer here implements, so that §21.14
tests a real property of *this* endpoint rather than pretending to guarantee something about
physical hardware. ADR 014 states this plainly.

## 13. WebSockets

Socket.IO plus the **Redis adapter**, so that multiple API instances broadcast across nodes.
This is Redis's primary role and it is *proved*, not asserted: §22 runs two API instances behind
the adapter in a smoke test.

Rooms: `restaurant:{restaurantId}`, `order:{orderId}`, `kitchen:{restaurantId}`.

Flow: domain event -> Kafka -> realtime consumer -> Socket.IO -> connected clients.

The frontend never treats WebSocket events as reliable. On reconnect it must not merely display
`CONNECTED`; instead: `GET` the order snapshot, compare versions, replace or merge the local
canonical state, then continue syncing pending mutations. A snapshot refresh is sufficient —
do not build event-replay infrastructure.

**A polling fallback exists** as a fully working second transport (§15): when WebSocket push is
disabled for a restaurant, the client polls the snapshot endpoint on an interval. Both paths keep
the UI correct; they differ only in latency.

## 14. Offline-first

Local stores in IndexedDB via Dexie: `orders`, `pendingMutations`, `syncMetadata`.

```ts
interface PendingMutation {
  mutationId: string; restaurantId: string; terminalId: string; orderId: string;
  baseVersion: number; type: MutationType; payload: unknown; createdAt: string;
  status: 'PENDING'|'SYNCING'|'CONFLICT'|'BLOCKED'|'SYNCED';
}
```

A user action: update local state -> persist to IndexedDB -> create a mutation -> attempt sync.
**The UI updates optimistically and never waits for the server.** A page reload must not lose
unsynced local data.

A `Simulate Offline` toggle in the POS is mandatory. The client behaves as though the API is
unavailable even while the infrastructure is running. Do not rely on the browser DevTools offline
mode — the demo has to be deterministic.

**Reconnect algorithm** — sequential per aggregate, never concurrent:

```
load pending mutations in local creation order
-> send the first -> wait for the canonical server result
-> update the local order -> delete the acknowledged mutation -> send the next
```

### 14.1 What happens on conflict — the queue halts

This is the rule the original prompts left undefined, and getting it wrong looks like a bug.

When a mutation is rejected with `409`:

1. that mutation is marked `CONFLICT`;
2. every later pending mutation **for the same order** is marked `BLOCKED` and is **not sent** —
   their `baseVersion` is now provably stale, so sending them would produce a cascade of
   conflicts that looks like a broken client;
3. mutations for *other* orders continue syncing normally — the halt is per aggregate, because
   the order is the consistency boundary;
4. the POS surfaces the conflict with the server's canonical state next to the local intent, and
   offers two explicit resolutions: **discard** the blocked mutations, or **rebase** them.
   A rebase is **sequential, not a batch re-stamp**: the blocked mutations cannot all be re-issued
   at the same fresh `baseVersion`, because each successful one advances the version. So A is
   re-issued with a new `mutationId` at v6; only after it applies is B re-issued at v7, then C at
   v8. Each is subject to the §8 rules and any of them may conflict again — a rebase onto a
   `CANCELLED` order fails on the first attempt and the rest stay blocked;
5. nothing is resolved automatically. Silent auto-rebase would be last-write-wins wearing a
   disguise.

Tested by §21.7 and §21.8.

## 15. Feature flags (safe rollout)

Flags live in `feature_flags` with a Redis cache, and roll out by percentage using a hash of
`restaurantId` so a given restaurant is stable across requests.

The flag that exists is `realtime.websocket_push`. Off means the client uses the polling fallback
(§13). **Both branches are complete, working implementations**, which is what makes this a rollout
rather than a kill switch: turning the flag off degrades latency, it does not cause an outage.

An earlier draft gated the single mutation path behind a flag. A review pointed out — correctly —
that disabling the only write path is an outage, not a safe rollout. Recorded in
`docs/adr/008-feature-flags.md`.

Toggling from `/debug` takes effect without a restart on the server. **An already-open client
learns about it by polling**: the client fetches `GET /api/config` at bootstrap and re-fetches it
on a slow interval (15 s), switching transport when the value changes. A WebSocket control event
would be circular — it cannot be used to tell a client that WebSocket push is off — and forcing a
reload would be worse UX than a 15-second delay on a rollout change.

`POS-3` in `Second Restaurant` (§3) is what makes this visible: a rollout percentage can put the
two restaurants on different transports at the same time, side by side on screen.

## 16. Screens

`/pos/pos-1`, `/pos/pos-2`, `/pos/bar-1`, `/kitchen`, `/debug`, `/demo`.

**POS** — resembles a modern restaurant terminal, and is usable at rush speed: large touch
targets, item quantity reachable in one tap, no modal dialogs on the critical path. Shows:
terminal name, network status, WebSocket status, transport in use (push or polling), current
order, order version, pending mutation count, sync state, and any blocked-queue conflict banner.
Actions: create order, select table, add items, change quantity, remove item, send to kitchen,
cancel, pay, and resolve a conflict (discard / rebase).

**Kitchen** — reads `kitchen_tickets`. Columns `NEW | PREPARING | READY`, actions
`Start Preparing` and `Mark Ready`, both issuing real mutations. Status changes propagate to
active POS terminals.

**Debug** — a first-class part of the application, not a utility page. Sections: dependency status
(PostgreSQL / Redis / Redpanda / WebSocket, with hard-vs-soft marked), active terminals with their
pending counts, a stream of recent domain events with timestamps, conflict history (versions,
mutationId, resolution), outbox state including dead-lettered rows, print job state, idempotency
counters, feature flag toggles, and the failure simulator.

**Demo** — step-by-step guided scenarios (see §19).

Required state badges: `ONLINE OFFLINE SYNCING SYNCED CONFLICT BLOCKED PENDING
DUPLICATE PREVENTED DEAD-LETTERED`. The UI is a clean, neutral SaaS/POS aesthetic. Do not
overinvest in visual design; the priority is that technical state is obvious at a glance.

## 17. API

```
GET  /api/health/live
GET  /api/health/ready
GET  /api/config
GET  /api/menu
GET  /api/orders/:id
GET  /api/restaurants/:restaurantId/orders
POST /api/orders/:id/mutations
POST /api/kitchen/orders/:id/preparing
POST /api/kitchen/orders/:id/ready
GET  /api/debug/events
GET  /api/debug/conflicts
GET  /api/debug/outbox
GET  /api/debug/dependencies
GET  /api/debug/metrics
POST /api/debug/flags/:key
```

The two kitchen endpoints are thin adapters over the mutation handler (§5), kept because they read
better as domain commands. They accept `mutationId` and `baseVersion` like any other mutation.

**There is deliberately no `POST /api/orders`.** Creation goes through
`POST /api/orders/:orderId/mutations` with `type: CREATE_ORDER` and `baseVersion: 0`, against a
client-generated `orderId` (§5). One write path means one place where idempotency, tenant scoping
and version checking are enforced — a separate creation endpoint would be the single unprotected
write in the system.

`GET /api/config` returns the resolved feature-flag state for the calling restaurant. The client
polls it (§15).

**Health is split three ways, because the dependencies are not equally hard:**

- `/api/health/live` — the process is running. Never touches a dependency.
- `/api/health/ready` — can this instance accept writes? Checks **PostgreSQL only**.
  Redpanda being down must not mark the API unready: the whole point of the outbox is that orders
  keep being accepted and events publish later. A readiness probe that fails on broker loss would
  take a working POS offline — the exact failure the architecture exists to prevent.
- `/api/debug/dependencies` — informational status of Postgres, Redis, Redpanda, consumer lag,
  outbox backlog. This is what `/debug` renders and what a human reads.

A single error model with typed domain errors and no stack traces in responses:

```json
{ "code": "ORDER_VERSION_CONFLICT", "message": "...", "details": {} }
```

## 18. Failure simulator

Controls in `/debug`: `Duplicate Next Mutation`, `Reuse Mutation Id With New Payload`,
`Replay Last Kafka Event`, `Delay Outbox Publishing`, `Pause Outbox Publisher`,
`Fail Printer`, `Create Version Conflict`, `Simulate POS-1 Offline`, `Simulate POS-2 Offline`,
`Disconnect WebSocket`, `Force Polling Transport`.

The goal is demonstration, not faithful infrastructure emulation. Every action produces visible
feedback.

## 19. Demo scenarios

1. **Normal flow**: POS-1 creates an order -> Burger -> Cola -> send to kitchen -> the kitchen
   projection appears -> PREPARING -> POS updates -> READY -> POS updates -> pay.
2. **Offline**: POS-1 goes offline -> **creates a brand new order** -> add Burger, add Coffee,
   change a quantity -> the UI keeps working -> 4 pending -> reconnect -> sequential sync ->
   canonical order returned -> pending count reaches zero. Creating an order while disconnected
   works because creation is a mutation like any other (§5).
3. **Conflict with a blocked queue**: both terminals hold order v5 -> POS-1 goes offline ->
   POS-1 queues three mutations -> POS-2 cancels the order (server reaches v6) -> POS-1
   reconnects -> the first mutation returns 409, the remaining two go `BLOCKED` and are never
   sent -> the operator discards or rebases -> `/debug` shows every version and mutationId.
4. **Duplicate mutation**: applied -> the same mutation is sent again -> matched in
   `processed_mutations` -> the original result is returned -> the item is not duplicated.
5. **Reused mutationId with a different payload**: rejected with `MUTATION_ID_REUSED` rather than
   silently returning a stale result.
6. **Duplicate Kafka event**: consumed -> the projection is written -> replayed ->
   `processed_events` catches the duplicate -> the projection is unchanged.
7. **Outbox publication failure**: the transaction commits -> the outbox row exists -> the
   publisher is paused -> the event stays unpublished -> the publisher resumes -> the event is
   published. The order is never lost. The key demonstration of why the outbox exists.
8. **Two kitchen displays race**: both press Ready on the same ticket -> one applies, one
   conflicts. Kitchen commands obey the same concurrency model as POS commands.
9. **Printer down**: the printer fails -> the print job retries with backoff -> it dead-letters
   visibly -> the printer recovers -> a manual retry succeeds. The order was never affected.
10. **Multi-instance broadcast**: two API instances behind the Redis adapter; a mutation on
    instance A reaches a client connected to instance B.

## 20. Observability

Structured JSON logs (pino) carrying correlation fields: `traceId requestId restaurantId
terminalId orderId mutationId eventId eventType`.

Internal counters for `/debug`: API requests, API errors, active WebSocket connections, mutations
received, mutations applied, duplicate mutations prevented, mutation-id reuse rejected,
cross-tenant rejections, conflicts detected, blocked mutations, outbox events pending, outbox
events published, outbox events dead-lettered, Kafka events consumed, duplicate Kafka events
prevented, print jobs succeeded/failed/dead-lettered, offline sync successes, offline sync
failures. The implementation also exposes a deliberately small, bounded-label Prometheus surface at
`GET /metrics`; see `docs/observability.md`.

## 21. Testing

Vitest, with integration tests against a real PostgreSQL. Not only trivial unit tests.
The mandatory set:

1. Optimistic concurrency: two concurrent mutations with `baseVersion=5` -> one succeeds,
   one conflicts.
2. Duplicate mutation -> the business effect occurs exactly once.
3. Reused `mutationId` with a different payload -> `409 MUTATION_ID_REUSED`, and the original
   effect is untouched.
4. Cancelled-order conflict: client v5, server v6 CANCELLED, `ADD_ITEM` -> 409 `ORDER_CANCELLED`.
5. Outbox atomicity: on success both the order change and the event exist; on failure neither does.
6. Consumer idempotency: the same event consumed twice -> one projection row at one version, one
   `processed_events` row.
7. Offline queue ordering: A, B, C sync in order for the same order.
8. **Conflict halts the queue**: A conflicts while B and C are pending -> B and C are `BLOCKED`
   and never reach the server -> a mutation for a *different* order in the same queue still syncs.
9. Payment idempotency: `PAY` twice with the same mutation -> one payment.
10. Kitchen transition race: two `MARK_READY` mutations at the same `baseVersion` -> one applies,
    one conflicts.
11. Cross-tenant mutation: a mutation carrying restaurant B against an order owned by restaurant A
    -> `403 CROSS_TENANT_MUTATION`, no state change, no outbox row.
12. **Crash after publish, before `published_at`**: the row is republished on the next pass, the
    consumer deduplicates, and the projection is applied once.
13. **Crash after the consumer's DB commit, before the offset commit**: the event is redelivered,
    `processed_events` catches it, and the projection is unchanged.
14. Print job deduplication: the same `ticket_hash` enqueued twice -> the fake printer, which
    honours an idempotency key, prints once. This tests the endpoint contract, not a guarantee
    about physical hardware (§12.3).
15. Order creation idempotency: the same `CREATE_ORDER` mutation submitted twice ->
    `ALREADY_APPLIED` and exactly one order row. The same `orderId` with a different `mutationId`
    and identical content -> the existing order; with different content -> a conflict.
16. Outbox lease: a claimed batch whose worker dies is re-claimable after `claim_until` expires,
    and a second worker running concurrently never claims a row already leased.

End-to-end with Playwright, at least one browser test: open POS-1, create an order, add an item,
send to kitchen, open the kitchen screen, verify the ticket appears, mark PREPARING, verify the
POS updates.

## 22. Delivery: CI and deployment

The job description asks for CI/CD fluency, horizontal scaling and safe releases, so the repo
ships the artifacts that back that up.

- **One command for reproducible integration runs**: `pnpm verify:integration` brings up Compose,
  waits for readiness, runs the integration suite, tears down, and writes its output to a file.
- **CI** (`.github/workflows/ci.yml`): install, lint, typecheck, unit tests, then
  `pnpm verify:integration`, then build, on a clean checkout with no local state.
  CI declares **no `services:` block**: the script already owns the lifecycle, and adding GitHub
  service containers alongside it would bind the same ports twice. Developer and CI run the
  identical command, which is the only way the script stays trustworthy.
- **Production images**: a multi-stage Dockerfile per app, non-root, with the built output only.
- **Multi-instance smoke**: bring up two `api` replicas plus the Redis adapter and assert that a
  mutation applied through replica A reaches a WebSocket client attached to replica B (§19.10).
  This turns the Redis-adapter claim from an assertion into a test.

## 23. Documentation

- `docs/architecture.md` — with Mermaid diagrams: the system diagram, an offline-sync sequence
  including the blocked-queue branch, and an outbox sequence
  (HTTP -> transaction -> outbox -> commit -> worker -> Kafka -> consumer).
- `docs/adr/` — 001-modular-monolith, 002-offline-first, 003-optimistic-concurrency,
  004-idempotency, 005-transactional-outbox, 006-kafka-at-least-once, 007-drizzle,
  008-feature-flags, 009-kitchen-projection, 010-db-outbox-retries, 011-health-and-degradation.
  Format: Context / Decision / Consequences / Alternatives considered.
- **The eighteen likely questions, answered where the answer belongs** — critically important, and
  deliberately not one document: each answer lands on an ADR, a test or a section of
  `docs/architecture.md`, so that it can be checked rather than recited. The questions are: why not
  last-write-wins, why Kafka, why Redis, why an outbox, why not exactly-once, what happens when the
  client retries, what happens when Kafka delivers twice, what if the browser closes while offline,
  what if two terminals modify the same order, what if WebSocket messages are missed, what if the
  outbox publisher crashes, what if PostgreSQL commits but Kafka is down, why retries live in
  Postgres rather than BullMQ, why readiness ignores the broker, how this scales to 20,000
  restaurants, how to shard or partition, how multi-region would work, what would change in a real
  payment system, and **what the biggest weaknesses of this architecture are**.
  Do not pretend the architecture is perfect. Discuss trade-offs explicitly.
- A scale section — documented, not implemented: stateless API replicas, connection pooling,
  WebSocket scaling, the Redis Socket.IO adapter, partition count, hot partitions, partition key
  selection, PostgreSQL read/write scaling, tenant partitioning, asynchronous workloads,
  backpressure, consumer lag, rate limits, observability.
- `README.md` — startup, URLs, the demo sequence, and an "Engineering concepts demonstrated by
  this project" section.

## 24. Commands

```
pnpm install  pnpm dev  pnpm build  pnpm lint  pnpm typecheck
pnpm test  pnpm verify:integration  pnpm test:e2e
pnpm db:migrate  pnpm db:seed
docker compose up -d
```

Root-level scripts orchestrate the workspaces.

## 25. Out of scope

Authentication is not a priority — a hard-coded demo restaurant and terminal identity is fine.
Tenant scoping (§3) is a consistency guard, not auth.
Do not implement: Kubernetes, Terraform, service mesh, multi-region deployment, a real payment
provider, complex authentication, native mobile apps, inventory management, employee scheduling,
accounting, reservations, delivery integrations.

## 26. Definition of done

A fresh developer can start the project from the README. Two independent POS terminals work.
The kitchen receives orders in real time from a real projection. The POS stays usable offline.
Pending mutations synchronize sequentially, and a conflict halts the queue for that order with an
explicit operator resolution. Stale writes are detected. Kitchen commands obey the same
concurrency model. A duplicate mutation cannot duplicate a side effect, and a reused mutationId
with a new payload is rejected. Order creation is itself an idempotent mutation, so a retried
create cannot produce two orders. The outbox publisher never holds a lock across a broker call,
and its at-least-once behaviour is stated rather than hidden. Cross-tenant mutations are rejected. The database change and event
creation are atomic. Events genuinely flow through Redpanda, with retries and dead-lettering in
PostgreSQL. A duplicate Kafka event does not duplicate effects. Canonical updates reach connected
clients over WebSocket, across two API instances. The polling fallback works and is
percentage-rolled by feature flag. Critical consistency guarantees have automated tests, including
the two crash-window cases. CI is green on a clean checkout. The architecture documentation is
complete and honest about weaknesses. `pnpm lint typecheck test build` are green.
The main flow has been smoke-tested by hand.
