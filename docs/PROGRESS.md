# Progress / Handoff

> **The only progress file read at the start of a session**, with `docs/milestones/MXX.md`; `grep` the
> others, never open them whole. **Hard limit 8 000 characters** — overflow goes to
> `known-problems.md` or `build-log.md`. Rewrite per milestone; never append.

## Current state

**The project was finished at M19, and M20–M24 finished the backlog.** M24 was the last pass of
_The second sweep_ — the three `[M14, P3]`s on the deployment surface, plus M21's and M22's own two
leftovers. **The seventeen are closed and no P2 is left**; five lines remain in
`known-problems.md`, every one of them found *by* the sweep (two from M22's review pass, three from
M23's), and each is unreachable as deployed or bounded by an argument written into its own line.

- **Two of M24's three were one defect.** nginx resolving `api-1` at config-load time is why a
  recreated replica is proxied to a dead address *and* why the web image could not start outside the
  Compose network — which is why CI could build three images and start none. `resolver 127.0.0.11
  valid=10s`, an upstream `zone`, `resolve` per `server`. **Not** a variable `proxy_pass`: it drops
  the URI, and it takes one host, so `ip_hash` — load-bearing for the Socket.IO polling
  handshake — would go with it. `resolve` was nginx Plus-only until **1.27.3**; the image is pinned
  at 1.29.8 and must not be lowered.
- **`verify:multi` used to pass without ever using nginx.** `web-prod`'s healthcheck asks for `/`, a
  static file; §19.10 talks to :3001 and :3002 direct. There is now a step probing
  `localhost:8081/api/health/ready` **through the proxy** — the only automated proof that resolution
  happens at request time.
- **The worker has a readiness surface** (`modules/health/worker-health.ts`, ADR 011 amended): two
  routes over `node:http`, readiness = broker session **and** one completed publisher pass **and**
  BullMQ still consuming. A deliberate `paused` counts as a pass — that distinction lives in the
  loop, not the predicate. **`WORKER_HEALTH_PORT` has no default on purpose**: `verify:e2e` starts a
  worker beside the user's demo worker, and a default port would have made this fix a crash.
- **The CI `images` job starts each image**, and each app proves a different thing without
  infrastructure: the api serves `/api/health/live` and **refuses** `/api/health/ready`; the worker
  reaches `outbox_controls`, which is its whole module graph resolving; the web image serves the
  bundle. `load: true` is mandatory — `push: false` alone leaves the image out of the daemon. And an
  **empty environment does not fail configuration**: every knob in `@pos/config` has a default.
- **The review pass found one, in M24's own change.** The `pos_multi` init script was mounted into
  `postgres` *from the overlay*, and an overlay that changes a base service makes `docker compose up`
  **recreate the container** — so `verify:multi` replaced the user's demo PostgreSQL on every run.
  Moved into `docker-compose.yml`. The volume was never at risk; the promise that was is "leave the
  machine as it was found".
- **Moving `verify-e2e.mjs`'s port probe first needed a `snapshot()` moved with it.** `finish` can
  now be reached before anything is running, and it decides what to tear down by difference against
  what was already up — without the snapshot it would have removed the user's containers.

**Green:** lint, typecheck, `pnpm test` **505 passed**, build, **`verify:multi` PASS ×3** (the third
after the postgres fix: `postgres-1 Running`, not `Recreate`). The three CI smoke commands were run
by hand against `pos-*:local`. **Not run:** `verify:e2e`, CI itself.

## What exists

One line per unit; detail lives in the code and the ADRs. Docs are **ADRs 001–019**
(`adr/README.md`) and `milestones/M01…M24`; `spec.md` §23 names filenames that drifted.

- `packages/` — `config` zod env; `contracts` the §5 shapes plus `TERMINALS`, `BAR_MENU`,
  `CONFLICT_RESOLUTIONS`; `domain` `decide()`, **all of §8**; `db` fifteen tables, three
  migrations, seed.
- `apps/api` — the nine-branch mutation endpoint, the §14.1 resolution report, the two §17 kitchen
  adapters, the four reads, `modules/{realtime,printer,debug,config,health}/`. Ten test files, plus
  `multi-instance.integration.test.ts` **excluded** by default.
- `apps/worker` — the §10 publisher (ADR 010), the producer, the kitchen consumer and its projection,
  `modules/printing/` (ADR 014), **`modules/health/`** (M24); CLIs `outbox`/`printer`.
- `apps/web` — POS, kitchen, `/debug`, `/demo`; seven Pinia stores; Dexie (ADR 013); the §14 sync
  engine; `realtime/`, `domain/`, `sw/`, `pwa/`, `vite/`, `public/`, **`nginx.conf`**. `e2e/` holds
  one spec.
- **Images, Compose, scripts, CI** — a Dockerfile per app with **digest-pinned bases**,
  `docker-compose.multi.yml` (the base file's `app` profile is the *dev* stack),
  `scripts/postgres-init/`, `compose-run.mjs`, three `verify-*.mjs`; `ci.yml` runs the three jobs.

## Standing decisions

ADRs are canon; history in `progress-archive.md`. What is not in one:

- Full scope, nothing cut (ADR 001, 007). **All twenty-four milestones ran.**
- **`BAR_MENU` is in contracts, not a `products.category` column**; **leaving a POS route detaches,
  not clears** (M16 — do not put `clear()` back); **`conflict_log.resolution` is observability**;
  **the documents link to the argument, never restate it.**
- **`src/sw/` imports nothing from `src/` and exports nothing** — a classic `iife` (ADR 017).
- **A pointer move belongs inside `serialize`** — `createOrder`, `clear`, `focusOrder`.
- **A verification run owns its lifecycle and writes `.verify-output/*.log`** — read the tail, never
  a live container log (rule 3). `verify:multi`'s four names — `pos_multi`, the `.multi` topic,
  `kitchen-multi`/`realtime-multi`, Redis db 1 — live in the overlay *and* the script.
- **Never add a mount or an env var to a base service from an overlay** (M24). It recreates the
  user's container on the next `up` through that overlay.
- **The three Dockerfiles' `deps` stage is byte-identical** so BuildKit shares one `pnpm install`.
  Re-resolve the pinned digests together:
  `docker buildx imagetools inspect node:24-alpine --format '{{.Manifest.Digest}}'`.

## Known problems

`docs/known-problems.md`: the accepted limits, then the backlog — **five** entries, **no P2**,
nothing left from the seventeen. Its own note states the rule for closing one.

## First command of the next session

**There is no next milestone.** M24 closed the sweep, so the choice is the user's: polish for the
interview, or take one of the five remaining P3 lines. Do not open a sixth pass by habit — read the
last sentence of each line first, because **a line filed as a defect is not thereby one**.

**What is genuinely outstanding, and it is verification rather than code:**

1. **Two M24 hand checks**, both needing a stack the user brings up (rule 3 — ask, never
   `docker compose up` yourself, and never pull container logs). Recreate a replica under
   `pnpm verify:multi --keep` (`up -d --force-recreate api-2`) and watch `:8081` keep serving; point
   `worker-prod`'s `KAFKA_BROKERS` at nothing and watch `up --wait` **time out** where it used to
   report success.
2. **M23's three browser checks are still open**, and cheap with `pnpm build` then `preview`: a
   dynamic `import()` still resolving after a rebuild-and-reload offline; POS-2 opening POS-1's order
   by id; three ticks on `/demo`, F5, switch scenario.
3. **Still from M19:** walk §19.1 by hand, read a real CI run (the two unmet §26 clauses), and
   force a real interleaving in §21.1 and §21.10. `definition-of-done.md` maps what is proved, what
   is argued and what is neither.

**Housekeeping:** `docker rm -f infallible_bhabha` — an idle `pos-api:local` container left by
M24's image probing; `docker rm` is denied inside a session.

Running it: `pnpm -F @pos/api start`, `pnpm -F @pos/worker dev`, `pnpm dev` (:5173).
