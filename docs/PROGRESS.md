# Progress / Handoff

> **The only progress file read at the start of a session**, with `docs/milestones/MXX.md`.
> `grep` the others; never open them whole. **Hard limit: 8 000 characters** — overflow belongs in
> `known-problems.md`, `build-log.md` or `progress-archive.md`. Rewrite each section per milestone;
> never append.

## Current state

**Last completed:** M15 — POS UX for rush, and BAR-1. §16's POS in full: large touch targets, the
menu tile *is* the quantity control, a one-tap cover pad instead of a keyboard, a conflict banner
that leads with its two actions, a terminal switcher, and BAR-1 as a bar, not a third POS.

**It turned out to be a concurrency fix wearing a UX hat.** `PosView` held one `busy` flag around
every action, and every action ended in `await sync()` — so the whole till was disabled for a round
trip on every tap. §14's optimism was already in the store; the view was throwing it away.

**Deleting the flag alone would have broken correctness**, and this is the invariant to carry
forward: `identityFor` stamps `baseVersion` from the *projection*, so two overlapping taps stamp the
**same** version and the second is answered `ORDER_VERSION_CONFLICT`. The flag was serializing the
local phase as a side effect of disabling the screen. `enqueue` therefore split into `stage`
(validate, save, refresh) and `settle` (the network), and `serialize()` chains **only the local
phase** — `command()` runs its halt check, `identityFor` and `stage` in one link, because all three
read the projection. Public promise semantics are unchanged, so the 153 existing tests were
untouched. `test/rush-taps.test.ts` pins it: disabling `serialize` turns `[3, 4, 5, 6]` into
`[3, 3, 3, 3]` — checked, not assumed. **Anything that queues a mutation must go through that
chain.**

**A browser was opened** — the first since M10; details in `build-log.md`. 1024 × 768, `PUSH`,
`fetch` delayed 1.5 s. Six taps as fast as they could be clicked: six mutations, `v7`, nothing
greyed out, queue drained clean. BAR-1 in one tap. The conflict banner proved on a **real** race
(POS-1 offline at v2, `curl` as POS-2 to v3, back online); rebase reapplied at v4. The browser
caught one defect no test would have — `Tab Tab 2`, now fixed with a test.

**Green:** typecheck, lint, build, **387 tests** (61 domain, 96 api, 55 worker, **175 web**) against
a real PostgreSQL. `verify:integration` / `verify:multi` were not re-run: nothing outside
`apps/web`, `packages/contracts` and the seed changed.

**Next:** M16 — `/demo`. Model **Sonnet**, size **M**.

## What exists

One line per unit. The detail is in the code and the ADRs — do not restate it here.

- **Docs** — what CLAUDE.md lists, plus briefs `milestones/M01…M15.md`. **ADRs 001–016 accepted.**
- `packages/config` — zod environment; everything defaults, so the images pass no `.env`.
- `packages/contracts` — the §5 shapes, statuses, mutations, events, `ConflictReason`, socket names,
  `TERMINALS` (now with `profile: 'dining' | 'bar'`), **`BAR_MENU`**, debug/simulator/flag shapes.
- `packages/domain` — `decide()`, pricing and the transitions: **the whole of §8**.
- `packages/db` — fifteen tables, three migrations, seed (**11 products**, four new drinks),
  `db:check`, `@pos/db/testing`, the two singleton control modules.
- `apps/api` — the nine-branch mutation endpoint, the two §17 kitchen adapters, the four reads,
  `modules/{realtime,printer,debug,config}/`, `/api/health/{live,ready}`. Ten test files, plus
  `test/multi-instance.integration.test.ts` behind its own config, **excluded** from the default.
- `apps/worker` — the §10 outbox publisher (ADR 010), the producer, the kitchen consumer and its
  transactional projection, `modules/printing/` (ADR 014). CLIs `outbox` and `printer`.
- `apps/web` — the POS and kitchen screens; seven Pinia stores; Dexie persistence (ADR 013); the
  §14 sync engine; `realtime/`; `views/DebugView.vue`; **`domain/pos-screen.ts`** (tiles,
  affordances, the conflict headline, the bar filter — pure and tested). `/demo` is the M1 stub.
- **Images, Compose, scripts, CI** — a Dockerfile per app, `nginx.conf`,
  `docker-compose.multi.yml` (the base file's `app` profile is the *dev* stack), `compose-run.mjs`,
  `verify-{integration,multi-instance}.mjs`, `ci.yml`.

## Standing decisions

ADRs are canon; the history is in `progress-archive.md`. What is not in an ADR:

- Full scope, nothing cut (Fastify and Drizzle: ADR 001, 007). **Four milestones left: M16–M19.**
- Drop order if the date closes in: M16 (`/demo`), then M17 (PWA). Never M18 first.
- **`BAR_MENU` lives in contracts, not as a `products.category` column** — a column would be a
  migration + contract + API + seed change to drive one client-side filter no server code reads.
  The cost: a new seeded product is invisible at the bar until named there, which is the right
  failure. Argued in full beside the constant.

## Known problems

`docs/known-problems.md`: accepted limits, then the P2/P3 backlog, now **fifteen** entries, four new
from M15. **Do not read it to start a session.** The sweep is its own pass; M16 is not it.

## First command of the next session

```
Read CLAUDE.md and docs/PROGRESS.md, then expand M16 from docs/MILESTONES.md into
docs/milestones/M16.md and implement M16 only. Stop when the M16 Verification block passes.

M16 is /demo: a guided walkthrough of all ten §19 scenarios, step by step, saying what to watch,
with trigger buttons calling the M12 simulator. Verification: each scenario can be performed by
following the instructions, with no improvisation. Model: Sonnet. Size: M.

Six things worth knowing before you plan:

1. **`/demo` is still the M1 `PlaceholderView`**, wired in `router.ts`. The nav link already exists.
2. **Do not re-derive the scenarios.** §19 of `docs/spec.md` is the source — grep it, never read it
   whole. §19.10 is already a passing test (`pnpm verify:multi`): the page should say so and link
   it, not pretend it is manual.
3. **Respect the simulator's client/server split** (ADR 015). One-shots and latches live in
   `api/simulator-arms.ts` — lifetime is the tab, so an SPA walk from /demo to a POS keeps them and
   a hard reload does not; the server-side ones go through `stores/simulator.ts`. `/debug` already
   renders every control: reuse `SimulatorPanel.vue`, do not build a second set of buttons.
4. **`Create Version Conflict` is broken two ways and it will bite you.** It sends
   `baseVersion - 1`, which on an order at v1 is 0 and is refused as *invalid* rather than
   conflicting; and its `spend()` only runs when the POST returns, so that failed tamper leaves the
   arm armed and wedges every later mutation from the tab. Both are `[M15, P1-in-M12]` in
   `known-problems.md`. If §19 needs the button, **fixing it is in scope for M16.**
5. **Walking away from a POS screen clears its order.** `onBeforeUnmount` calls `orders.clear()`,
   which clears the persisted pointer, so `/demo` → `/pos/pos-1` → `/demo` loses the order on
   screen. A guided demo that sends the operator back and forth has to know this. Pre-existing M8
   behaviour, not a regression — decide deliberately whether M16 changes it.
6. **Do not sweep the review backlog.** Fifteen entries; the sweep is its own pass and is overdue —
   say so in PROGRESS.md if M16 leaves it at fifteen or more.

Verification: `pnpm -F @pos/web test`, lint, typecheck, build, and the browser — walk three
scenarios end to end following only what the page says. One review pass, P1s only.

Running it: `pnpm -F @pos/api start`, `pnpm -F @pos/worker dev`, `pnpm dev` on :5173. The demo
database is migrated and seeded (11 products). Postgres/Redis/Redpanda were up at the end of M15,
but the worker was NOT — the outbox has a backlog, so start it or expect `/debug` to show one.
```
