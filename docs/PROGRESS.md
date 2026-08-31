# Progress / Handoff

> **The only progress file read at the start of a session**, with `docs/milestones/MXX.md`; `grep` the
> others, never open them whole. **Hard limit 8 000 characters** — overflow goes to
> `known-problems.md` or `build-log.md`. Rewrite per milestone; never append.

## Current state

**The project was finished at M19, and M20–M24 finished the backlog.** M24 was the last pass of
_The second sweep_: the three `[M14, P3]`s on the deployment surface plus M21's and M22's two
leftovers. **The seventeen are closed and no P2 is left**; the five lines that remain in
`known-problems.md` were all found *by* the sweep, and each is unreachable as deployed or bounded by
an argument in its own line.

**A Codex pass on the M24 commit returned four P2s and no P1, and all four were fixed** (a second
commit; the rule would have backlogged them). **Two were introduced by M24 itself**, by its
cheapest-looking change: moving `verify-e2e.mjs`'s port probe to the front. The one-line reorder was
the part that needed reviewing.

- **Two of M24's three fixes were one defect.** nginx resolving `api-1` at config-load time is why a
  recreated replica is proxied to a dead address *and* why the web image could not start outside the
  Compose network — hence a CI job that built three images and started none. `resolver 127.0.0.11
  valid=10s`, an upstream `zone`, `resolve` per `server`. **Not** a variable `proxy_pass`: it drops
  the URI, and it takes one host, so `ip_hash` — load-bearing for the Socket.IO polling
  handshake — would go with it. `resolve` was Plus-only until **1.27.3**; the base is pinned at
  1.29.8 and must not be lowered.
- **`verify:multi` used to pass without ever using nginx** — `web-prod`'s healthcheck asks for `/`,
  §19.10 talks to the replicas direct. A step now probes `:8081/api/health/ready` **through the
  proxy**: the only automated proof that resolution happens at request time.
- **The worker has a readiness surface** (`modules/health/worker-health.ts`, ADR 011 amended): two
  `node:http` routes, readiness = broker session **and** one completed publisher pass **and** the
  print pipeline consuming — that last is `isRunning() && connection.status === 'ready'`, because
  **BullMQ's loop keeps running while its blocking client reconnects** and the loop alone reported
  200 through a Redis outage (Codex). **`WORKER_HEALTH_PORT` has no default on purpose**:
  `verify:e2e` starts a worker beside the user's own.
- **The CI `images` job starts each image**, each proving something different with no
  infrastructure: the api answers 200 on `/health/live` and **exactly 503** on `/health/ready` —
  read as a *status code*, since wget's exit code says the same about a 404 or a dead container
  (Codex); the worker reaches `outbox_controls`, which is its whole module graph resolving; the web
  image serves the bundle. `load: true` is mandatory — `push: false` alone leaves the image out of
  the daemon. An **empty environment does not fail configuration**: every knob has a default.
- **`finish()` no longer infers what it started.** It removed every service not *running* at
  snapshot time, which stops meaning "what this run started" once `finish` can be reached before
  `up()` — so a run that refused a foreign API and started nothing would have `rm -sf`'d the user's
  stopped containers (Codex). `compose-run.mjs` records each `up()`'s intent instead. The preflight
  also asks `/health/live`: readiness is 503 whenever PostgreSQL is down, which is the state that
  script starts in every time.
- **M24's own review pass found one P1**: the `pos_multi` init script was mounted into `postgres`
  *from the overlay*, so `verify:multi` recreated the user's demo PostgreSQL on every run. Moved
  into `docker-compose.yml` — see the standing decision below.

**Green:** lint, typecheck, `pnpm test` **506 passed**, build, **`verify:multi` PASS ×4**. The three
CI smoke commands were run by hand against `pos-*:local`, the api one **verbatim** out of `ci.yml`
under `bash -e -o pipefail`; `pnpm test:e2e` against a foreign API refuses in **one second**, tearing
down nothing.

**CI has now actually run**, on `github.com/vadzzim/restaurant-pos`: five green jobs on each of two
commits ([06b6a79](https://github.com/vadzzim/restaurant-pos/actions/runs/33415271193),
[f2ebef3](https://github.com/vadzzim/restaurant-pos/actions/runs/33416213901)). Nothing needed
configuring — no secrets, no service containers, no `.env`: Compose has no `${...}` substitution,
`@pos/config` defaults every URL to the ports it publishes, and every `--env-file` outside the `dev`
scripts is `--env-file-if-exists`. Run logs need a token, so green is read off step statuses.
The push falsified four documents and closed clause 18; the sweep, including eleven references to an
excluded document that was never committed, is in `build-log.md`.

## What exists

One line per unit; detail is in the code and the ADRs. Docs: **ADRs 001–019** (`adr/README.md`),
`milestones/M01…M24`; `spec.md` §23 names filenames that drifted.

- `packages/` — `config` zod env; `contracts` the §5 shapes; `domain` `decide()`, **all of §8**;
  `db` fifteen tables, three migrations, seed.
- `apps/api` — the nine-branch mutation endpoint, the §14.1 resolution report, the two §17 kitchen
  adapters, the four reads, `modules/{realtime,printer,debug,config,health}/`;
  `multi-instance.integration.test.ts` is **excluded** by default.
- `apps/worker` — the §10 publisher (ADR 010), the kitchen consumer and its projection,
  `modules/printing/` (ADR 014), **`modules/health/`** (M24).
- `apps/web` — POS, kitchen, `/debug`, `/demo`; seven Pinia stores; Dexie (ADR 013); the §14 sync
  engine; `realtime/`, `domain/`, `sw/`, `pwa/`, **`nginx.conf`**. `e2e/` holds one spec.
- **Images, Compose, scripts, CI** — a Dockerfile per app with **digest-pinned bases**,
  `docker-compose.multi.yml` (the base file's `app` profile is the *dev* stack),
  `scripts/postgres-init/`, `compose-run.mjs`, three `verify-*.mjs`; `ci.yml` runs the three jobs.

## Standing decisions

ADRs are canon; history in `progress-archive.md`. What is not in one:

- Full scope, nothing cut (ADR 001, 007). **All twenty-four milestones ran.**
- **`BAR_MENU` is in contracts, not a `products.category` column**; **leaving a POS route detaches,
  not clears** (M16); **`conflict_log.resolution` is observability**; **the documents link to the
  argument, never restate it.**
- **`src/sw/` imports nothing from `src/` and exports nothing** — a classic `iife` (ADR 017).
- **A pointer move belongs inside `serialize`** — `createOrder`, `clear`, `focusOrder`.
- **A verification run owns its lifecycle and writes `.verify-output/*.log`** — read the tail, never
  a live container log (rule 3). `verify:multi`'s four isolating names live in the overlay *and* in
  the script, and have to agree.
- **Never change a base service's definition from an overlay** (M24): the next `up` through that
  overlay recreates the user's container.
- **The three Dockerfiles' `deps` stage is byte-identical** so BuildKit shares one `pnpm install`.
  Re-resolve the digests together: `docker buildx imagetools inspect node:24-alpine
  --format '{{.Manifest.Digest}}'`.

## Known problems

`docs/known-problems.md`: the accepted limits, then the backlog — **five** entries, **no P2**,
nothing left from the seventeen.

## First command of the next session

**There is no next milestone.** M24 closed the sweep, so the choice is the user's: polish for the
interview, or take one of the five remaining P3 lines — read the last sentence of each first,
because **a line filed as a defect is not thereby one**.

**What is genuinely outstanding, and it is verification rather than code:**

1. **Two M24 hand checks**, needing a stack the user brings up (rule 3 — ask, never
   `docker compose up` yourself). Recreate a replica under `pnpm verify:multi --keep` and watch
   `:8081` keep serving; point `worker-prod`'s `KAFKA_BROKERS` at nothing and watch `up --wait`
   **time out** where it used to report success.
2. **M23's three browser checks are still open**, cheap with `pnpm build` then `preview`: a dynamic
   `import()` resolving after a rebuild-and-reload offline; POS-2 opening POS-1's order by id; three
   ticks on `/demo`, F5, switch scenario.
3. **Still from M19:** walk §19.1 by hand, force a real interleaving in §21.1 and §21.10.
   (Reading a real CI run is done — see above.) `definition-of-done.md` maps what is proved, what is
   argued and what is neither.

Running it: `pnpm -F @pos/api start`, `pnpm -F @pos/worker dev`, `pnpm dev` (:5173).
