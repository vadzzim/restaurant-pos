# Progress / Handoff

> **The only progress file read at the start of a session**, with `docs/milestones/MXX.md`.
> `grep` the others; never open them whole.
>
> **Hard limit: 8 000 characters.** Overflow belongs in `known-problems.md`, `build-log.md` or
> `progress-archive.md`. Rewrite the sections below each milestone; do not append to them.

## Current state

**Last completed:** M14 — production images and the multi-instance smoke test. §22 in full: a
multi-stage Dockerfile per app (non-root, built output only, **ADR 016**), `docker-compose.multi.yml`
with **two addressable API replicas**, one worker and the built web on nginx in front of both, and
`pnpm verify:multi` — which builds the images, brings the stack up, migrates, runs §19.10 and tears
down only what it started.

**§19.10 is now a tested fact, and the test's argument is the deliverable.** Nothing in `apps/api`
broadcasts from the mutation handler; the only `RealtimeEmitter` producer is
`modules/realtime/consumer.ts`. The event travels outbox → worker → Kafka → the realtime group →
*one* replica → the Redis adapter → the rest, and which replica consumes is not ours to choose. So
the test watches **both** sockets: `handleRealtimeEvent` writes `processed_events` before it emits,
so exactly one replica in the fleet ever emits a given event, and two instances delivering the same
`eventId` is the Redis fan-out and nothing else.

**One real defect fell out of the images.** `loadEnv()` in `apps/web/vite.config.ts` is not
read-only: a `NODE_ENV` in the files it reads is promoted to `process.env.VITE_USER_NODE_ENV`, which
is what Vite consults for the build's mode — and the root `.env` says `development`. Every
`pnpm build` since M1 emitted a *development* bundle, 446 kB against the image's 307 kB. The image,
having no `.env`, was the only correct production build here. Fixed; both now emit the same file.

**The Codex review found one P1, fixed:** the smoke run migrated whatever `DATABASE_URL` named while
the replicas are hard-coded to the stack's `postgres`. The schema steps now pin
`STACK_DATABASE_URL`, and `run()` in `compose-run.mjs` grew an `env` override — proved with a
deliberately wrong `DATABASE_URL` in the shell.

**Demoable end to end:** the order lifecycle, a broker outage, a tab reloaded mid-order, §19.2,
§19.3, §19.9, §19.10, `/debug` live, every §18 control, the flag rollout on both transports.

**Green:** typecheck, lint, build, **365 tests** (61 domain, 96 api, 55 worker, 153 web) against a
real PostgreSQL, **three** under `pnpm verify:integration`, and **one** under `pnpm verify:multi`.
All sixteen mandatory §21 tests exist, named by their spec number. No browser was opened this
session.

**Next:** M15 — POS UX for rush and BAR-1. Model **Sonnet**, size **M**.

## What exists

One line per unit. The detail is in the code and in the ADRs — do not restate it here.

- **Docs** — what CLAUDE.md lists, plus briefs `milestones/M01…M14.md`. **ADRs 001–016 accepted.**
- `packages/config` — zod environment: topics, outbox, `PRINT_*`, `PRESENCE_TTL_MS`,
  `DEBUG_ROW_LIMIT`, `FLAG_CACHE_TTL_MS`. Everything has a default; the images pass no `.env`.
- `packages/contracts` — statuses, mutations, events, the §5 shapes, `ConflictReason`, socket names,
  `TERMINALS`, and the debug, simulator and flag shapes.
- `packages/domain` — `decide()`, pricing and the transitions: **the whole of §8**.
- `packages/db` — fifteen tables, three migrations, seed, `db:check`, `@pos/db/testing`, and the
  two singleton control modules.
- `apps/api` — the nine-branch mutation endpoint, the two §17 kitchen adapters, the four reads,
  `modules/realtime/`, `modules/printer/`, `/api/health/{live,ready}`, `modules/debug/`,
  `modules/config/`. Ten test files under `pnpm -F @pos/api test`, plus
  `test/multi-instance.integration.test.ts` behind `vitest.integration.config.ts` and **excluded**
  from the default config, so the normal suite still runs against a database alone.
- `apps/worker` — the §10 outbox publisher (ADR 010), the producer, the kitchen consumer and its
  transactional projection, `modules/printing/` (ADR 014). Two CLIs: `outbox` and `printer`.
- `apps/web` — the POS and kitchen screens; Pinia stores for menu, order, kitchen, connection,
  debug, simulator and flags; Dexie persistence (ADR 013); the §14 sync engine; `realtime/` with
  `socket.ts`, `polling.ts`, `presence-beat.ts`; `views/DebugView.vue`. `/demo` is the M1 stub (M16).
- **Images and Compose** — `apps/{api,worker,web}/Dockerfile`, `apps/web/nginx.conf`, root
  `.dockerignore`, `docker-compose.multi.yml`. The base file's `app` profile is unchanged and is the
  *development* stack: it mounts the tree and runs `tsx`.
- **Scripts and CI** — `scripts/lib/compose-run.mjs` (the shared Compose lifecycle),
  `verify-integration.mjs`, `verify-multi-instance.mjs`, and `ci.yml` with a second job for images.

## Standing decisions

ADRs are canon; the full historical list is in `progress-archive.md`. What is not in an ADR:

- Full scope, nothing cut (Fastify and Drizzle: ADR 001, 007).
- Twenty milestones, M0–M19. **Five left: M15–M19.**
- Drop order if the date closes in: M16 (`/demo`), then M17 (PWA). Never M15 or M18 first.

## Known problems

In `docs/known-problems.md`: accepted limits, then the P2/P3 backlog, now **eleven** entries, four
new from M14. **Do not read it to start a session.** The sweep is its own pass; M15 is not it.

## First command of the next session

```
Read CLAUDE.md and docs/PROGRESS.md, then expand M15 from docs/MILESTONES.md into
docs/milestones/M15.md and implement M15 only. Stop when the M15 Verification block passes.

M15 is POS UX for rush: large touch targets, one-tap quantity, no modals on the critical path, a
clear conflict banner, and the `bar-1` terminal wired up. Verification is a browser: the full flow
comfortable at speed in a window sized like a terminal. Model: Sonnet. Size: M.

Six things worth knowing before you plan:

1. **This is the first milestone whose verification is a browser, not a test.** The last four
   sessions each ended with "no browser was opened". M15 cannot: "comfortable at speed" is a claim
   only a window can make. Plan on driving it, and say in PROGRESS.md what you actually saw.
2. **`bar-1` already exists in `TERMINALS`** (`packages/contracts`) with `restaurantId:
   demo-restaurant`, beside `pos-1` and `pos-2`. What is missing is the route and whatever the
   screen needs to be a bar terminal rather than a third POS. Check what `/pos/:terminalId`
   already does before adding anything.
3. **The conflict banner has a data source already.** M8's sync engine halts the queue on 409 and
   `BLOCKED`; the store knows the reason (`ConflictReason`) and the operator's two choices are
   discard and rebase. This milestone is the presentation of that, not new conflict logic — the
   rules live in one domain component and stay there.
4. **Do not touch the transports.** M13 made `PUSH` and `POLLING` differ in latency and nothing
   else. A UX change that assumes push (an optimistic animation waiting on a socket event) breaks
   the polling half silently, and `/debug` is what would show it.
5. **`apps/web` has 153 tests** and they are the regression net for every store this touches.
   Run `pnpm -F @pos/web test`, narrowly, and keep the count moving up.
6. **Do not sweep the review backlog.** Eleven entries; the sweep is its own pass.

Verification: `pnpm -F @pos/web test`, lint, typecheck, build, and the browser flow. One review
pass at the end, P1s only.

Running the system: `pnpm -F @pos/api start` and `pnpm -F @pos/worker dev` both work and the demo
database is migrated. Compose infrastructure was up at the end of M14; the two-replica stack was
torn down. `pnpm dev` on :5173 is the normal loop; `pnpm verify:multi --keep` puts the built app on
:8081 in front of both replicas if M15 wants to see itself through nginx.
```
