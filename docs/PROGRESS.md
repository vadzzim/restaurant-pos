# Progress / Handoff

> **The only progress file read at the start of a session**, with `docs/milestones/MXX.md`.
> `grep` the others; never open them whole.
>
> **Hard limit: 8 000 characters.** Overflow belongs in `known-problems.md`, `build-log.md` or
> `progress-archive.md`. Rewrite the sections below each milestone; do not append to them.

## Current state

**Last completed:** M13 — feature flags and the polling fallback. §15 in full: `feature_flags`
behind a Redis cache port, percentage rollout by `flagBucket` (FNV-1a over `${key}:${restaurantId}`,
mod 100), `GET`/`POST /api/debug/flags/:key` in M12's shape, and **the polling transport as a
complete second implementation** of §13. The transport is the larger half: `PUSH` and `POLLING` both
call the screen's own `refresh`, so they differ in latency and in nothing else — which is what makes
the flag a rollout rather than a kill switch (**ADR 008**, the last unwritten one).

The presence heartbeat moved out of `connectRealtime` into `realtime/presence-beat.ts`, driven by
both transports — an `emit` on one, `POST /api/presence` on the other — and `PresenceEntry` gained
`source`, so `/debug` names the transport each report arrived on. That closes `[M11, P2]`.

One review pass, one P1: the 15 s re-poll rebuilt the connection whenever the answer changed, and
`UNKNOWN` is a change, so one failed `GET /api/config` would have closed a working socket. The Codex
review found the rest of it — the rebuild asked *again*, after the teardown. Installing a transport
is now `open(options, resolved)`, on the answer already in hand.

**The demo percentage is a fact:** the seeded buckets are `demo-restaurant` **1** and
`second-restaurant` **24**, so `rolloutPercent: 10` puts POS-1 on push and POS-3 on polling at the
same time. A test pins both numbers.

**Demoable end to end:** the order lifecycle, a broker outage, reloading the tab mid-order, §19.2,
§19.3, §19.9, `/debug` live, every §18 control, and the rollout with both transports side by side.

**Green:** typecheck, lint, build, **365 tests** (61 domain, 96 api, 55 worker, 153 web) against a
real PostgreSQL, plus **three** under `pnpm verify:integration`. All sixteen mandatory §21 tests
exist, named by their spec number. The rollout was not driven in a browser this session.

**Next:** M14 — production images and the multi-instance smoke test. Model **Sonnet**, size **M**.

## What exists

One line per unit. The detail is in the code and in the ADRs — do not restate it here.

- **Docs** — what CLAUDE.md lists, plus briefs `milestones/M01…M13.md`. **ADRs 001–015 accepted;
  none unwritten.**
- `packages/config` — zod environment: topics, outbox, `PRINT_*`, `PRESENCE_TTL_MS`,
  `DEBUG_ROW_LIMIT`, `FLAG_CACHE_TTL_MS`.
- `packages/contracts` — statuses, mutations, events, the §5 shapes, `ConflictReason`, socket names,
  `TERMINALS`, the debug and simulator shapes, and M13's `flagBucket` / `flagAppliesTo` /
  `FlagState` / `PresenceSource` / `POLLING_INTERVAL_MS` / `CONFIG_POLL_MS`.
- `packages/domain` — `decide()`, pricing and the transitions: **the whole of §8**.
- `packages/db` — fifteen tables, three migrations, seed, `db:check`, `@pos/db/testing`, and the
  two singleton control modules.
- `apps/api` — the nine-branch mutation endpoint, the two §17 kitchen adapters, the four reads,
  `modules/realtime/` (now with `api/presence-routes.ts` and the shared `presence-report.ts`
  schema), `modules/printer/`, `/api/health/{live,ready}`, `modules/debug/` (counters, queries,
  metrics, lag, Redis presence, the four reads, the simulator pair), and **`modules/config/`** —
  `flag-store.ts`, `resolve-flags.ts` (the `FlagCache` port, rollout and fallback),
  `infrastructure/redis-flag-cache.ts`, `api/flag-routes.ts`.
- `apps/worker` — the §10 outbox publisher (ADR 010), the producer, the kitchen consumer and its
  transactional projection, `modules/printing/` (ADR 014). Two CLIs: `outbox` and `printer`.
- `apps/web` — the POS and kitchen screens; Pinia stores for menu, order, kitchen, connection,
  debug, simulator and **flags**; Dexie persistence (ADR 013); the §14 sync engine; `api/offline.ts`,
  `api/simulator-arms.ts`; `realtime/` with `socket.ts`, **`polling.ts`** and
  **`presence-beat.ts`**; `views/DebugView.vue` with `SimulatorPanel.vue` and **`FlagPanel.vue`**.
  `/demo` is still the M1 placeholder (M16).
- **Scripts and CI** — `scripts/verify-integration.mjs`, `.github/workflows/ci.yml`.

## Standing decisions

ADRs are canon; the full historical list is in `progress-archive.md`. What is not in an ADR:

- Full scope, nothing cut (Fastify and Drizzle: ADR 001, 007).
- Twenty milestones, M0–M19. **Six left: M14–M19.**
- Drop order if the date closes in: M16 (`/demo`), then M17 (PWA). Never M15 or M18 first.

## Known problems

In `docs/known-problems.md`: accepted limits, then the P2/P3 backlog. **Do not read it to start a
session.** What bears on M14 is named in the block below.

## First command of the next session

```
Read CLAUDE.md and docs/PROGRESS.md, then expand M14 from docs/MILESTONES.md into
docs/milestones/M14.md and implement M14 only. Stop when the M14 Verification block passes.

M14 is production images and the multi-instance smoke test: a multi-stage Dockerfile per app
(non-root, built output only), a Compose overlay running two `api` replicas behind the Redis
adapter, and a test asserting that a mutation applied via replica A reaches a WebSocket client
attached to replica B. Verification is scenario §19.10. Model: Sonnet. Size: M.

Six things worth knowing before you plan:

1. **This milestone is what turns the Redis-adapter claim into a tested fact.** §13 has asserted
   cross-instance broadcast since M5 and nothing has ever proved it. The smoke test is the
   deliverable; the images exist to make two replicas runnable.
2. **The build is a pnpm workspace with four internal packages**, and every app imports built
   `dist/` output (`pnpm run build:packages` precedes every typecheck). A naive per-app Dockerfile
   that copies one app directory will not resolve `@pos/db`. Plan the context and the prune step
   before writing the first `FROM`.
3. **Two things are per-instance on purpose and will look like bugs in a two-replica run.**
   `socketCount()` is this instance's own sockets (`apps/api/src/modules/realtime/socket-server.ts`
   says why), and the M11 in-process counter registry (`modules/debug/application/counters.ts`) is
   per instance too — so `/debug` will show whichever replica answered. The shared counters in Redis
   are the ones that aggregate. Do not "fix" either without reading those comments.
4. **The worker must stay a single instance.** The outbox publisher's lease makes concurrent
   claiming safe (§21.16 tests it), but nothing in this demo asks for two publishers, and a second
   one would change what `/debug`'s backlog numbers mean.
5. **`pnpm verify:integration` is the model for anything scripted.** It brings Compose up, waits for
   readiness, runs, tears down, and writes to a file — `scripts/verify-integration.mjs`. The smoke
   test wants the same treatment rather than a live log stream, and CLAUDE.md forbids pulling
   container logs into the session.
6. **Do not sweep the review backlog.** Seven entries: two M11 P2, two M11 P3, two M12 P3, and
   M13's P2 — a flag-cache fill that can land after an invalidation. The sweep is its own pass and
   M14 is not it.

Verification: `pnpm -F @pos/api test`, lint, typecheck, build, `pnpm verify:integration`, and the
new two-replica smoke run. Run tests narrowly. One review pass at the end, P1s only.

Running the system: `pnpm -F @pos/api start` and `pnpm -F @pos/worker dev` both work and the demo
database is migrated. Compose was up at the end of M13. `feature_flags` is reference data — it
survives a test truncate — so if transports look wrong, check what the flag row actually says
before suspecting the client.
```
