# Progress / Handoff

> **The only progress file read at the start of a session**, with `docs/milestones/MXX.md`; `grep`
> the others, never open them whole. **Hard limit 8 000 characters** — overflow goes to
> `known-problems.md`, `build-log.md` or `progress-archive.md`. Rewrite per milestone, never append.

## Current state

**Last completed:** M17 — PWA. Manifest, three generated icons, and a service worker that caches
**the shell and nothing else**. The gap it closes is narrow and worth saying precisely: offline has
worked since M8, but *reloading* offline never reached the code that knows how to be offline,
because index.html and the bundle come from the server. **ADR 017.**

**The policy is an allow-list in a pure module.** `src/sw/cache-policy.ts` imports nothing, touches
no `fetch`/`caches`/DOM, and maps a request to `shell` / `asset` / `menu` / `passthrough`.
`passthrough` means the handler **returns without calling `respondWith`** — the browser performs
the request as if no worker existed. Non-`GET` is decided first. `GET /api/menu` is the only cached
API response; `GET /api/orders/:id` is explicitly never cached, because a stale snapshot does not
look like an error, it looks like the server's truth. `cache-policy.test.ts` walks every endpoint in
`src/api/client.ts`.

**Registration is `import.meta.env.PROD`-only** — a worker in dev makes HMR lie — and updates are
`skipWaiting` + `clientsClaim` + one guarded reload on `controllerchange`. Safe only because
`router.ts` imports all four views statically, so there are no lazy chunks; ADR 017 names that as
the condition to revisit.

**Built as a nested Vite build**, `vite/service-worker-plugin.ts`, `apply: 'build'` → one classic
`iife` at a stable `/sw.js` with the per-build cache name injected. It needed **`tsconfig.sw.json`**:
`WebWorker` and `DOM` cannot share one `lib`, so `src/sw/service-worker.ts` and
`test/service-worker.test.ts` are excluded from the app project and compiled there instead.
Nothing under `src/sw/` may import from the rest of `src/`.

**The hands-on browser check was not run.** This session's browser pane refuses to register **any**
service worker — a one-line probe failed identically while `fetch('/sw.js')` from the same page
returned 200 — and no external Chrome was connected. Verified there instead: the manifest, all three
icons at their declared sizes, and the production bundle serving `/pos/pos-1` correctly through the
new `pnpm -F @pos/web preview` (dev cannot exercise a worker at all). The worker's own behaviour is
covered by `test/service-worker.test.ts` against a fake `CacheStorage`. **The remaining check is the
first M17 entry in `known-problems.md`, with exact steps — do it before the interview.**

**Green:** typecheck (now two projects for web), lint, build, **439 tests** (61 domain, 96 api,
55 worker, **239 web** — 9 policy, 9 worker). `verify:integration` / `verify:multi` not re-run:
nothing outside `apps/web` changed.

**Review pass: no P1.** Four P2/P3 in `known-problems.md`.

**Next:** M18 — Playwright E2E. **Sonnet**, size **M**.

## What exists

One line per unit; detail lives in the code and the ADRs.

- **Docs** — what CLAUDE.md lists, plus `milestones/M01…M17.md`. **ADRs 001–017 accepted.**
- `packages/config` zod env (all defaulted); `packages/contracts` the §5 shapes plus `TERMINALS` and
  `BAR_MENU`; `packages/domain` `decide()` — **the whole of §8**; `packages/db` fifteen tables,
  three migrations, seed (11 products), `@pos/db/testing`.
- `apps/api` — the nine-branch mutation endpoint, the two §17 kitchen adapters, the four reads,
  `modules/{realtime,printer,debug,config}/`, `/api/health/{live,ready}`. Ten test files, plus
  `multi-instance.integration.test.ts` behind its own config, **excluded** by default.
- `apps/worker` — the §10 outbox publisher (ADR 010), the producer, the kitchen consumer and its
  projection, `modules/printing/` (ADR 014). CLIs `outbox`/`printer`.
- `apps/web` — POS, kitchen, `/debug`, `/demo`; seven Pinia stores; Dexie (ADR 013); the §14 sync
  engine; `realtime/`; `domain/{pos-screen,demo-script}.ts`; and now **`sw/`, `pwa/register.ts`,
  `vite/service-worker-plugin.ts`, `public/manifest.webmanifest`, `public/icons/`**.
- **Images, Compose, scripts, CI** — a Dockerfile per app, `nginx.conf`, `docker-compose.multi.yml`
  (the base file's `app` profile is the *dev* stack), `compose-run.mjs`, two `verify-*.mjs`, `ci.yml`.

## Standing decisions

ADRs are canon; history in `progress-archive.md`. What is not in one:

- Full scope, nothing cut (ADR 001, 007). **Two left: M18, M19.** Neither may be dropped.
- **`BAR_MENU` is in contracts, not a `products.category` column.** Argued beside the constant.
- **Leaving a POS route detaches; it does not clear.** M16. Do not put `clear()` back.
- **The icons are generated, not drawn** — `apps/web/scripts/make-icons.mjs`, run by hand.

## Known problems

`docs/known-problems.md`: accepted limits, then the P2/P3 backlog — now **twenty-four** entries,
four new from M17. **Badly overdue for its sweep pass**; if M18 lands early, sweep it. Do not read
it to start a session.

## First command of the next session

```
Read CLAUDE.md and docs/PROGRESS.md, then expand M18 from docs/MILESTONES.md into
docs/milestones/M18.md and implement M18 only. Stop when the M18 Verification block passes.

M18 is the §21 Playwright E2E: POS-1 creates an order, adds an item, sends it to the kitchen, the
kitchen screen shows the ticket, PREPARING is marked, and the POS follows. Wired into CI.
Verification: `pnpm test:e2e` green locally and in CI. Model: Sonnet. Size: M.

Six things worth knowing before you plan:

1. **This test needs the whole stack, and the user starts infrastructure** (CLAUDE.md rule 3). The
   pattern to copy is `scripts/verify-integration.mjs` — Compose up, wait for readiness, run,
   tear down, write output to a file you `grep`. Do not stream container logs.
2. **Do not test against `pnpm dev` on :5173.** M17 made a production build meaningfully different:
   the service worker exists only there. Run against a production build via
   `pnpm -F @pos/web preview` (:4173, proxies `/api` and `/socket.io` like dev does) or the web
   image. A worker serving a cached shell to a test that just rebuilt is a real flake source —
   Playwright contexts are fresh, so this is a risk only if you reuse a profile.
3. **The flow crosses the worker.** Send to kitchen → outbox → publisher → Kafka → consumer →
   projection. The ticket does not appear synchronously. Poll the assertion; do not sleep.
   `apps/worker` must be running, and its outbox must not be paused by a leftover §18 arm.
4. **Terminal ids and the seed are fixed** — `POS-1`, `POS-2`, `BAR-1`, `POS-3`, 11 products.
   `packages/contracts` `TERMINALS` is the source; do not hard-code a product name a reseed changes.
5. **The §18 simulator arms are tab-local** (ADR 015), so a Playwright context starts clean. The
   four server-side ones do not — a paused publisher survives, and that is the failure that will
   look like "Kafka is broken".
6. **`onBeforeUnmount` detaches, it does not clear** (M16). A test that navigates away from a POS
   screen and back must expect the order to still be there.

Verification: `pnpm test:e2e` locally and the same job in `ci.yml`. Then lint, typecheck, build and
`pnpm -F @pos/web test`. One review pass, P1s only.

Also, if there is room: the M17 backlog's first entry is a **manual browser check of the service
worker** that this session's tooling could not perform. It is ten minutes in a real Chrome and it
is the only unverified claim in the repository.

Running it: `pnpm -F @pos/api start`, `pnpm -F @pos/worker dev`, `pnpm dev` on :5173, or
`pnpm -F @pos/web build && pnpm -F @pos/web preview` on :4173. Postgres, Redis and Redpanda were up
and the API was answering `/api/health/ready` at the end of M17.
```
