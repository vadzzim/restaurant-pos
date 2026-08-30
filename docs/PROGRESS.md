# Progress / Handoff

> **The only progress file read at the start of a session**, with `docs/milestones/MXX.md`; `grep`
> the others, never open them whole. **Hard limit 8 000 characters** — overflow goes to
> `known-problems.md`, `build-log.md` or `progress-archive.md`. Rewrite per milestone, never append.

## Current state

**Last completed:** M15 — POS UX for rush, and BAR-1. §16's POS in full: large touch targets, the
menu tile *is* the quantity control, a one-tap cover pad instead of a keyboard, a conflict banner
leading with its two actions, a terminal switcher, BAR-1 as a bar rather than a third POS.

**It turned out to be a concurrency fix wearing a UX hat.** `PosView` held one `busy` flag around
every action, each ending in `await sync()` — so the till was disabled for a round trip on every
tap. §14's optimism was already in the store; the view threw it away.

**Deleting the flag alone would have broken correctness — this is the invariant to carry forward.**
`identityFor` stamps `baseVersion` from the *projection*, so two overlapping taps stamp the **same**
version and the second is answered `ORDER_VERSION_CONFLICT`. The flag was serializing the local
phase as a side effect of disabling the screen. `enqueue` split into `stage` (validate, save,
refresh) and `settle` (the network), and `serialize()` chains **only the local phase**.

**Codex then found five P1s, all one family: not everything reading the projection had moved into
the chain.** Three fixed — the ± steppers computed their absolute quantity in the **template**, off
a row several taps stale, so one `+` overwrote everything queued behind it; `createOrder` and
`clear` moved the order pointer **outside** the chain, re-pointing taps still staging; and
`committing` did not close the item controls, leaving a gap where a tap queued behind a status
change halts the order. So `command()` takes a *plan* evaluated inside the link, the pointer moves
inside it, and `canTouchItems = can.order && !committing`. Two logged as `[M15, P2]` — paths M15 did
not create. Each fix was checked by reverting it and watching the new tests fail. **Anything that
queues a mutation, or moves the order pointer, goes through `serialize()`.**

**A browser was opened** — the first since M10; the run is in `build-log.md`. 1024 × 768, `PUSH`,
`fetch` delayed 1.5 s. Six taps as fast as they could be clicked: six mutations, `v7`, nothing
greyed out, queue drained clean. BAR-1 in one tap. The conflict banner on a **real** race (POS-1
offline at v2, `curl` as POS-2 to v3, back online); rebase reapplied at v4. Post-review: 3 → 4 → 5
on two quick `+`, and every item control greying the instant Send is pressed.

**Green:** typecheck, lint, build, **393 tests** (61 domain, 96 api, 55 worker, **181 web**) against
a real PostgreSQL. `verify:integration` / `verify:multi` not re-run: nothing outside `apps/web`,
`packages/contracts` and the seed changed.

**Next:** M16 — `/demo`. **Sonnet**, size **M**.

## What exists

One line per unit; detail lives in the code and the ADRs.

- **Docs** — what CLAUDE.md lists, plus `milestones/M01…M15.md`. **ADRs 001–016 accepted.**
- `packages/config` — zod environment; everything defaults, so the images pass no `.env`.
- `packages/contracts` — the §5 shapes, statuses, mutations, events, `ConflictReason`, socket names,
  `TERMINALS` (now with `profile`), **`BAR_MENU`**, debug/simulator/flag shapes.
- `packages/domain` — `decide()`, pricing and the transitions: **the whole of §8**.
- `packages/db` — fifteen tables, three migrations, seed (**11 products**, four new drinks),
  `db:check`, `@pos/db/testing`, two singleton control modules.
- `apps/api` — the nine-branch mutation endpoint, the two §17 kitchen adapters, the four reads,
  `modules/{realtime,printer,debug,config}/`, `/api/health/{live,ready}`. Ten test files, plus
  `multi-instance.integration.test.ts` behind its own config, **excluded** by default.
- `apps/worker` — the §10 outbox publisher (ADR 010), the producer, the kitchen consumer and its
  transactional projection, `modules/printing/` (ADR 014). CLIs `outbox`/`printer`.
- `apps/web` — POS and kitchen screens; seven Pinia stores; Dexie (ADR 013); the §14 sync engine;
  `realtime/`; `DebugView.vue`; **`domain/pos-screen.ts`** (tiles, affordances, conflict headline,
  bar filter — pure and tested). `/demo` is the M1 stub.
- **Images, Compose, scripts, CI** — a Dockerfile per app, `nginx.conf`, `docker-compose.multi.yml`
  (the base file's `app` profile is the *dev* stack), `compose-run.mjs`, two `verify-*.mjs`, `ci.yml`.

## Standing decisions

ADRs are canon; history in `progress-archive.md`. What is not in one:

- Full scope, nothing cut (Fastify, Drizzle: ADR 001, 007). **Four left: M16–M19.**
- Drop order if the date closes in: M16, then M17 (PWA). Never M18 first.
- **`BAR_MENU` is in contracts, not a `products.category` column** — a column means a migration +
  contract + API + seed change for one client-side filter. Argued beside the constant.

## Known problems

`docs/known-problems.md`: accepted limits, then the P2/P3 backlog — now **seventeen** entries, six
new from M15, two of them concurrency rather than tidying. **Do not read it to start a session.**

## First command of the next session

```
Read CLAUDE.md and docs/PROGRESS.md, then expand M16 from docs/MILESTONES.md into
docs/milestones/M16.md and implement M16 only. Stop when the M16 Verification block passes.

M16 is /demo: a guided walkthrough of all ten §19 scenarios, step by step, saying what to watch,
with trigger buttons calling the M12 simulator. Verification: each scenario can be performed by
following the instructions, no improvisation. Model: Sonnet. Size: M.

Six things worth knowing before you plan:

1. **`/demo` is still the M1 `PlaceholderView`**, wired in `router.ts`; the nav link exists.
2. **Do not re-derive the scenarios.** §19 of `docs/spec.md` is the source — grep it, never read it
   whole. §19.10 is already a passing test (`pnpm verify:multi`): say so, do not fake it as manual.
3. **Respect the simulator's client/server split** (ADR 015). One-shots and latches live in
   `api/simulator-arms.ts` — lifetime is the tab, so an SPA walk from /demo to a POS keeps them, a
   hard reload does not; server-side ones go through `stores/simulator.ts`. `/debug` renders them
   all already: reuse `SimulatorPanel.vue`, do not build a second set of buttons.
4. **`Create Version Conflict` is broken two ways and will bite you.** It sends `baseVersion - 1`,
   which on an order at v1 is 0 and is refused as *invalid*, not conflicting; and its `spend()`
   only runs when the POST returns, so that failed tamper leaves the arm armed and wedges every
   later mutation from the tab. Both `[M15, P1-in-M12]`. If §19 needs it, **fixing it is in scope.**
5. **Walking away from a POS screen clears its order** — `onBeforeUnmount` calls `orders.clear()`,
   dropping the persisted pointer, so `/demo` → `/pos/pos-1` → `/demo` loses the order on screen.
   Pre-existing M8 behaviour; decide deliberately whether M16 changes it.
6. **Anything that queues a mutation, or moves the order pointer, goes through `serialize()` in the
   order store.** That is what M15's review round was about and it is easy to break by accident.
   Do not sweep the backlog (seventeen entries, overdue, its own pass).

Verification: `pnpm -F @pos/web test`, lint, typecheck, build, and the browser — walk three
scenarios end to end following only the page. One review pass, P1s only.

Running it: `pnpm -F @pos/api start`, `pnpm -F @pos/worker dev`, `pnpm dev` on :5173. The database
is migrated and seeded (11 products). Postgres/Redis/Redpanda were up at the end of M15 but the
worker was NOT — the outbox has a backlog, so start it or expect `/debug` to show one.
```
