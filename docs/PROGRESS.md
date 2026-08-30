# Progress / Handoff

> **The only progress file read at the start of a session**, with `docs/milestones/MXX.md`; `grep`
> the others, never open them whole. **Hard limit 8 000 characters** — overflow goes to
> `known-problems.md` or `build-log.md`. Rewrite per milestone, never append.

## Current state

**Last completed:** M18 — Playwright E2E. §21's last line: one spec that crosses **every** process —
POS-1 opens an order, adds an item, sends it; the kitchen display shows the ticket, marks it
PREPARING, and the POS follows without asking for anything. **ADR 018.**

**`pnpm test:e2e` owns the lifecycle; Playwright owns the bundle's server.** `scripts/verify-e2e.mjs`
reuses `lib/compose-run.mjs` — Chromium, up, migrate, seed, build, teardown of only what it started —
and runs the API and the worker as long-lived `node dist/index.js` children. `webServer` serves
`dist/` on **:4173 via `preview`, never `dev`**: since M17 those are different builds and only one
has the service worker. `pnpm test:e2e:run` is the spec alone, against a stack already up.

**The runner learned to hold processes open**: `startService`, `waitForOutput`, `waitForHttp`,
`crashedServices`. Children are spawned **without `shell: true`** — on Windows a shell wrapper means
`kill` reaps the wrapper and leaves the real process on the port — and are stopped in `finish()`
before the Compose teardown, **even under `--keep`**.

**An API already answering on :3000 is reused, not duplicated.** The first run reported FAIL with the
spec passing: `EADDRINUSE`, the child lost the bind, and the spec ran against the incumbent. Hence
`crashedServices()` rather than trusting Playwright's exit code. Residue: a reused API may run code
the run did not build — P2.

**The Kafka group join is setup, not an assertion's budget.** `child.kill()` on Windows is a
terminate, so the worker never sends `LeaveGroup`; the group holds a dead member for its session
timeout, and **while a rebalance is in flight nobody consumes**. Joins escalated 14.8 s → 28.5 s →
never, and the third run failed. The script now waits for the worker's `broker connected` and — when
it started the API — the API's `realtime consumer running`, on `GROUP_JOIN_TIMEOUT_MS = 120_000`. The
spec went from 25.2 s to 3 s. **Do not fold that back into `PIPELINE_TIMEOUT_MS`.**

**No test hooks in the production markup** — roles, labels and text only; the product name comes out
of a tile's `aria-label`. **No database reset either**: the cover is unique per run. The §18 arms and
`realtime.websocket_push` are reset in the spec's `beforeEach`, so `test:e2e:run` is covered too.

**Green:** `pnpm test:e2e` PASS (spec 2.9 s), lint, typecheck (**three** projects —
`tsconfig.e2e.json` exists because Playwright resolves like a bundler), build, 451 tests unchanged.

**Three P1s, and the two that mattered were Codex's.** Mine: a throw bypassed `runner.finish` and
would orphan a worker. Codex's first: `pnpm install` never installs Chromium, so the verifying
command failed on a fresh checkout. Codex's second is the one to remember — **`openPos` waited for a
menu tile, which is ready before the socket is**, and `onConnected` refetches the snapshot, so a late
socket satisfied the final assertion with a plain re-read and the broadcast leg could have been dead.
Both pages now wait for `WS CONNECTED`, which also asserts this runs on the socket and not §15's
fallback. **Nothing left open.**

**Next:** M19 — documentation and the finale. Opus, **L**. The last one.

## What exists

One line per unit; detail lives in the code and the ADRs.

- **Docs** — what CLAUDE.md lists, plus `milestones/M01…M18.md`. **ADRs 001–018 accepted.**
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
- `e2e/` + `playwright.config.ts` + `tsconfig.e2e.json` — one spec and its preflight helpers.
- **Images, Compose, scripts, CI** — a Dockerfile per app, `nginx.conf`, `docker-compose.multi.yml`
  (the base file's `app` profile is the *dev* stack), `compose-run.mjs`, **three** `verify-*.mjs`.
  `ci.yml` jobs: `verify`, `e2e`, `images`.

## Standing decisions

ADRs are canon; history in `progress-archive.md`. What is not in one:

- Full scope, nothing cut (ADR 001, 007). **One left: M19.** It may not be dropped.
- **`BAR_MENU` is in contracts, not a `products.category` column.** Argued beside the constant.
- **Leaving a POS route detaches; it does not clear.** M16. Do not put `clear()` back.
- **The icons are generated** — `apps/web/scripts/make-icons.mjs`, by hand, not by the build.

## Known problems

`docs/known-problems.md`: limits, then the P2/P3 backlog — **twenty-seven** entries, four from M18.
**Long overdue for its sweep**, but M19 is an L: sweep only what §26 forces.

## First command of the next session

```
Read CLAUDE.md and docs/PROGRESS.md, then expand M19 from docs/MILESTONES.md into
docs/milestones/M19.md and implement M19 only. It is the last milestone.

M19 is §23 documentation plus the finale: docs/architecture.md with Mermaid (system diagram, the
offline-sync sequence *including the blocked-queue branch*, the outbox sequence); the whole of
docs/interview-guide.md — 5-minute pitch, 15-minute walkthrough, the §19 demo script for all ten
scenarios, honest answers to every question §23 lists, and the weaknesses section; the scale
section; the README. Then walk §26's Definition of done point by point, honestly.
Verification: §26 walked, plus lint, typecheck, test, build, verify:integration and a hand smoke.

Six things worth knowing before you plan:

1. **This is a writing milestone with a large read surface, and the budget is the risk.** Every
   answer §23 asks for is already argued in an ADR or in build-log.md. `grep` them for the
   argument and *link*; do not re-derive and do not restate. ADRs 001-018 are canon.
2. **The weaknesses section is not a formality — the honest material already exists.** It is
   `docs/known-problems.md`: the accepted limits, then twenty-seven P2/P3 entries. That file is the
   source; the guide's job is to choose and frame, not to invent.
3. **README says "M1 contains only the runnable monorepo".** It has been wrong for seventeen
   milestones. Fix the top of that file, and add §23's "Engineering concepts demonstrated".
4. **Nothing in §26 is aspirational — check each clause against a test or a command**, and where
   one is only argued rather than tested, say so. `known-problems.md` already admits that the two
   concurrency tests assert invariants rather than forcing the interleaving.
5. **Do not run `docker compose` by hand** (CLAUDE.md rule 3). `verify:integration`, `test:e2e` and
   `verify:multi` each own their lifecycle and write to `.verify-output/*.log`; read the tail.
6. **`docs/spec.md` §23 lists ADR filenames that drifted** — `006-kafka-at-least-once` is
   `006-realtime-consumer.md`. `docs/adr/README.md` is the real index; trust it.

Running it: `pnpm -F @pos/api start`, `pnpm -F @pos/worker dev`, and `pnpm dev` (:5173) or
`pnpm -F @pos/web build && pnpm -F @pos/web preview` (:4173). Postgres, Redis and Redpanda were up,
and an API and a worker were running on :3000, at the end of M18.
```
