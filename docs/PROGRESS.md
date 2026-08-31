# Progress / Handoff

> **The only progress file read at the start of a session**, with `docs/milestones/MXX.md`; `grep` the
> others, never open them whole. **Hard limit 8 000 characters** — overflow goes to
> `known-problems.md` or `build-log.md`. Rewrite per milestone, never append.

## Current state

**The project was finished at M19; M20 is the backlog sweep it never got.** Twenty-one milestones,
one commit each, nothing cut (ADR 001, 007). M20 closed **fifteen** of the thirty P2/P3 entries in
`known-problems.md` and opened two, so **seventeen remain** — and the file now carries a note saying
it has been swept once, so the next reader knows what they are looking at.

**Two of the fifteen were already fixed and nobody had deleted the line.** Both M15 `P1-in-M12`
entries described code that M15 itself repaired. That is the argument for sweeping rather than
accumulating: an unread backlog decays into fiction, and checking costs the same either way.

**The four structural fixes, each with a test that fails without it.** Detail in `build-log.md`,
*M20*; the reasoning lives beside the code, as ADR 001's convention requires.

- **The queue has a clock.** `queueStamp()` in `local-store.ts` returns `max(Date.now(), newest row
  on disk + 1 ms)`, so two taps inside one millisecond can no longer be ordered by the random-UUID
  tiebreak and send `baseVersion` 4 before 3. **Do not** replace it with a remembered high-water
  mark — that was tried, and it is process state no test and no second tab can reset.
- **The storage-less send is inside the serialized link.** `stageOrSend` in `stores/order.ts` sends
  inline when `savePending` returns false. **Appending a second `serialize` link does not work** —
  rapid taps interleave staging against staging, not staging against send.
- **`conflict_log.resolution` is written.** `POST /api/orders/:orderId/conflicts/resolution` closes
  the open rows for one order on one terminal; `discardHalted` and `rebaseHalted` report into it.
  Rebase reports **before** it rebases, or it would close the fresh conflict its own rebase caused.
- **Each `/debug` panel counts what it shows.** `readConflictCounters` and `readOutboxCounters`;
  `readDatabaseCounters` is now `/api/debug/metrics` only. A test asserts the three still agree.

**The review pass found one P1, in this session's own diff.** `postConflictResolution` calls
`assertOnline`, which throws *synchronously* on an offline terminal — before there is a promise for
`.catch()` to hold. Offline is exactly when §19.3 discards a halted queue, so an observability field
would have broken a till. Wrapped in an async IIFE and covered.

**Green:** lint, typecheck (three projects), `pnpm test` **469 passed**, build,
`pnpm verify:integration` **PASS**. The hand smoke of §19.1 is still the user's (CLAUDE.md rule 3).

## What exists

One line per unit; detail lives in the code and the ADRs.

- **Docs** — `architecture.md`, `interview-guide.md`, `definition-of-done.md`, `spec.md`,
  `MILESTONES.md`, `known-problems.md`, `build-log.md`, `progress-archive.md`,
  `milestones/M01…M20.md`. **ADRs 001–018**, indexed by `docs/adr/README.md` — the real index;
  `spec.md` §23 names filenames that drifted.
- `packages/` — `config` zod env (all defaulted); `contracts` the §5 shapes plus `TERMINALS`,
  `BAR_MENU` and `CONFLICT_RESOLUTIONS`; `domain` `decide()`, **the whole of §8**; `db` fifteen
  tables, three migrations, seed (11 products), `@pos/db/testing`.
- `apps/api` — the nine-branch mutation endpoint, the §14.1 resolution report, the two §17 kitchen
  adapters, the four reads, `modules/{realtime,printer,debug,config}/`, health. Ten test files, plus
  `multi-instance.integration.test.ts` behind its own config, **excluded** by default.
- `apps/worker` — the §10 outbox publisher (ADR 010), the producer, the kitchen consumer and its
  projection, `modules/printing/` (ADR 014). CLIs `outbox`/`printer`.
- `apps/web` — POS, kitchen, `/debug`, `/demo`; seven Pinia stores; Dexie (ADR 013); the §14 sync
  engine; `realtime/`; `domain/`; `sw/`, `pwa/`, `vite/`, `public/`.
- `e2e/` + `playwright.config.ts` + `tsconfig.e2e.json` — one spec and its preflight.
- **Images, Compose, scripts, CI** — a Dockerfile per app, `nginx.conf`, `docker-compose.multi.yml`
  (the base file's `app` profile is the *dev* stack), `compose-run.mjs`, **three** `verify-*.mjs`.
  `ci.yml` jobs: `verify`, `e2e`, `images`.

## Standing decisions

ADRs are canon; history in `progress-archive.md`. What is not in one:

- Full scope, nothing cut (ADR 001, 007). **All twenty-one milestones ran.**
- **`BAR_MENU` is in contracts, not a `products.category` column.** Argued beside the constant.
- **Leaving a POS route detaches, not clears.** M16. Do not put `clear()` back.
- **The icons are generated** — `apps/web/scripts/make-icons.mjs`, by hand, not by the build.
- **The documents link to the argument; they do not restate it.** Anything added to `docs/` should
  cite an ADR or a test rather than re-explaining a mechanism.
- **`conflict_log.resolution` is observability, not domain state.** Best-effort, not idempotency-
  keyed, not in the mutation transaction. An offline resolution is never recorded, on purpose.

## Known problems

`docs/known-problems.md`: the accepted limits, then the backlog — **seventeen** entries after M20's
sweep, two of them new. The next sweep is due in three or four milestones, if there are any.

## If a session does follow

Three things are worth doing, in this order, and none is large:

1. **Walk §19.1 by hand, and push to a remote and read the CI run.** The two unmet §26 clauses, 21
   and 18. Neither needs code: nothing in `ci.yml` is known to be wrong, it is simply unexecuted,
   and the smoke walk is `/demo`, scenario *Normal flow*.
2. **Force a real interleaving in §21.1 and §21.10.** The honest gap named in
   `definition-of-done.md` clause 17 and in the interview guide's weakness 2 — advisory-lock
   choreography or a fault-injecting proxy. Closing it would upgrade the weakest claim in the
   project. This is a milestone, not a sweep item.
3. **Read `docs/definition-of-done.md` before claiming anything is done.** It is the map of what is
   proved, what is argued, and what is neither.

**Do not** re-argue an ADR without a new one, do not run `docker compose` by hand (rule 3 — the
three `verify:*` commands own their lifecycles and write `.verify-output/*.log`), and do not restate
in a document what a test already says. Running it: `pnpm -F @pos/api start`,
`pnpm -F @pos/worker dev`, and `pnpm dev` (:5173) or `pnpm -F @pos/web build && pnpm -F @pos/web
preview` (:4173).
