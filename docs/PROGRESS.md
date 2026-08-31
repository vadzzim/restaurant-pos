# Progress / Handoff

> **The only progress file read at the start of a session**, with `docs/milestones/MXX.md`; `grep` the
> others, never open them whole. **Hard limit 8 000 characters** — overflow goes to
> `known-problems.md` or `build-log.md`. Rewrite per milestone, never append.

## Current state

**The project was finished at M19. M20 was the backlog sweep it never got, and M21–M24 finish the
job**, grouped by **the surface the fix lives on** rather than by date — briefs in `MILESTONES.md`,
_The second sweep_. M22 took the five on the **feature-flag path**. Ten of the original seventeen
remain (M23, M24), plus the two P3s each pass opens on itself; the file holds twelve lines and
**the only P2 left is the service worker's**.

Two of the five were code and three were arguments, and that split is the point of a sweep.

- **The flag cache is versioned (ADR 019), and that is what makes §15's "fleet-wide and immediate"
  true.** `config:feature-flags:version` is an integer with **no expiry**; `invalidate()` is one
  `INCR` and touches nothing else; the payload carries the version it was filled at and a payload
  whose version no longer matches **reads as a miss**. Deleting the key never closed the race — the
  stale fill happens *after* the delete. **Do not** put a `DEL` back and do not add a lock: the
  defect was a stale fill, not a repeated one.
- **`loadFlags` treats the version as an opaque string** and never interprets it, so `buildApp()`
  without a cache is unchanged and every `fastify.inject` test stays free of infrastructure
  (ADR 006). A cache read that *threw* observed no version and therefore does not fill at all.
- **`createRedisFlagCache` takes the three commands it uses (`FlagRedis`), not `Redis`.** That is
  deliberate and load-bearing: it is what lets the falsifying test drive the real cache over a
  `Map`, keeping the rule that no unit test in this repository needs a live Redis.
- **`flags.busy` is a `Set` with `isBusy(key)`**, matching `stores/simulator.ts`. Note what it does
  **not** fix: the same flag pressed twice still clears on the first response, because a set is not
  a counter. The switches are idempotent, so that is accepted, not overlooked.

**And falsified, which matters as much as green:** dropping the version comparison from `read`
reddens both the stalled-fill test and the older *"is invalidated by a write"* one; reverting
`busy` to a single key reddens both web tests.

**Three entries were closed by an argument** and moved into *Accepted limits* rather than deleted —
mark-then-emit (§12.2 chose it), the `TimeoutNegativeWarning` (its value is `-Date.now()` to the
millisecond, and the only deadline arithmetic in `apps/worker/src` clamps), and the resolution
reported offline (the standing "`conflict_log.resolution` is observability" rule). A deleted line is
a fact nobody can find again.

Detail in `build-log.md`, *M22*.

**Green:** lint, typecheck, `pnpm test` **478 passed**, build, `verify:integration`.

## What exists

One line per unit; detail lives in the code and the ADRs.

- **Docs** — `architecture.md`, `interview-guide.md`, `definition-of-done.md`, `spec.md`,
  `MILESTONES.md`, `known-problems.md`, `build-log.md`, `progress-archive.md`,
  `milestones/M01…M22.md`. **ADRs 001–019**, indexed by `docs/adr/README.md`; `spec.md` §23 names
  filenames that drifted.
- `packages/` — `config` zod env (all defaulted, `STDIN_SHUTDOWN` the one boolean); `contracts` the
  §5 shapes plus `TERMINALS`, `BAR_MENU`, `CONFLICT_RESOLUTIONS`; `domain` `decide()`, **all of
  §8**; `db` fifteen tables, three migrations, seed, `@pos/db/testing`.
- `apps/api` — the nine-branch mutation endpoint, the §14.1 resolution report, the two §17 kitchen
  adapters, the four reads, `modules/{realtime,printer,debug,config}/`, health. Ten test files, plus
  `multi-instance.integration.test.ts` behind its own config, **excluded** by default.
- `apps/worker` — the §10 publisher (ADR 010), the producer, the kitchen consumer and its
  projection, `modules/printing/` (ADR 014). CLIs `outbox`/`printer`.
- `apps/web` — POS, kitchen, `/debug`, `/demo`; seven Pinia stores; Dexie (ADR 013); the §14 sync
  engine; `realtime/`, `domain/`, `sw/`, `pwa/`, `vite/`, `public/`.
- `e2e/` + `playwright.config.ts` + `tsconfig.e2e.json` — one spec and its preflight.
- **Images, Compose, scripts, CI** — a Dockerfile per app, `nginx.conf`, `docker-compose.multi.yml`
  (the base file's `app` profile is the *dev* stack), `compose-run.mjs`, three `verify-*.mjs`.
  `ci.yml`: `verify`, `e2e`, `images`.

## Standing decisions

ADRs are canon; history in `progress-archive.md`. What is not in one:

- Full scope, nothing cut (ADR 001, 007). **All twenty-two milestones ran.**
- **`BAR_MENU` is in contracts, not a `products.category` column.** Argued beside the constant.
- **Leaving a POS route detaches, not clears.** M16. Do not put `clear()` back.
- **The icons are generated** — `apps/web/scripts/make-icons.mjs`, by hand, not by the build.
- **The documents link to the argument; they do not restate it.** Cite an ADR or a test.
- **`conflict_log.resolution` is observability, not domain state.** Best-effort, never order-wide —
  and since M22 that rule explicitly covers the offline case, in *Accepted limits*.
- **A verification run owns its lifecycle and writes `.verify-output/*.log`** — read the tail, never
  a live container log (CLAUDE.md rule 3). Since M21 a run also never borrows a process it did not
  start, and never writes into the demo database. `verify:multi`'s four names — `pos_multi`, the
  `.multi` topic, `kitchen-multi`/`realtime-multi`, Redis database 1 — live in the overlay *and* in
  the script and must stay in step.

## Known problems

`docs/known-problems.md`: the accepted limits, then the backlog — **twelve** entries. Ten are
grouped into M23 and M24 by surface; the two `[M22, P3]` lines are this milestone's own review pass.
A milestone there is done when its lines are gone: deleted if fixed, moved up into *Accepted limits*
if the honest answer is that the behaviour is right and the line was mis-filed.

## First command of the next session

**M23 — The cached client.** Brief in `MILESTONES.md`; expand it into `docs/milestones/M23.md`
first. Five entries, one browser, and one file for most of them:

1. **`[M17, P2]`** `activate` deletes the previous build's cache under a page still running the old
   bundle. Harmless *today* only because `router.ts` imports all four views statically — ADR 017
   names code splitting as the condition to revisit, so read it before touching `sw/`.
2. **`[M17, P3]`** a failed precache fails the whole installation, and **`[M17, P3]`** the update
   path force-reloads the tab on `controllerchange` with no prompt, losing a half-typed table name.
3. **`[M16, P3]`** no UI path puts a second terminal on an existing order, so §19.3's literal
   two-terminal form needs `curl`; `focusOrder` already exists. **`[M16, P3]`** `/demo`'s step ticks
   are in-memory, so a reload mid-demo loses the place.

Each fix needs a test that **fails without it** — that is the M21/M22 standard and the reason those
two milestones are worth anything. The service-worker suite is `apps/web/test/service-worker.test.ts`
and `cache-policy.test.ts`; `/demo` is `demo-script.test.ts`.

Still outstanding from M19: **walk §19.1 by hand and read a real CI run** (the two unmet §26
clauses), and **force a real interleaving in §21.1 and §21.10** — a milestone, not a sweep item.
`docs/definition-of-done.md` is the map of what is proved, what is argued and what is neither.

Running it: `pnpm -F @pos/api start`, `pnpm -F @pos/worker dev`, `pnpm dev` (:5173).
