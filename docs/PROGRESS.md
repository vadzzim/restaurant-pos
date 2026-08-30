# Progress / Handoff

> **The only progress file read at the start of a session**, with `docs/milestones/MXX.md`.
> `grep` the others; never open them whole.
>
> **Hard limit: 8 000 characters.** Overflow belongs in `known-problems.md`, `build-log.md` or
> `progress-archive.md`. Rewrite the sections below each milestone; do not append to them.

## Current state

**Last completed:** M11 — the debug dashboard. Five §17 endpoints with a decided ownership split,
every §20 counter carrying **where it comes from** (`process` / `database` / `shared` / `client`),
terminal presence in Redis with a TTL, consumer lag from a Kafka admin, and `/debug` rendering the
seven §16 sections it owns. Read-only: not one button. One review pass, one P1 — a leaked Kafka
admin client under overlapping polls, which would have stopped the API exiting on SIGTERM. The
argument is in `build-log.md`; the one-line lesson is that **a fact with a row needs no transport**,
so only one counter needed Redis.

Two pre-existing defects surfaced by running the system, both fixed here because they blocked
M11's verification: the worker could not boot under Node's ESM loader (`KafkaJSProtocolError` is
not a detectable named export of a CommonJS `kafkajs` — green under vitest and tsup, `SyntaxError`
in production), and `pnpm lint` was already red on two doc files.

**Demoable end to end:** the order lifecycle, a broker outage, reloading the tab mid-order, §19.2,
§19.3, §19.9, and now `/debug` populating live. The publisher and the printer are still driven from
a terminal, not a button.

**Green:** typecheck, lint, build, **319 tests** (61 domain, 73 api, 55 worker, 130 web) against a
real PostgreSQL, plus **three** under `pnpm verify:integration`. All sixteen mandatory §21 tests
exist, named by their spec number.

**Next:** M12 — the failure simulator. Model **Sonnet**, size **M**. The brief is at the bottom.

## What exists

One line per unit. The detail is in the code and in the ADRs — do not restate it here.

- **Docs** — what CLAUDE.md lists, plus briefs `milestones/M01…M11.md`. ADRs 001–007 and 009–014
  accepted; only 008 (M13) is unwritten.
- `packages/config` — zod environment: topics, outbox, `PRINT_*`, `PRESENCE_TTL_MS`,
  `DEBUG_ROW_LIMIT`.
- `packages/contracts` — statuses, mutations, events, the §5 shapes, `ConflictReason`, socket
  names, `TERMINALS`, and the M11 debug shapes: `CounterReading`/`CounterSource`, `PresenceEntry`,
  `PresenceReport`, the four debug responses, `ConsumerLagReport`, and the two pure key functions
  `sharedCounterKey` / `presenceKey` that stop two processes spelling one Redis key two ways.
- `packages/domain` — `decide()` and the pricing and transition rules: **the whole of §8**.
- `packages/db` — fifteen tables, three migrations, seed, `db:check`, `@pos/db/testing`.
- `apps/api` — the nine-branch mutation endpoint, the two §17 kitchen adapters, the four reads,
  `modules/realtime/` (Socket.IO with presence writes, Redis adapter, the §12.2 consumer),
  `modules/printer/`, `/api/health/{live,ready}`, `/api/debug/dependencies` (now with lag), and
  **`modules/debug/`** — the counter registry, the reporting queries, the metrics assembly, the lag
  probe, the Redis presence and shared-counter store, and the four debug routes.
- `apps/worker` — the §10 outbox publisher (ADR 010), the Kafka producer, the kitchen consumer and
  its transactional projection, `modules/printing/` (ADR 014). Two CLIs: `outbox` and `printer`.
- `apps/web` — the POS and kitchen screens; Pinia stores for menu, order, kitchen, connection and
  **debug**; Dexie persistence (ADR 013), now with `syncCounters` at schema v2; the §14 sync engine;
  the offline switch (ADR 002); the presence heartbeat in `realtime/socket.ts`; `domain/debug-view.ts`
  (every judgement `/debug` makes, as pure functions) and `views/DebugView.vue`. `/demo` is still
  the M1 placeholder (M16).
- **Scripts and CI** — `scripts/verify-integration.mjs`, `.github/workflows/ci.yml`.

## Standing decisions

ADRs are canon; the full historical list is in `progress-archive.md`. What is not in an ADR:

- Full scope, nothing cut (Fastify and Drizzle: ADR 001, 007).
- Twenty milestones, M0–M19. **Eight left: M12–M19.**
- Drop order if the date closes in: M16 (`/demo`), then M17 (PWA). Never M15 or M18 first.

## Known problems

In `docs/known-problems.md`: accepted limits, then the P2/P3 backlog, no longer empty. **Do not
read it to start a session.** What bears on M12 is named in the block below.

## First command of the next session

```
Read CLAUDE.md and docs/PROGRESS.md, then expand M12 from docs/MILESTONES.md into
docs/milestones/M12.md and implement M12 only. Stop when the M12 Verification block passes.

M12 is the failure simulator: §18's eleven controls, each with visible feedback, on `/debug`.
Verification: exercise every control. Model: Sonnet. Size: M.

Six things worth knowing before you plan:

1. **Most of the switches already exist; almost none of them has a button.** `Simulate Offline` is
   a per-terminal `ref` in `apps/web/src/api/offline.ts` with a toggle in the POS header;
   `Pause Outbox Publisher` and `Delay Outbox Publishing` are the `outbox_controls` singleton row,
   flipped by `pnpm -F @pos/worker outbox`; `Fail Printer` is the `printer_controls` singleton,
   flipped by `… printer fail` / `fix`. M12 is mostly **wiring**, plus writes for the ones with no
   mechanism yet. Read the `known-problems.md` entry that names where all eleven live today.
2. **M11 built the page and deliberately built no control.** `/debug` polls five read-only
   endpoints every 2 s and `apps/web/src/stores/debug.ts` writes nothing anywhere. The failure
   simulator has a named placeholder section at the bottom of `DebugView.vue`; that is where it
   goes. Every control needs a **write** endpoint, and §17's list has exactly one:
   `POST /api/debug/flags/:key`, which is M13's. Decide up front what the new write surface is and
   say so in the brief — inventing five endpoints is the failure mode here.
3. **A control is only useful if its effect is visible on the same screen.** M11 gives you that
   for free: pausing the publisher makes `outboxEventsPending` climb and the backlog age grow;
   failing the printer moves `print_jobs` through `FAILED` and then `DEAD_LETTER`; taking a
   terminal offline shows `OFFLINE` and a rising `PENDING n` on its presence row. Prefer a control
   whose feedback is an existing number over one that needs a new indicator.
4. **The switches live in three lifetimes, and that is the interesting part.** `Simulate Offline`
   is per browser and dies with the tab; `outbox_controls` and `printer_controls` are singleton
   rows a human threw that must survive a worker restart; anything you add in Redis expires. Say
   which is which next to each control, exactly as M11 does for its counters.
5. **The publisher observes a pause within one `OUTBOX_POLL_MS`, not instantly**, and
   `outbox_controls` is fleet-wide — two workers cannot be paused independently. Both are in
   `known-problems.md`. A button that implies otherwise is worse than no button.
6. **Do not fix the M11 review backlog** — three entries, swept in a dedicated pass, not here.

Verification is `pnpm -F @pos/api test`, `pnpm -F @pos/web test`, lint, typecheck, build, and
`pnpm verify:integration`. Run tests narrowly; do not run the whole monorepo suite.
One review pass at the end, P1s only — see CLAUDE.md, "Review discipline".

Note on running the system: `pnpm -F @pos/api start` and `pnpm -F @pos/worker dev` both work, and
the demo database is migrated. If a section of /debug is empty, check the worker is actually up
before suspecting the query.
```
