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

## URLs

- POS: http://localhost:5173/pos/pos-1
- Kitchen: http://localhost:5173/kitchen
- API readiness: http://localhost:3000/api/health/ready
- Redpanda Console: http://localhost:8080

The optional Compose `app` profile is a development convenience. Local `pnpm dev` is the supported
M1 workflow; production images and the multi-instance Compose overlay arrive in M14.
Do not run the `app` profile alongside host-side `pnpm dev` in the same checkout.
