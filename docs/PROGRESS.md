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

Both P2s had the same shape, which is why they went first: a run that reports PASS while proving
less than it says.

- **`pnpm test:e2e` no longer borrows an API.** A foreign process on `:3000` ends the run with an
  instruction; `--reuse-api` is the explicit escape hatch, and it says in the summary that nothing
  proved anything about the API this run built. **Do not** restore the silent reuse — that is what
  let a green run cover an edited route handler the run never executed.
- **`verify:multi` is isolated from the demo stack, not merely pointed at another database.** Its
  own `pos_multi`, topic `restaurant.order.events.multi`, groups `kitchen-multi`/`realtime-multi`
  and Redis **database 1** — Codex's round-2 P1: the runner preserves services already running, so a
  demo consumer could be handed a `pos_multi` event, or carry the broadcast §19.10 asserts. **Those
  four names live in the overlay and in the script and must stay in step.** The script creates the
  topic too: the replicas subscribe before `worker-prod` boots, and an auto-created topic gets one
  partition rather than three.
- **Both long-lived processes stop when asked.** `STDIN_SHUTDOWN=1` makes the API and the worker
  read `shutdown` on stdin and run the same `shutdown()` a signal runs; `startService({
  shutdownCommand })` writes it and keeps the kill as its fallback. Windows has no signal to send a
  child, and a terminated consumer holds its group until the session expires — which the *next* run
  used to pay for.
- **The spec asserts money.** Two of one tile, the price read from the DOM, `2 × price` asserted on
  the POS **after** the queue has drained — before that the number is the optimistic projection's —
  and again on the kitchen ticket, where it arrived by projection and socket instead.

**A stop that failed is now a failed run** (Codex's round-2 P2). Both apps exit 1 when a cleanup
step throws, so `stop()` reads the code — but only for a stop it *asked* for, since a kill says
nothing: on Windows a terminate is always 1.

Detail and the traps this hit — cmd.exe reading a `sh -c` pipeline meant for the container, stdin
keeping a process alive after its own shutdown, and a fresh topic auto-created with one partition —
are in `build-log.md`, *M21* and *M21 review round 2*.

**Green:** lint, typecheck, `pnpm test` **475 passed**, build, `verify:integration`, `test:e2e`,
`verify:multi` — the last two repeatedly, including against a fresh topic and a fresh database.
**And falsified, which matters more here:** a stub on :3000 reddens the e2e run; one cent added to
`recalculateTotal` reddens the money assertion; a `throw` at the end of the worker's shutdown turns
a passing spec into `FAIL — checks passed but worker did not shut down cleanly`; two runs in a row
join their groups in under 50 ms; the demo database held at forty-two orders across two smoke runs;
`kitchen-multi` was `Stable` while the demo's `kitchen` stayed `Empty`.

## What exists

One line per unit; detail lives in the code and the ADRs.

- **Docs** — `architecture.md`, `interview-guide.md`, `definition-of-done.md`, `spec.md`,
  `MILESTONES.md`, `known-problems.md`, `build-log.md`, `progress-archive.md`,
  `milestones/M01…M21.md`. **ADRs 001–018**, indexed by `docs/adr/README.md`; `spec.md` §23 names
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

- Full scope, nothing cut (ADR 001, 007). **All twenty-one milestones ran.**
- **`BAR_MENU` is in contracts, not a `products.category` column.** Argued beside the constant.
- **Leaving a POS route detaches, not clears.** M16. Do not put `clear()` back.
- **The icons are generated** — `apps/web/scripts/make-icons.mjs`, by hand, not by the build.
- **The documents link to the argument; they do not restate it.** Cite an ADR or a test.
- **`conflict_log.resolution` is observability, not domain state.** Best-effort, never order-wide.
- **A verification run owns its lifecycle and writes `.verify-output/*.log`** — read the tail, never
  a live container log (CLAUDE.md rule 3). Since M21 a run also never borrows a process it did not
  start, and never writes into the demo database.

## Known problems

`docs/known-problems.md`: the accepted limits, then the backlog — **fifteen** entries. Thirteen are
grouped into M22, M23 and M24 by surface; the two `[M21, P3]` lines are this milestone's own review
pass. A milestone there is done when its lines are gone: deleted if fixed, moved up into *Accepted
limits* if the honest answer is that the behaviour is right and the line was mis-filed.

## First command of the next session

**M22 — The flag path, end to end.** Brief in `MILESTONES.md`; expand it into
`docs/milestones/M22.md` first. Two fixes and three re-arguments:

1. **`[M13, P2]`** a cache-aside fill can overwrite an invalidation in
   `apps/api/src/modules/config/application/resolve-flags.ts`, so "fleet-wide and immediate" is
   false for one `FLAG_CACHE_TTL_MS`. A versioned or conditional fill is the fix.
2. **`[M20, P3]`** `flags.busy` in `apps/web/src/stores/flags.ts` holds one key — the same defect
   M20 fixed in the simulator store. A `Set` and an `isBusy(key)`; `FlagPanel.vue:71,99` read it.
3. Three entries whose answer is *not a fix*: mark-then-emit in the realtime consumer (§12.2 chose
   it), the `TimeoutNegativeWarning` from a dependency, and an offline resolution never recorded.
   Re-argue each once, then move it into *Accepted limits* or delete it.

Still outstanding from M19: **walk §19.1 by hand and read a real CI run** (the two unmet §26
clauses), and **force a real interleaving in §21.1 and §21.10** — a milestone, not a sweep item.
`docs/definition-of-done.md` is the map of what is proved, what is argued and what is neither.

Running it: `pnpm -F @pos/api start`, `pnpm -F @pos/worker dev`, `pnpm dev` (:5173).
