# Progress / Handoff

> **The only progress file read at the start of a session**, with `docs/milestones/MXX.md`.
> `grep` the others; never open them whole.
>
> **Hard limit: 8 000 characters.** Overflow belongs in `known-problems.md`, `build-log.md` or
> `progress-archive.md`. Rewrite the sections below each milestone; do not append to them.

## Current state

**Last completed:** M10 — the BullMQ print job (ADR 014): a fake printer that fails on demand and
honours an idempotency key, `print_jobs` written only by the processor, `ticket_hash` as the
record's identity, bounded backoff and a dead-letter state owned by BullMQ, and a reconciliation
sweep that repairs every way an enqueue can be lost. Three review rounds, then a clean fourth:
findings 2 → 2 → 2 → 0, five fixed and one investigated and rejected. The reasoning is in
`build-log.md`; the one-line lesson is that M10's invariant — *Redis is soft, and nothing about
printing may stop an order or a kitchen ticket* — was stated correctly in an ADR and attached to
the wrong mechanism three times.

**Demoable end to end:** the whole order lifecycle, a broker outage, reloading the tab mid-order,
§19.2, §19.3 and §19.9. The publisher and the printer are driven from a terminal, not a button.

**Green:** typecheck, lint, build, **286 tests** (61 domain, 57 api, 55 worker, 113 web) against a
real PostgreSQL, plus **three integration tests** that run only under `pnpm verify:integration` —
two against a real Redpanda (§21.12, §21.13) and one against a real Redis and BullMQ worker.
**All sixteen** mandatory §21 tests exist and are named by their spec number.

**Next:** M11 — the debug dashboard. Model **Sonnet**, size **M**. The brief is at the bottom.

## What exists

One line per unit. The detail is in the code and in the ADRs — do not restate it here.

- **Docs** — the files CLAUDE.md lists, plus briefs `milestones/M01…M10.md`. ADRs 001–007 and
  009–014 accepted; only 008 (M13) is unwritten.
- `packages/config` — zod environment, Kafka topics, outbox and `PRINT_*` tuning.
- `packages/contracts` — statuses, the nine mutation types, the nine event types, every payload,
  the §5 shapes, `ConflictReason`, socket names, `TERMINALS`.
- `packages/domain` — `calculateTotalCents`, `isValidTransition`, `decide()`: **the whole of §8**,
  table-driven, no database and no HTTP.
- `packages/db` — fifteen tables, three migrations, seed, `db:check`, `@pos/db/testing`, and
  `printer-controls.ts` (the one reader and writer of the `Fail Printer` switch).
- `apps/api` — the nine-branch mutation endpoint, the two §17 kitchen adapters, the four reads,
  `modules/realtime/` (Socket.IO, Redis adapter, `roomsFor()`, the §12.2 consumer),
  `modules/printer/` (the fake device), `/api/health/{live,ready}`,
  `/api/debug/dependencies`, the §17 error envelope, and `requestId`/`traceId` on every log line.
- `apps/worker` — the §10 three-step outbox publisher with lease, backoff, dead-lettering and the
  `outbox_controls` pause/delay (ADR 010); the Kafka producer and the kitchen consumer with its
  transactional projection; `modules/printing/` — ticket hash, printer client, the processor that
  is the only writer of `print_jobs`, the BullMQ queue and worker, the sweep, and
  `shared/redis.ts` + `shared/timeout.ts` (ADR 014). Two CLIs:
  `pnpm -F @pos/worker outbox` and `… printer`.
- `apps/web` — the POS screen with all six commands and the kitchen screen with four columns and
  two; Pinia stores for menu, order, kitchen and connection; Dexie persistence (ADR 013); the §14
  sync engine with §14.1's halt and rebase, the optimistic queue projection, and the per-terminal
  offline switch (ADR 002). `/debug` and `/demo` are still the M1 placeholders (M11, M16).
- **Scripts and CI** — `scripts/verify-integration.mjs`, `.github/workflows/ci.yml`.

## Standing decisions

ADRs are canon; the full historical list is in `progress-archive.md`. What is not in an ADR:

- Full scope, nothing cut (Fastify and Drizzle: ADR 001, 007).
- Twenty milestones, M0–M19. **Nine left: M11–M19.**
- Drop order if the interview date closes in: M16 (`/demo`), then M17 (PWA). Do not drop M15 or
  M18 first.

## Known problems

In `docs/known-problems.md` — accepted limits first, then the P2/P3 review backlog. **Do not read
it to start a session.** The entries that bear on the next milestone are named in the block below.

## First command of the next session

```
Read CLAUDE.md and docs/PROGRESS.md, then expand M11 from docs/MILESTONES.md into
docs/milestones/M11.md and implement M11 only. Stop when the M11 Verification block passes.

M11 is the debug dashboard: every counter from §20, the five read endpoints
`GET /api/debug/{events,conflicts,outbox,dependencies,metrics}`, terminal presence in Redis, and
the `/debug` page with all the sections §16 asks for — including dead-lettered outbox rows, print
job state, and hard-versus-soft dependency marking. Verification: every section populates against
live traffic. Model: Sonnet. Size: M.

Seven things worth knowing before you plan:

1. **`/debug` is the first screen that reads across every subsystem**, so its risk is not the SQL
   but the shape: five endpoints, one page, and a temptation to let the page query whatever it
   likes. Decide up front what each endpoint owns, and keep the counters in one module rather
   than incremented at twenty call sites.
2. **§20's counter list is long and half of it does not exist yet.** API requests and errors,
   active sockets, mutations received/applied, duplicates prevented, id reuse rejected,
   cross-tenant rejections, conflicts, blocked mutations, outbox pending/published/dead-lettered,
   Kafka events consumed, duplicate events prevented, print jobs succeeded/failed/dead-lettered,
   offline sync successes and failures. Some are database queries (outbox, conflicts, print jobs)
   and some are in-process counters that reset on restart. **Say which is which on the page** —
   a number that silently resets is worse than no number.
3. **The counters live in two processes.** The worker publishes and prints; the API serves
   `/debug`. An in-process counter in the worker is not readable from the API without either a
   shared store (Redis) or a database read. Prefer deriving from the database where the fact is
   already there — `outbox_events`, `print_jobs`, `conflict_log` all carry their own history —
   and reach for Redis only for what genuinely has no row.
4. **Consumer lag is the one dependency number that needs a Kafka admin client.**
   `/api/debug/dependencies` has been reporting everything except lag since M6, and
   `known-problems.md` names it as the gap. It belongs here.
5. **Terminal presence in Redis is new state with a lifetime.** Decide what writes it (the
   Socket.IO connection handler), what expires it (a TTL, refreshed on activity), and what a
   stale entry means on screen. A presence list that only grows is a bug that looks like a
   feature for the first ten minutes.
6. **Read-only, and no new switches.** M12 owns §18's controls, including moving `Simulate
   Offline`, `Pause Outbox Publisher`, `Delay Outbox Publishing` and `Fail Printer` onto this
   page. M11 builds the page and the numbers; it does not build a single button.
7. **Three entries in `known-problems.md` are things M11 turns into a number, not things to fix:**
   a Redis outage is invisible today; a row can be reclaimed for ever with only a log line to show
   for it; and the kitchen projection is load-bearing for writes (ADR 012), so its lag has to be
   visible. Read those three entries; do not read the rest of the file.

Verification is `pnpm -F @pos/api test`, `pnpm -F @pos/web test`, lint, typecheck, build, and
`pnpm verify:integration`. Run tests narrowly; do not run the whole monorepo suite.
One review pass at the end, P1s only — see CLAUDE.md, "Review discipline".
```
