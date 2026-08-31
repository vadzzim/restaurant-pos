# Restaurant POS Distributed Systems Demo

[![CI](https://github.com/vadzzim/restaurant-pos/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vadzzim/restaurant-pos/actions/workflows/ci.yml)

A restaurant point-of-sale where several terminals edit the same order and the network is not
reliable. It is an interview demo, not a commercial product, and it exists to show two things
working properly rather than many things working shallowly:

- **A terminal may be offline when it decides something.** Every action is a mutation with a
  client-generated id and the version it was built against, queued durably in IndexedDB and drained
  sequentially on reconnect. A conflict **halts** that order's queue and waits for an operator.
- **A database commit and a broker publish cannot be one transaction.** The order change, the
  idempotency record and the domain event commit together into an outbox table; a worker publishes
  from it, outside any transaction, with retries and dead-lettering in PostgreSQL.

Three processes — `web`, `api`, `worker` — over PostgreSQL, Redpanda and Redis.

**Documentation.** [`docs/architecture.md`](docs/architecture.md) has the diagrams and the scale
section; [`docs/adr/`](docs/adr/README.md) has the nineteen decisions;
[`docs/known-problems.md`](docs/known-problems.md) has what is wrong with it; and
[`docs/definition-of-done.md`](docs/definition-of-done.md) walks the acceptance criteria clause by
clause, including the one that is still not met.

## Requirements

- Node.js 24+
- pnpm 10+
- Docker with Compose

## Start

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm dev
```

PowerShell equivalent: `Copy-Item .env.example .env`. Compose can start the infrastructure without
the file because its demo defaults are explicit, but local application processes read `.env`.

## Verify

```bash
pnpm lint && pnpm typecheck   # static checks
pnpm test:unit                # the domain rules and the browser stores; no infrastructure needed
pnpm verify:integration       # Compose up, the PostgreSQL- and broker-backed suites, teardown
pnpm test:e2e                 # the same, plus the apps, plus §21's browser test
pnpm verify:multi             # the production images, two API replicas, and §19.10
```

`pnpm verify:integration` is the reproducible one: it brings the infrastructure up, waits for the
healthchecks, runs the suites that need it — including a real round trip through Redpanda and one
through the BullMQ print queue on a real Redis — and
tears down **only the containers it started**, so a demo you already have running survives. Its full
output lands in `.verify-output/integration.log`. Pass `--keep` to leave the containers up. CI runs
this same command and declares no service containers of its own.

`pnpm test:e2e` is §21's last line: one Playwright test that crosses every process — POS-1 opens an
order, adds an item and sends it to the kitchen; the kitchen display shows the ticket, marks it
PREPARING, and the POS follows without asking for anything. The script owns the whole lifecycle
(Compose, migrate, seed, build, an API and a worker as child processes) and Playwright serves the
**production** bundle on `:4173` — since M17 that is a different build from `pnpm dev`, and it is the
one the image ships. Output in `.verify-output/e2e.log`. An API already listening on `:3000` is
reused rather than duplicated, so this is safe to run against a demo you have up. It also installs
the Chromium Playwright drives — `pnpm install` does not, and that binary is the one prerequisite
this repository cannot express in `package.json`.

`pnpm test:e2e:run` runs the spec alone against a stack you are already running, and takes
Playwright's own flags — `--headed`, `--debug`, `--ui`. It expects `apps/web/dist` and the browser
to be there already: `pnpm exec playwright install chromium` once, then
`pnpm -F @pos/web build && pnpm -F @pos/web preview`. ADR 018 records the rest.

`pnpm verify:multi` is the §22 one. It builds the three production images
(`apps/{api,worker,web}/Dockerfile`, multi-stage and non-root — ADR 016), brings up
`docker-compose.multi.yml`: **two addressable API replicas** behind the Redis adapter, one worker,
and the built web on nginx in front of both. Then it asserts §19.10 — a mutation applied through
replica A reaches a WebSocket client attached to replica B. Output in
`.verify-output/multi-instance.log`; `--keep` leaves the stack up, with the replicas on
`:3001` and `:3002` and the browser entry point on http://localhost:8081.

Two things look wrong in a two-replica run and are not: `activeWebSocketConnections` on `/debug` is
that instance's own sockets, and so is the in-process counter registry, so the page reports
whichever replica answered. The shared counters in Redis are the ones that aggregate.

## The demo

Open **http://localhost:5173/demo**. It carries all ten §19 scenarios click by click — what has to
be off before each one, what to press, and what to watch. The short version, in the order worth
showing:

1. **Normal flow** — one order from the first tap to payment, across a till and a kitchen display.
   The till never calls the kitchen: the ticket arrives through Postgres, the outbox, Redpanda and
   the consumer's projection.
2. **Offline, then a clean sync** — a till with no network **creates** an order and takes four
   mutations; reconnect drains them in order and the pending count reaches zero.
3. **Conflict, and the queue behind it** — the first mutation gets a 409, the rest go `BLOCKED` and
   are never sent, and the operator chooses Discard or Rebase. The one most systems get wrong.
4. **The publisher stops; the order does not** — pause the outbox publisher, take an order, watch
   the backlog grow on `/debug`, resume, watch it drain. The argument for the outbox, made visible.
5. **The printer is down** — retries with backoff, a visible dead-letter, a manual retry that
   succeeds. The order was never affected.

The remaining five — a duplicate mutation, a reused id with a new payload, a duplicated Kafka event,
two kitchen displays racing on one ticket, and a cross-replica broadcast — are on the same page.
The last needs `pnpm verify:multi --keep`.

Two setup traps. The seven client-side simulator controls are module refs in **one tab**: arm on
`/debug` and walk to the POS in that same window, never a second tab. And a control left armed will
fail the next scenario the way a broken broker would — `/demo` lists what must be off before each.

## Operational switches

All eleven §18 simulator controls are on `/debug`, grouped by where the switch lives (ADR 015). The
four server-side ones are rows in PostgreSQL, so they are also reachable from a terminal, and a
running worker picks a change up without a restart — the CLI and the page drive the same state:

```bash
pnpm -F @pos/worker outbox status | pause | resume | delay 3000
pnpm -F @pos/worker printer status | fail | fix | retry <orderId>
```

`printer fail` makes `POST /api/printer/print` answer 503, which is how scenario §19.9 drives a
print job into its dead-letter state; `printer retry` puts a dead-lettered ticket back on the queue.

## URLs

- POS: http://localhost:5173/pos/pos-1 and http://localhost:5173/pos/pos-2
- Kitchen: http://localhost:5173/kitchen
- Debug and the §18 simulator: http://localhost:5173/debug
- Demo script: http://localhost:5173/demo
- API liveness: http://localhost:3000/api/health/live
- API readiness: http://localhost:3000/api/health/ready — PostgreSQL only; a broker outage leaves
  this green and orders still accepted (ADR 011)
- Dependencies: http://localhost:3000/api/debug/dependencies
- Redpanda Console: http://localhost:8080

With `pnpm verify:multi --keep` running, the same screens are served by nginx in front of both
replicas: POS http://localhost:8081/pos/pos-1, kitchen http://localhost:8081/kitchen, and each
replica reachable on its own at http://localhost:3001 and http://localhost:3002.

The optional Compose `app` profile is a development convenience that mounts the source tree and
runs `tsx`; `docker-compose.multi.yml` is the opposite — the built images, no mounts. They use
different service names for that reason and can be told apart at a glance. Local `pnpm dev` is the
supported workflow; do not run the `app` profile alongside host-side `pnpm dev` in the same
checkout.

## Engineering concepts demonstrated by this project

Each of these is a decision with a written argument behind it, not a library import.

| Concept                                           | Where it lives                                                                                                                                         | Where it is argued      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| Optimistic concurrency                            | `UPDATE ... WHERE id = $1 AND version = $2` — the comparison in the statement, never "read, compare, write"                                            | ADR 003                 |
| Idempotency at the write boundary                 | `processed_mutations(mutationId)` plus a `request_hash`, committed with the effect; a reused id with new content is refused, never answered from cache | ADR 004                 |
| Explicit conflict resolution                      | a 409 halts that order's queue, blocks the tail, and waits for Discard or Rebase — no silent auto-rebase                                               | ADR 002, spec §14.1     |
| Transactional outbox                              | order change, idempotency row and event in one commit; publish outside any transaction                                                                 | ADR 005                 |
| At-least-once with idempotent consumers           | `processed_events(event_id, consumer_name)`; the kitchen consumer commits its marker with the projection                                               | ADR 009                 |
| Honest delivery semantics                         | the realtime consumer's crash window is stated, and a duplicate ticket can physically print                                                            | spec §12.2, ADR 014     |
| Retry, backoff and dead-lettering in the database | columns on the outbox row; a reclaim is not an attempt                                                                                                 | ADR 010                 |
| Event ordering where it matters                   | topic partitioned by `orderId`; the publisher claims an order's earliest unpublished event                                                             | ADR 005                 |
| Offline-first clients                             | a durable queue in IndexedDB, an optimistic view derived on read, a service worker for the shell                                                       | ADR 002, 013, 017       |
| Graded health and degradation                     | liveness, readiness on hard dependencies only, and a three-state dependency report                                                                     | ADR 011                 |
| Feature flags as a real rollout                   | percentage-rolled per restaurant, gating **transport** — two complete implementations, not an off switch                                               | ADR 008                 |
| Horizontal scale-out of a stateful protocol       | Socket.IO over the Redis adapter, two replicas, asserted end to end                                                                                    | ADR 006, `verify:multi` |
| A read model that is genuinely a read model       | the kitchen screen reads the projection, and commands from it                                                                                          | ADR 009, 012            |
| Effects outside the database                      | the print job — BullMQ owns _when_, the row owns _what happened_, a sweep reconciles from the projection                                               | ADR 014                 |
| Tenant scoping as a consistency guard             | `restaurantId` on the tables that route on it, and a cross-tenant mutation answered 403 rather than ignored                                            | spec §3                 |
| Reproducible verification                         | one command per surface, each owning its own Compose lifecycle and writing a log                                                                       | `scripts/verify-*.mjs`  |
