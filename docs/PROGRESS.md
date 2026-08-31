# Progress / Handoff

> **The only progress file read at the start of a session**, with `docs/milestones/MXX.md`; `grep` the
> others, never open them whole. **Hard limit 8 000 characters** — overflow goes to
> `known-problems.md` or `build-log.md`. Rewrite per milestone; never append.

## Current state

**The project was finished at M19. M20 was the backlog sweep it never got, and M21–M24 finish the
job**, grouped by **the surface the fix lives on** — briefs in `MILESTONES.md`, _The second sweep_.
M23 took the five on the **browser surface**. **No P2 is left in `known-problems.md`**; five backlog
lines remain, three of them M24's.

- **The update banner and the retained cache are the same fix.** `activate` deleting the previous
  build's cache was half a defect; the other half was `controllerchange` force-reloading the page
  holding the old bundle. Fixing the reload makes the delete *worse* — a page nobody reloads runs the
  old bundle indefinitely — so both moved together: **`GENERATIONS_KEPT = 2`**, a cache miss falls
  back across `caches.match`, and the reload is the operator's (`pwa/update.ts`, `UpdateBanner.vue`).
  **ADR 017 was amended, not left contradicting the code.** Do not rewrite the retention as
  `slice(0, -(GENERATIONS_KEPT - 1))`: at `1` that deletes nothing.
- **`install` no longer fails, the document included.** ADR 017 argued for failing loudly and was
  wrong where it mattered: a worker stuck `installing` is *no* worker, not an empty one. The first
  navigation that reaches the network re-reads the asset list out of the document — **the bundle is
  the one thing runtime caching cannot pick up on its own**.
- **Both cache-reading routes go through `matchAnyCache` — the Codex P1.** An empty worker serves
  everything out of the retained generation, so a fallback on the `asset` route alone left the *menu*
  missing: `menu.load()` aborts POS startup, and an offline till draws an order with no product grid.
- **`focusOrder` moves the pointer inside `serialize`, like `createOrder` and `clear`** — the Codex
  P2, and M16's defect rather than M23's. `command` captures the pointer on touch and re-checks it in
  its own link, so a move made *outside* the chain refuses every tap already accepted at rush speed:
  three taps then "Take it" lost all three.
- **Two terminals on one order, from the UI**, and **`/demo`'s ticks are in the query string**
  (`?done=1,3,4`, one-based, beside `?scenario=`; a fresh link still starts empty). The
  `connection.resubscribe()` beside the new field was **also missing from "Go to it"** — a focus that
  does not move the socket room hears nothing until the next refetch. One function, two callers.

**And falsified:** eight revert-and-redden checks, in `build-log.md`, *M23*. One is worth knowing —
restoring the old `location.reload()` reddens two tests because `window` does not exist under vitest,
which is why that decision left `register.ts`, untestable by construction outside `PROD`.

**Green:** lint, typecheck, `pnpm test` **493 passed**, build. **`verify:integration` was not
re-run** (nothing outside `apps/web`'s client changed) and **the browser half was not run**: `vite
preview` binds, but this sandbox cannot reach localhost. Three hand checks are open, below.

**A Codex pass on the M23 commit found one P1 and one P2, both fixed above.** Carry this into M24:
both were *interactions* between two individually-correct changes — the failure mode of grouping a
sweep by surface, which is the thing the grouping buys.

## What exists

One line per unit; detail lives in the code and the ADRs. Docs are **ADRs 001–019** (`adr/README.md`)
and `milestones/M01…M23`; `spec.md` §23 names filenames that drifted.

- `packages/` — `config` zod env; `contracts` the §5 shapes plus `TERMINALS`, `BAR_MENU`,
  `CONFLICT_RESOLUTIONS`; `domain` `decide()`, **all of §8**; `db` fifteen tables, three migrations,
  seed, `@pos/db/testing`.
- `apps/api` — the nine-branch mutation endpoint, the §14.1 resolution report, the two §17 kitchen
  adapters, the four reads, `modules/{realtime,printer,debug,config}/`, health. Ten test files, plus
  `multi-instance.integration.test.ts` **excluded** by default.
- `apps/worker` — the §10 publisher (ADR 010), the producer, the kitchen consumer and its projection,
  `modules/printing/` (ADR 014); CLIs `outbox`/`printer`.
- `apps/web` — POS, kitchen, `/debug`, `/demo`; seven Pinia stores; Dexie (ADR 013); the §14 sync
  engine; `realtime/`, `domain/`, `sw/`, `pwa/`, `vite/`, `public/`. `e2e/` holds one spec.
- **Images, Compose, scripts, CI** — a Dockerfile per app, `nginx.conf`, `docker-compose.multi.yml`
  (the base file's `app` profile is the *dev* stack), `compose-run.mjs`, three `verify-*.mjs`;
  `ci.yml` runs `verify`, `e2e`, `images`. **M24's three files are all in this line.**

## Standing decisions

ADRs are canon; history in `progress-archive.md`. What is not in one:

- Full scope, nothing cut (ADR 001, 007). **All twenty-three milestones ran.**
- **`BAR_MENU` is in contracts, not a `products.category` column**; **leaving a POS route detaches,
  not clears** (M16 — do not put `clear()` back); **`conflict_log.resolution` is observability**;
  **the documents link to the argument, never restate it.**
- **`src/sw/` imports nothing from `src/` and exports nothing** — a classic `iife` (ADR 017). Logic
  needing a test goes in `cache-policy.ts`, or is asserted through an event as `staleCaches` is.
- **A pointer move belongs inside `serialize`** — `createOrder`, `clear`, `focusOrder`. Anything new
  writing `currentOrderId` outside the chain silently refuses taps already accepted.
- **A verification run owns its lifecycle and writes `.verify-output/*.log`** — read the tail, never
  a live container log (rule 3). `verify:multi`'s four names — `pos_multi`, the `.multi` topic,
  `kitchen-multi`/`realtime-multi`, Redis db 1 — live in the overlay *and* the script.

## Known problems

`docs/known-problems.md`: the accepted limits, then the backlog — **five** entries and **no P2**.
Three are M24's, two are M21's and M22's review passes. The file's own note states the rule for
closing one.

## First command of the next session

**M24 — The deployment surface**, the last of the sweep. Brief in `MILESTONES.md`; expand it into
`docs/milestones/M24.md` first. Three `[M14, P3]`s in files nothing but `verify:multi` and CI touches
— which is the trap: **no unit test can reach any of them**, so the Verification block is the whole
proof and needs infrastructure. Ask the user to bring Compose up and paste output; never pull
container logs (rule 3).

The three lines are in `known-problems.md`; the traps are not. **1.** `nginx.conf` — a variable
`proxy_pass` **drops the URI**, so the path must be written back explicitly. **2.**
`docker-compose.multi.yml` — `worker-prod` has no healthcheck, and today the smoke test's warm-up
round trip covers it, so a worker that died on boot is reported as a *broadcast* failure. **3.**
`ci.yml` — the `images` job builds three images and starts none, and the bases float on tags.

**Carry M21's and M22's leftovers** if cheap, same two files: `verify-e2e.mjs` probes `:3000` last
rather than first, and the overlay names a database only the script creates.

Each fix needs something that **fails without it** — here a verification step, not a vitest. Still
outstanding from M19: **walk §19.1 by hand and read a real CI run** (the two unmet §26 clauses), and
**force a real interleaving in §21.1 and §21.10**. `docs/definition-of-done.md` maps what is proved,
what is argued and what is neither.

**M23's three hand checks are open**, and cheap with a browser (`build` then `preview`): add a
dynamic `import()` to one view, rebuild, reload offline, and check the old page still resolves its
chunk; open POS-1's order from POS-2 by id; tick three steps on `/demo`, press F5, switch scenario.

Running it: `pnpm -F @pos/api start`, `pnpm -F @pos/worker dev`, `pnpm dev` (:5173).
