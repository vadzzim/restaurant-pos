# Progress / Handoff

> **The only progress file read at the start of a session**, with `docs/milestones/MXX.md`; `grep` the
> others, never open them whole. **Hard limit 8 000 characters** — overflow goes to
> `known-problems.md` or `build-log.md`. Rewrite per milestone, never append.

## Current state

**The project is finished.** M0 through M19, twenty milestones, one commit each, nothing cut
(ADR 001, 007). M19 was §23's documentation and §26's walk.

**Four documents, and the method behind them matters more than their length.** Every answer §23
asks for was already argued once — in an ADR, in `build-log.md`, or beside the code — so the
documents **link** rather than re-derive. Anything that reopens one of these should do the same.

- `docs/architecture.md` — three Mermaid diagrams (system; offline sync **including the
  blocked-queue branch**; the outbox, HTTP → transaction → outbox → commit → worker → Kafka →
  consumer), then the §23 scale section split into *already true here* and *would have to be built*.
- `docs/interview-guide.md` — the 5-minute pitch, a 15-minute code walkthrough with file and line
  pointers, a table over all ten §19 scenarios, answers to all **eighteen** questions §23 names, and
  ten weaknesses **chosen from `known-problems.md`, not invented**.
- `docs/definition-of-done.md` — §26 clause by clause, each labelled *proved* / *argued* / *partial*
  with the test or command behind it. New, and not in §23's list: §26 asked for a walk, and a walk
  buried inside the interview guide would have been a claim rather than an audit.
- `README.md` — two lines were stale by seventeen milestones (*"M1 contains only the runnable
  monorepo"*, *"the simulator gets its buttons in M12"*), plus the demo sequence and §23's
  *Engineering concepts demonstrated*.

**Four §26 clauses do not fully pass, and that is recorded rather than papered over.** Clause 18,
*CI is green on a clean checkout*, is **not met**: `ci.yml` is complete and its command list is what
ran green locally, but **this repository has no git remote**, so the workflow has never executed.
Clause 21, *the main flow has been smoke-tested by hand*, is **not met** either — `pnpm test:e2e`
automates §19.1, and the clause asks for a human; the infrastructure is the user's (rule 3), so the
run is theirs. Clause 2 is partial — no UI path puts a second terminal on an existing order. Clause
17 carries the known gap: §21.1 and §21.10 assert invariants, they do not force the interleaving.

**Two review passes, and the second was Codex's — it found five real factual errors.** Mine caught
two miscited tests. Codex caught claims: the realtime emit is **at-most-once**, not at-least-once,
and a duplicate emits *nothing*; `nginx.conf` pins clients with **`ip_hash`**, so "no session
affinity" was wrong; `restaurantId` is on six tables, not all fifteen; publish-side `reclaim_count`
and a consumer-side poison message are different failures; and clause 21 was dressed as delegated
rather than unmet. All five verified against the code before fixing — Codex's own list of
tenant-less tables was itself wrong about `processed_mutations`, which does carry the column. The
lesson is the one M18 recorded: read the argument, then check the mechanism.

**Green:** lint, typecheck (three projects), `pnpm test` **463 passed**, build,
`pnpm verify:integration` **PASS**. The hand smoke of §19.1 is the user's (CLAUDE.md rule 3).

## What exists

One line per unit; detail lives in the code and the ADRs.

- **Docs** — `architecture.md`, `interview-guide.md`, `definition-of-done.md`, `spec.md`,
  `MILESTONES.md`, `known-problems.md`, `build-log.md`, `progress-archive.md`,
  `milestones/M01…M19.md`. **ADRs 001–018**, indexed by `docs/adr/README.md` — the real index;
  `spec.md` §23 names filenames that drifted.
- `packages/` — `config` zod env (all defaulted); `contracts` the §5 shapes plus `TERMINALS` and
  `BAR_MENU`; `domain` `decide()`, **the whole of §8**; `db` fifteen tables, three migrations, seed
  (11 products), `@pos/db/testing`.
- `apps/api` — the nine-branch mutation endpoint, the two §17 kitchen adapters, the four reads,
  `modules/{realtime,printer,debug,config}/`, health. Ten test files, plus
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

- Full scope, nothing cut (ADR 001, 007). **All twenty milestones ran.**
- **`BAR_MENU` is in contracts, not a `products.category` column.** Argued beside the constant.
- **Leaving a POS route detaches, not clears.** M16. Do not put `clear()` back.
- **The icons are generated** — `apps/web/scripts/make-icons.mjs`, by hand, not by the build.
- **The documents link to the argument; they do not restate it.** Anything added to `docs/` should
  cite an ADR or a test rather than re-explaining a mechanism.

## Known problems

`docs/known-problems.md`: the accepted limits, then the P2/P3 backlog — **thirty** entries, two new
in M19. **Never swept**: the sweep was due every three or four milestones and was deferred each
time in favour of scope, which is itself a fact worth stating out loud in the interview.

## If a session does follow

There is no next milestone. Four things are worth doing, in this order, and none of them is large:

1. **Walk §19.1 by hand, and push to a remote and read the CI run.** The two unmet §26 clauses,
   21 and 18. Neither needs code: nothing in `ci.yml` is known to be wrong, it is simply
   unexecuted, and the smoke walk is `/demo`, scenario *Normal flow*.
2. **Sweep the backlog.** Thirty entries in `known-problems.md`, each written as one line with
   what would prove it, precisely so a single context can take ten at once. The strongest candidates
   are the two M15 P2s (same-millisecond queue ordering; the storage-less `settle()` path) and the
   M16 P2 (`conflict_log.resolution` is never written, so `/debug`'s conflict history never shows a
   resolved row).
3. **Force a real interleaving in §21.1 and §21.10.** The honest gap named in
   `definition-of-done.md` clause 17 and in the interview guide's weakness 2 — advisory-lock
   choreography or a fault-injecting proxy. Closing it would upgrade the single weakest claim in the
   project.
4. **Read `docs/definition-of-done.md` before claiming anything is done.** It is the map of what is
   proved, what is argued, and what is neither.

**Do not** re-argue an ADR without a new one, do not run `docker compose` by hand (rule 3 — the
three `verify:*` commands own their lifecycles and write `.verify-output/*.log`), and do not restate
in a document what a test already says. Running it: `pnpm -F @pos/api start`,
`pnpm -F @pos/worker dev`, and `pnpm dev` (:5173) or `pnpm -F @pos/web build && pnpm -F @pos/web
preview` (:4173).
