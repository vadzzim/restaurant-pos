# Restaurant POS Distributed Systems Demo

An interview demo for a restaurant point-of-sale flow. M1 contains only the runnable monorepo and
local infrastructure skeleton; business behavior arrives in later milestones.

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

## Operational switches

The §18 failure simulator gets its buttons in M12. Until then the switches it will drive are real
and reachable from a terminal, and a running worker picks them up without a restart:

```bash
pnpm -F @pos/worker outbox status | pause | resume | delay 3000
pnpm -F @pos/worker printer status | fail | fix | retry <orderId>
```

`printer fail` makes `POST /api/printer/print` answer 503, which is how scenario §19.9 drives a
print job into its dead-letter state; `printer retry` puts a dead-lettered ticket back on the queue.

## URLs

- POS: http://localhost:5173/pos/pos-1
- Kitchen: http://localhost:5173/kitchen
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
