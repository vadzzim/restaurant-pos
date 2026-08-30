# Progress / Handoff

> **The only progress file read at the start of a session**, with `docs/milestones/MXX.md`.
> `grep` the others; never open them whole.
>
> **Hard limit: 8 000 characters.** Overflow belongs in `known-problems.md`, `build-log.md` or
> `progress-archive.md`. Rewrite the sections below each milestone; do not append to them.

## Current state

**Last completed:** M12 — the failure simulator. §18's eleven controls on `/debug`, grouped by
**where the switch lives** (ADR 015), which is the axis that decided everything: four are rows in
PostgreSQL behind one endpoint pair, seven are refs in one browser tab that never reach the API.
`Replay Last Kafka Event` is an `UPDATE` that puts the newest published outbox row back to
claimable, not a Kafka producer in the API — the publisher stays the only thing that writes to the
topic, and §19.6 is a claim about that path. One review pass, one P1: the version-conflict arm was
spent when it rewrote the request, so an offline terminal or a dead network consumed it silently;
it now spends only after the request reaches the server.

Three things moved to where their second caller was: `read`/`setOutboxControls` into `@pos/db`
beside `printer-controls.ts`, and `maxPublishDelayMs` into `@pos/contracts` (worker honours it, CLI
and API validate against it).

**Demoable end to end:** the order lifecycle, a broker outage, reloading the tab mid-order, §19.2,
§19.3, §19.9, `/debug` populating live, and now every §18 control from the page itself.

**Green:** typecheck, lint, build, **333 tests** (61 domain, 89 api, 55 worker, 142 web) against a
real PostgreSQL, plus **three** under `pnpm verify:integration`. All sixteen mandatory §21 tests
exist, named by their spec number. The four server controls were also exercised over HTTP against a
running API; the seven client ones are unit-tested but were not driven in a browser this session.

**Next:** M13 — feature flags and the polling fallback. Model **Sonnet**, size **M**. Brief below.

## What exists

One line per unit. The detail is in the code and in the ADRs — do not restate it here.

- **Docs** — what CLAUDE.md lists, plus briefs `milestones/M01…M12.md`. ADRs 001–007 and 009–015
  accepted; only 008 (M13) is unwritten.
- `packages/config` — zod environment: topics, outbox, `PRINT_*`, `PRESENCE_TTL_MS`,
  `DEBUG_ROW_LIMIT`.
- `packages/contracts` — statuses, mutations, events, the §5 shapes, `ConflictReason`, socket names,
  `TERMINALS`, the M11 debug shapes, and M12's `SIMULATOR_CONTROLS` / `SimulatorState` /
  `SimulatorResponse` plus `maxPublishDelayMs`.
- `packages/domain` — `decide()` and the pricing and transition rules: **the whole of §8**.
- `packages/db` — fifteen tables, three migrations, seed, `db:check`, `@pos/db/testing`, and the two
  singleton control modules (`outbox-controls.ts`, `printer-controls.ts`) both ends write.
- `apps/api` — the nine-branch mutation endpoint, the two §17 kitchen adapters, the four reads,
  `modules/realtime/`, `modules/printer/`, `/api/health/{live,ready}`,
  `/api/debug/dependencies`, and `modules/debug/` — the counter registry, the reporting queries, the
  metrics assembly, the lag probe, the Redis presence store, the four read routes, and **the
  simulator pair** (`api/simulator-routes.ts`, `application/replay-last-event.ts`).
- `apps/worker` — the §10 outbox publisher (ADR 010), the Kafka producer, the kitchen consumer and
  its transactional projection, `modules/printing/` (ADR 014). Two CLIs: `outbox` and `printer`,
  both still working and writing the same rows `/debug` does.
- `apps/web` — the POS and kitchen screens; Pinia stores for menu, order, kitchen, connection,
  debug and **simulator**; Dexie persistence (ADR 013); the §14 sync engine; `api/offline.ts` and
  **`api/simulator-arms.ts`** (the seven client controls and the effect log); `domain/debug-view.ts`;
  `views/DebugView.vue` with **`components/SimulatorPanel.vue`**. `/demo` is still the M1
  placeholder (M16).
- **Scripts and CI** — `scripts/verify-integration.mjs`, `.github/workflows/ci.yml`.

## Standing decisions

ADRs are canon; the full historical list is in `progress-archive.md`. What is not in an ADR:

- Full scope, nothing cut (Fastify and Drizzle: ADR 001, 007).
- Twenty milestones, M0–M19. **Seven left: M13–M19.**
- Drop order if the date closes in: M16 (`/demo`), then M17 (PWA). Never M15 or M18 first.

## Known problems

In `docs/known-problems.md`: accepted limits, then the P2/P3 backlog. **Do not read it to start a
session.** What bears on M13 is named in the block below.

## First command of the next session

```
Read CLAUDE.md and docs/PROGRESS.md, then expand M13 from docs/MILESTONES.md into
docs/milestones/M13.md and implement M13 only. Stop when the M13 Verification block passes.

M13 is feature flags plus the polling transport as a complete second implementation of realtime
updates. Write ADR 008 — it is the last unwritten one, and MILESTONES.md already fixes its subject:
why the flag gates transport and not the write path. Model: Sonnet. Size: M.

Six things worth knowing before you plan:

1. **The flag half is a real feature, not a stub, but it starts from one.** `GET /api/config` reads
   `feature_flags` directly today: no Redis cache, no percentage rollout by a hash of
   `restaurantId`, and the client fetches it once at bootstrap in `stores/connection.ts`
   (`resolveTransport`). M13 adds all three, plus the 15 s re-poll — not a reload, and not a
   WebSocket control event, which would be circular when the flag turns WebSocket off (§15).
2. **The write surface already exists and is one endpoint short.** M12 built
   `GET/POST /api/debug/simulator` in `apps/api/src/modules/debug/api/simulator-routes.ts`, a zod
   enum on the path segment and the new state in the response. §17's `POST /api/debug/flags/:key`
   is meant to be its twin: build it the same shape, in a sibling file, and do not invent a third
   pattern. ADR 015 explains the one that is there.
3. **The presence heartbeat has to move, and it is a P2 that becomes a P1 here.** It is installed by
   `connectRealtime`, so a client on the polling transport sends none and vanishes from `/debug`'s
   active-terminal panel. Harmless today because `PUSH DISABLED` means no live updates at all; the
   moment polling is a working transport, a working terminal is invisible. Presence must leave the
   socket or gain a second path **as part of M13**. `[M11, P2]` in known-problems.md.
4. **There is already a client switch that reaches the disabled branch.** §18's
   `Force Polling Transport` in `apps/web/src/api/simulator-arms.ts` is a per-tab latch that makes
   one terminal decline push without touching the fleet-wide flag. It is the natural way to test
   both transports side by side before the rollout percentage exists — and once polling is real,
   its label stops being an overstatement. Both the panel copy and the known-problems entry that
   apologise for it should be corrected in this milestone.
5. **`/debug` writes now, and nothing authenticates it.** Adding a flag toggle widens that. Named in
   known-problems.md; do not silently widen it further.
6. **Do not sweep the review backlog.** It now holds M11's three and M12's two. The sweep is its own
   pass, and M13 is not it — except for the `[M11, P2]` presence entry, which point 3 makes
   unavoidable here.

Verification: `pnpm -F @pos/api test`, `pnpm -F @pos/web test`, lint, typecheck, build, and
`pnpm verify:integration`. Run tests narrowly. One review pass at the end, P1s only.

Running the system: `pnpm -F @pos/api start` and `pnpm -F @pos/worker dev` both work and the demo
database is migrated. Compose was up at the end of M12. If a /debug section is empty, check the
worker is actually up before suspecting the query.
```
