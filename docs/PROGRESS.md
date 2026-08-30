# Progress / Handoff

> **The only progress file read at the start of a session**, with `docs/milestones/MXX.md`; `grep`
> the others, never open them whole. **Hard limit 8 000 characters** — overflow goes to
> `known-problems.md` or `build-log.md`. Rewrite per milestone, never append.

## Current state

**Last completed:** M17 — PWA. Manifest, three generated icons, a service worker caching **the
shell and nothing else**: offline worked since M8, but *reloading* offline never reached the code
that knows how to be offline. **ADR 017.**

**The policy is an allow-list in a pure module.** `src/sw/cache-policy.ts` imports nothing, touches
no `fetch`/`caches`/DOM, and maps a request to `shell` / `asset` / `menu` / `passthrough`.
`passthrough` means the handler **returns without calling `respondWith`** — the browser performs it
as if no worker existed. Non-`GET` is decided first, **`navigate` last**: a tab pointed at
`/api/health/ready` is a navigation too, and calling it `shell` writes that JSON under the shell's
key. `GET /api/menu` is the only cached API response; `GET /api/orders/:id` never is — a stale
snapshot does not look like an error, it looks like the server's truth. `cache-policy.test.ts`
walks every endpoint in `src/api/client.ts`.

**`install` precaches the bundle, and this is the trap.** Runtime caching cannot cover it: the load
that registers the worker fetched the script **before** the worker existed, and `clients.claim()`
does not replay it — so a first visit plus an offline reload got a cached `index.html` whose script
missed. `install` now reads the asset list **out of the document it just fetched**
(`shellAssetUrls`, every hit re-checked through `classifyRequest`): no build-time manifest to go
stale, and the list can never be wider than the policy. **The same shape still bites `/api/menu`** —
first in the backlog.

**Registration is `import.meta.env.PROD`-only** — a worker in dev makes HMR lie — and updates are
`skipWaiting` + `clientsClaim` + one guarded reload. Safe only while `router.ts` imports its views
statically; ADR 017 names that as the condition to revisit.

**Built by a nested Vite build into one classic `iife` at `/sw.js`, and compiled by its own
`tsconfig.sw.json`** — `WebWorker` and `DOM` cannot share a `lib`. Why, in ADR 017's Consequences.

**The hands-on check was done, in a real Chrome driven over CDP, offline by killing the server
rather than by DevTools throttling** — and it found a P1 no unit test could: `Vary: Origin` made
the precached bundle invisible. `Cache.match` compares the *stored* request's headers, the precache
fetch has no `Origin`, and `<script crossorigin>` sends one — so the shell loaded and its script
did not. **Every cache read now passes `{ ignoreVary: true }`; do not remove it.** The fake
`CacheStorage` models `Vary` now, so it is a test. Confirmed after: shell, CSS, JS, manifest and
icons all `fromServiceWorker`, the order on screen through an ordinary reload, a fresh navigation
and a hard reload, and the queue draining on restart.

**Green:** typecheck (two projects for web now), lint, build, **447 tests** (61 domain, 96 api,
55 worker, **247 web**). `verify:*` not re-run: nothing outside `apps/web` changed.

**Three P1s, none from my own pass:** Codex found the precache (plus a navigate-ordering bug), and
the browser found `Vary` and an uncaught `update()` rejection. All fixed. Codex's third finding (the
menu revalidation is not held by `event.waitUntil`) is in the backlog.

**Next:** M18 — Playwright E2E. **Sonnet**, size **M**.


## What exists

One line per unit; detail lives in the code and the ADRs.

- **Docs** — what CLAUDE.md lists, plus `milestones/M01…M17.md`. **ADRs 001–017 accepted.**
- `packages/` — `config` zod env (all defaulted); `contracts` the §5 shapes plus `TERMINALS` and
  `BAR_MENU`; `domain` `decide()`, **the whole of §8**; `db` fifteen tables, three migrations,
  seed (11 products), `@pos/db/testing`.
- `apps/api` — the nine-branch mutation endpoint, the two §17 kitchen adapters, the four reads,
  `modules/{realtime,printer,debug,config}/`, health. Ten test files, plus
  `multi-instance.integration.test.ts` behind its own config, **excluded** by default.
- `apps/worker` — the §10 outbox publisher (ADR 010), the producer, the kitchen consumer and its
  projection, `modules/printing/` (ADR 014). CLIs `outbox`/`printer`.
- `apps/web` — POS, kitchen, `/debug`, `/demo`; seven Pinia stores; Dexie (ADR 013); the §14 sync
  engine; `realtime/`; `domain/{pos-screen,demo-script}.ts`; and now **`sw/`, `pwa/`, `vite/`,
  `public/`**.
- **Images, Compose, scripts, CI** — a Dockerfile per app, `nginx.conf`, `docker-compose.multi.yml`
  (the base file's `app` profile is the *dev* stack), `compose-run.mjs`, two `verify-*.mjs`.

## Standing decisions

ADRs are canon; history in `progress-archive.md`. What is not in one:

- Full scope, nothing cut (ADR 001, 007). **Two left: M18, M19.** Neither may be dropped.
- **`BAR_MENU` is in contracts, not a `products.category` column.** Argued beside the constant.
- **Leaving a POS route detaches; it does not clear.** M16. Do not put `clear()` back.
- **The icons are generated** — `apps/web/scripts/make-icons.mjs`, by hand, not by the build.

## Known problems

`docs/known-problems.md`: limits, then the P2/P3 backlog — **twenty-five** entries, five from M17.
**Badly overdue for its sweep**; if M18 lands early, sweep it. Not a session opener.

## First command of the next session

```
Read CLAUDE.md and docs/PROGRESS.md, then expand M18 from docs/MILESTONES.md into
docs/milestones/M18.md and implement M18 only. Stop when the M18 Verification block passes.

M18 is the §21 Playwright E2E: POS-1 creates an order, adds an item, sends it to the kitchen, the
kitchen screen shows the ticket, PREPARING is marked, and the POS follows. Wired into CI.
Verification: `pnpm test:e2e` green locally and in CI. Model: Sonnet. Size: M.

Six things worth knowing before you plan:

1. **This test needs the whole stack, and the user starts infrastructure** (CLAUDE.md rule 3).
   Copy `scripts/verify-integration.mjs` — Compose up, wait for readiness, run, tear down, write
   output to a file you `grep`. Do not stream container logs.
2. **Do not test against `pnpm dev` on :5173.** M17 made a production build meaningfully different:
   the service worker exists only there. Use `pnpm -F @pos/web preview` (:4173, same proxy) or the
   web image. A worker serving a cached shell to a just-rebuilt test is a real flake source —
   Playwright contexts are fresh, so it bites only if you reuse a profile.
3. **The flow crosses the worker.** Send to kitchen → outbox → publisher → Kafka → consumer →
   projection: the ticket is not synchronous. Poll the assertion; do not sleep. `apps/worker` must
   run, and its outbox must not be paused by a leftover §18 arm.
4. **Terminal ids and the seed are fixed** — `POS-1`, `POS-2`, `BAR-1`, `POS-3`, 11 products.
   `TERMINALS` in contracts is the source; never hard-code a product name a reseed changes.
5. **The §18 simulator arms are tab-local** (ADR 015), so a Playwright context starts clean. The
   four server-side ones do not — a paused publisher survives, and looks like "Kafka is broken".
6. **`onBeforeUnmount` detaches, it does not clear** (M16). A test that leaves a POS screen and
   comes back must expect the order to still be there.

Verification: `pnpm test:e2e` locally and the same job in `ci.yml`. Then lint, typecheck, build and
`pnpm -F @pos/web test`. One review pass, P1s only.

Running it: `pnpm -F @pos/api start`, `pnpm -F @pos/worker dev`, and either `pnpm dev` (:5173) or
`pnpm -F @pos/web build && pnpm -F @pos/web preview` (:4173). Postgres, Redis and Redpanda were up
and the API answering `/api/health/ready` at the end of M17.
```
