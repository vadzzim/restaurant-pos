# Progress / Handoff

> **The only progress file read at the start of a session**, with `docs/milestones/MXX.md`; `grep` the
> others, never open them whole. **Hard limit 8 000 characters** — overflow goes to
> `known-problems.md` or `build-log.md`. Rewrite per milestone, never append.

## Current state

**The project was finished at M19. M20 was the backlog sweep it never got, and M21 is the first of
four that finish the job.** M20 took thirty unrelated entries in one pass and paid for a fresh
context per fix; the seventeen it left are grouped by **the surface the fix lives on** — briefs in
`MILESTONES.md`, _The second sweep_. M21 took the four that live in the **test harness**, including
both of the backlog's remaining P2s. **Thirteen of the seventeen remain** — they are M22, M23 and
M24 — and M21's own review pass opened two more, so the file holds fifteen lines.

Both P2s had the same shape, which is why they were done first: a run that reports PASS while
proving less than it says.

- **`pnpm test:e2e` no longer borrows an API.** A foreign process on `:3000` ends the run with an
  instruction; `--reuse-api` is the explicit escape hatch, and it says in the summary that nothing
  proved anything about the API this run built. **Do not** restore the silent reuse — that is what
  let a green run cover an edited route handler the run never executed.
- **`verify:multi` has its own database, `pos_multi`.** Created by the script (`createdb`, with
  `already exists` treated as success), migrated and seeded there. The container-side name is in
  `docker-compose.multi.yml` and the host-side one in the script, and **the two must agree**. Not
  `pos_test`: the integration suite truncates that between tests.
- **Both long-lived processes stop when asked.** `STDIN_SHUTDOWN=1` makes the API and the worker
  read `shutdown` on stdin and run the same `shutdown()` a signal runs; `startService({
  shutdownCommand })` writes it and keeps the kill as its fallback. Windows has no signal to send a
  child, and a terminated consumer holds its group until the session expires — which the *next* run
  used to pay for.
- **The spec asserts money.** Two of one tile, the price read from the DOM, `2 × price` asserted on
  the POS **after** the queue has drained — before that the number is the optimistic projection's —
  and again on the kitchen ticket, where it arrived by projection and socket instead.

Detail and the two traps this hit — cmd.exe reading a `sh -c` pipeline that was meant for the
container, and stdin keeping a process alive after its own shutdown — are in `build-log.md`, *M21*.

**Green:** lint, typecheck (three projects + `tsconfig.e2e.json`), `pnpm test` **475 passed**,
build, `pnpm verify:integration` **PASS**, `pnpm test:e2e` **PASS three times**, `pnpm verify:multi`
**PASS twice**. Each fix was also falsified: a stub on :3000 turns the e2e run red, a broken
`recalculateTotal` turns the money assertion red, the second e2e run joins its consumer groups in
under 20 ms where the old shape waited out a session timeout, and the demo database held at
forty-two orders across two smoke runs.

## What exists

One line per unit; detail lives in the code and the ADRs.

- **Docs** — `architecture.md`, `interview-guide.md`, `definition-of-done.md`, `spec.md`,
  `MILESTONES.md`, `known-problems.md`, `build-log.md`, `progress-archive.md`,
  `milestones/M01…M21.md`. **ADRs 001–018**, indexed by `docs/adr/README.md` — the real index;
  `spec.md` §23 names filenames that drifted.
- `packages/` — `config` zod env (all defaulted, `STDIN_SHUTDOWN` the one boolean); `contracts` the
  §5 shapes plus `TERMINALS`, `BAR_MENU` and `CONFLICT_RESOLUTIONS`; `domain` `decide()`, **the
  whole of §8**; `db` fifteen tables, three migrations, seed (11 products), `@pos/db/testing`.
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
- **`conflict_log.resolution` is observability, not domain state.** Best-effort, never order-wide.
- **A verification run owns its lifecycle and writes `.verify-output/*.log`** — read the tail, never
  a live container log (CLAUDE.md rule 3). Since M21 a run also never borrows a process it did not
  start, and never writes into the demo database.

## Known problems

`docs/known-problems.md`: the accepted limits, then the backlog — **fifteen** entries. Thirteen are
grouped into M22, M23 and M24 by the surface they live on; the two `[M21, P3]` lines are this
milestone's own review pass and belong to whichever of those touches the scripts next. A milestone
there is finished when its lines are gone from that file: deleted if fixed, moved up into *Accepted
limits* if the honest answer is that the behaviour is right and the line was mis-filed.

## First command of the next session

**M22 — The flag path, end to end.** Brief in `MILESTONES.md`; expand it into
`docs/milestones/M22.md` first. Two fixes and three re-arguments:

1. **`[M13, P2]`** a cache-aside fill can overwrite an invalidation in
   `apps/api/src/modules/config/application/resolve-flags.ts`, so "fleet-wide and immediate" is
   false for one `FLAG_CACHE_TTL_MS`. A versioned or conditional fill is the fix.
2. **`[M20, P3]`** `flags.busy` in `apps/web/src/stores/flags.ts` holds one key — the same defect
   M20 fixed in the simulator store. A `Set` and an `isBusy(key)`; `FlagPanel.vue:71,99` read it.
3. Three entries whose answer is *not a fix*: the realtime consumer's mark-then-emit order (§12.2
   chose it), the `TimeoutNegativeWarning` from a dependency, and a resolution reported offline
   never being recorded. Re-argue each once, then move it into *Accepted limits* or delete it.

Two things still outstanding from M19, neither large and neither part of a sweep: **walk §19.1 by
hand and read a real CI run** (the two unmet §26 clauses), and **force a real interleaving in §21.1
and §21.10** — that one is a milestone, not a sweep item. `docs/definition-of-done.md` is the map of
what is proved, what is argued and what is neither; read it before claiming anything is done.

Running it: `pnpm -F @pos/api start`, `pnpm -F @pos/worker dev`, and `pnpm dev` (:5173) or
`pnpm -F @pos/web build && pnpm -F @pos/web preview` (:4173).
