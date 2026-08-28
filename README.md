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
```

`pnpm verify:integration` is the reproducible one: it brings the infrastructure up, waits for the
healthchecks, runs the suites that need it — including a real round trip through Redpanda — and
tears down **only the containers it started**, so a demo you already have running survives. Its full
output lands in `.verify-output/integration.log`. Pass `--keep` to leave the containers up. CI runs
this same command and declares no service containers of its own.

## URLs

- POS: http://localhost:5173/pos/pos-1
- Kitchen: http://localhost:5173/kitchen
- API liveness: http://localhost:3000/api/health/live
- API readiness: http://localhost:3000/api/health/ready — PostgreSQL only; a broker outage leaves
  this green and orders still accepted (ADR 011)
- Dependencies: http://localhost:3000/api/debug/dependencies
- Redpanda Console: http://localhost:8080

The optional Compose `app` profile is a development convenience. Local `pnpm dev` is the supported
M1 workflow; production images and the multi-instance Compose overlay arrive in M14.
Do not run the `app` profile alongside host-side `pnpm dev` in the same checkout.
