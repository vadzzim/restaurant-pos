# Progress / Handoff

> **The only progress file read at the start of a session**, with `docs/milestones/MXX.md`; `grep`
> the others, never open them whole. **Hard limit 8 000 characters** — overflow goes to
> `known-problems.md`, `build-log.md` or `progress-archive.md`. Rewrite per milestone, never append.

## Current state

**Last completed:** M16 — `/demo`. All ten §19 scenarios as a guided walkthrough: what to press, in
which window, and what to watch. The script is **data** in `domain/demo-script.ts`; `DemoView.vue`
only renders it, so "does every scenario name a control that exists" is a test, not a walk-through.

**One `SimulatorPanel`, not two.** `/debug` already renders §18's eleven controls and they are the
same module state, so `/demo` embeds that component; each step links to a control's row by anchor,
and control names come from one `CONTROL_LABELS` map the panel's buttons read too — a step saying
"press X" beside a button reading "Y" is the defect this milestone is judged on.
`demo-script.test.ts` reads the **real** `SimulatorPanel.vue` and `router.ts`, not a copy.

**Two M12 P1s fixed in `Create Version Conflict`, both flagged in advance by M15's handoff.** It
sent `baseVersion - 1` from v1, which `mutation-routes.ts` refuses as `min(1)` — a 400, not a
conflict; the threshold is now **v2**. And `spend()` ran only on a returned response, so that 400
left the arm armed and tampered with every later mutation from the tab; it is now spent on an
`ApiRequestError` too — the server answered — but still **not** on the offline gate or a dead
socket, which is what the original guard is for.

**`onBeforeUnmount` no longer calls `clear()`.** M15 left this decision open and it was
load-bearing: one-shots are armed on `/demo` and live in the tab (ADR 015), so a till emptied on
every route change could only ever spend an arm on its own `CREATE_ORDER` — three of eleven controls
were undemonstrable on an item. New **`detach()`** drops the in-memory view and leaves the pointer on
disk for `hydrate()`. It cannot simply skip the clear: the store outlives the component, and POS-1's
order left in `order.value` would be drawn on POS-2 until its own read answered. `clear()` is
untouched and is still what **New table** means.

**The browser found four defects no unit test could reach**, and disproved a fifth claim outright.
`styles.css` had `a { color: inherit }` **unlayered** — in Tailwind v4 unlayered CSS beats a layer
whatever its specificity, so it had overridden every `text-*` utility on a link since M1; both
anchor rules moved into `@layer base`. The claim rendered raw backticks; two steps named tables the
cover pad does not offer; three single-asterisk spans reached the reader as asterisks. All four now
have tests. **And §19.3's last step was wrong**: a Rebase does not resolve the conflict row — see
the P2 below. Details in `build-log.md`.

**Green:** typecheck, lint, build, **414 tests** (61 domain, 96 api, 55 worker, **202 web**), and
§19.4, §19.7 and §19.3 walked end to end against a real stack reading only the page.
`verify:integration` / `verify:multi` not re-run: nothing outside `apps/web` changed.

**Next:** M17 — PWA. **Sonnet**, size **S**.

## What exists

One line per unit; detail lives in the code and the ADRs.

- **Docs** — what CLAUDE.md lists, plus `milestones/M01…M16.md`. **ADRs 001–016 accepted.**
- `packages/config` zod env (all defaulted); `packages/contracts` the §5 shapes plus `TERMINALS`,
  `BAR_MENU` and the debug/simulator/flag shapes; `packages/domain` `decide()` — **the whole of §8**;
  `packages/db` fifteen tables, three migrations, seed (11 products), `@pos/db/testing`.
- `apps/api` — the nine-branch mutation endpoint, the two §17 kitchen adapters, the four reads,
  `modules/{realtime,printer,debug,config}/`, `/api/health/{live,ready}`. Ten test files, plus
  `multi-instance.integration.test.ts` behind its own config, **excluded** by default.
- `apps/worker` — the §10 outbox publisher (ADR 010), the producer, the kitchen consumer and its
  transactional projection, `modules/printing/` (ADR 014). CLIs `outbox`/`printer`.
- `apps/web` — POS, kitchen, `/debug` and now **`/demo`**; seven Pinia stores; Dexie (ADR 013); the
  §14 sync engine; `realtime/`; `domain/{pos-screen,demo-script}.ts` (pure and tested).
- **Images, Compose, scripts, CI** — a Dockerfile per app, `nginx.conf`, `docker-compose.multi.yml`
  (the base file's `app` profile is the *dev* stack), `compose-run.mjs`, two `verify-*.mjs`, `ci.yml`.

## Standing decisions

ADRs are canon; history in `progress-archive.md`. What is not in one:

- Full scope, nothing cut (ADR 001, 007). **Three left: M17–M19**; drop M17 first, never M18.
- **`BAR_MENU` is in contracts, not a `products.category` column.** Argued beside the constant.
- **Leaving a POS route detaches; it does not clear.** M16, above. Do not put `clear()` back.

## Known problems

`docs/known-problems.md`: accepted limits, then the P2/P3 backlog — now **twenty** entries, three new
from M16. **Overdue for its sweep pass.** Do not read it to start a session.

## First command of the next session

```
Read CLAUDE.md and docs/PROGRESS.md, then expand M17 from docs/MILESTONES.md into
docs/milestones/M17.md and implement M17 only. Stop when the M17 Verification block passes.

M17 is the PWA: manifest and service worker, carefully. It must not break dev mode, and it must
never cache API mutations or the snapshot endpoint. Installability. Verification: install the app,
reload offline, and the last local order is still on screen with the sync engine unaffected.
Model: Sonnet. Size: S.

Six things worth knowing before you plan:

1. **The offline story already exists and is not the service worker's.** Dexie holds the queue and
   the cached snapshot (ADR 013); `stores/order.ts` `hydrate()` restores from it on mount. M17 adds
   the *shell* — index.html, JS, CSS — so a cold reload with no network still boots. Do not let a
   service worker start owning data; that is a second cache over ADR 013 and it will drift.
2. **What must never be cached**, and the test must prove it: `POST /api/orders/:id/mutations`, the
   two §17 kitchen adapters, `GET /api/orders/:id` (the canonical read — a stale snapshot silently
   replaces the server's truth), `/api/debug/*`, `/api/config`. A stale `GET /api/menu` is the one
   defensible cache. Prefer an allow-list over a deny-list.
3. **Dev mode is Vite on :5173 with HMR over a WebSocket.** A service worker registered in dev
   intercepts module requests and makes HMR lie. Register in production builds only, and say so in
   the code — a future session will otherwise "fix" the guard.
4. **A stale service worker is the classic demo killer.** Decide the update strategy deliberately
   (skipWaiting + clientsClaim, or a prompt) and write it in an ADR; an interviewer reloading and
   seeing last week's bundle is worse than no PWA.
5. **`/demo` and `/debug` poll every 2 s.** Nothing there may be precached as an API response, and
   §18's arms stay tab-local (ADR 015) — a claimed client must not make it look otherwise.
6. **`onBeforeUnmount` detaches, it does not clear** (M16). The pointer on disk is what makes an
   offline reload land back on the same cover — precisely M17's verification. Do not regress it.
   Anything that queues a mutation, or moves the order pointer, goes through `serialize()`.

Verification: `pnpm -F @pos/web test`, lint, typecheck, build, and the browser — install the app,
go offline, hard reload, and confirm the order is still there and the queue still drains on
reconnect. One review pass, P1s only.

Running it: `pnpm -F @pos/api start`, `pnpm -F @pos/worker dev`, `pnpm dev` on :5173. Postgres,
Redis and Redpanda were up and the worker was running at the end of M16, with an empty outbox.
A production build is `pnpm -F @pos/web build` — M17 needs one to test the worker at all.
```
