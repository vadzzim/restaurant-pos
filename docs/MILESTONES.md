# Milestones

One session = one milestone = one commit. Full scope, covering all of `docs/spec.md`.

Revised after an external design review. The two structural changes: **a demoable vertical slice
lands at M4 instead of M11**, and correctness holes the first draft left open (kitchen commands
outside the mutation model, undefined queue behaviour after a conflict, consumers without a real
side effect, tenant scoping) are now explicit milestones rather than assumptions.

The **Model** column is a recommendation for working within Pro-plan limits. Opus is reserved for
the milestones where a mistake is expensive: concurrency, transactions, synchronization.
Sonnet handles the rest without any loss of quality.

Rule: if `docs/milestones/MXX.md` does not exist, first expand the brief below into that file
(goal, in/out of scope, files, key decisions, Verification block, definition of done), then start
work. Expand it immediately before the session rather than in advance — that way the brief can
reference code that actually exists.

The **Demo** column answers: after this session, can the project be shown to somebody?

| # | Session | Size | Model | Demo | Status |
|---|---------|------|-------|------|--------|
| M0 | Scaffolding and planning | S | Sonnet | no | done |
| M1 | Baseline commit + monorepo + Compose | M | Sonnet | no | done |
| M2 | Full schema + migrations + seed | M | **Opus** | no | done |
| M3 | Vertical slice, backend | **L** | **Opus** | no | done |
| M4 | Vertical slice, frontend | **L** | Sonnet | **yes** | done |
| M5 | All remaining commands + conflict rules | **L** | **Opus** | yes | done |
| M6 | Error model + logging + split health + CI | M | Sonnet | yes | done |
| M7 | Dexie / IndexedDB persistence | M | Sonnet | yes | done |
| M8 | Offline queue + sync + halt-on-conflict | **L** | **Opus** | yes | done |
| M9 | Outbox hardening + crash-window tests | **L** | **Opus** | yes | done |
| M10 | BullMQ print job | M | Sonnet | yes | done |
| M11 | Debug dashboard + counters + presence | M | Sonnet | yes | done |
| M12 | Failure simulator | M | Sonnet | yes | done |
| M13 | Feature flags + polling fallback | M | Sonnet | yes | done |
| M14 | Production images + multi-instance smoke | M | Sonnet | yes | done |
| M15 | POS UX for rush + BAR-1 | M | Sonnet | yes | done |
| M16 | `/demo` guided scenarios | M | Sonnet | yes | done |
| M17 | PWA + service worker | S | Sonnet | yes | done |
| M18 | Playwright E2E | M | Sonnet | yes | done |
| M19 | All documentation + final smoke | **L** | **Opus** | yes | done |
| M20 | Backlog sweep | M | **Opus** | yes | done |
| M21 | Verification that can fail | M | **Opus** | yes | done |
| M22 | The flag path, end to end | S | **Opus** | yes | done |
| M23 | The cached client | M | **Opus** | yes | done |
| M24 | The deployment surface | M | **Opus** | yes | done |
| M25 | Prometheus observability | M | **Opus** | yes | done |
| M26 | Portfolio presentation and recorded demo | M | **Opus** | yes | done |

**Twenty-seven milestones, M0 through M26 — all run.** The scope grew from the review's
additions and nothing was cut; that was a deliberate call, recorded in `docs/PROGRESS.md`.

**M10 was first on this list and was built anyway** — see ADR 014 for what it turned out to be
worth: the one component here where a job and its record may disagree, and the reconciler that
makes that safe. If the interview date closes in from here, drop in this order: **M16** (`/demo`, a
wizard over functionality that already works), then **M17** (PWA, which adds nothing the IndexedDB
layer does not already do). Do **not** drop M15 or M18 first: the role is *Full-Stack* with Vue in
the title, and rush-speed POS UX plus a browser-level E2E test are the two milestones that demonstrate
frontend maturity rather than backend theory.

---

## Briefs

### M1 — Baseline, monorepo, infrastructure
`git init`, then a **baseline commit of the M0 documents before any code** so the "done" marker on
M0 corresponds to a real commit. `.gitignore`. pnpm workspace covering `apps/{api,web,worker}` and
`packages/{contracts,domain,config}`. Root scripts, a strict tsconfig base, ESLint + Prettier.
`docker-compose.yml` with postgres, redis, redpanda and the Redpanda console; app services behind
a dev profile. `.env.example` plus `packages/config` for zod-parsed environment variables.
Minimal working processes: Fastify with a stubbed health route, a placeholder Vue page, a worker
logging a heartbeat. Verification: `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm build`
green; the user brings up Compose and confirms four healthy containers.

### M2 — Schema and data
Drizzle: all thirteen tables from §4 at once, real migrations, foreign keys, unique constraints,
and only the intentional indexes — including the partial outbox index ordered by
`next_attempt_at`, and the `claimed_by` / `claim_until` lease columns the §10 publisher needs.
`pnpm db:migrate`, `pnpm db:seed` — two restaurants, **four terminals (`POS-1`, `POS-2`, `BAR-1`
in the first, `POS-3` in the second)**, seven products, the `realtime.websocket_push` flag.
The second-tenant terminal is required by the cross-tenant test and the flag rollout demo. The schema is written once, in full — changing it
later is expensive. Verification: the migration applies to a clean database, the seed is
idempotent, every table can be selected from.

### M3 — Vertical slice, backend
The narrowest honest path through the whole architecture. `packages/domain`: status transitions,
`totalCents`, and the conflict rules needed for this slice. The mutation handler with the complete
§7 transaction — tenant scoping, idempotency including `request_hash` comparison, versioned
UPDATE, item changes, `processed_mutations`, `outbox_events`.
`POST /api/orders/:orderId/mutations` supporting `CREATE_ORDER`, `ADD_ITEM` and `SEND_TO_KITCHEN`
only — with the client generating `orderId`, so creation is idempotent like every other write and
there is no separate creation endpoint. The outbox publisher with the three-step lease from §10:
claim in a short transaction, publish outside any transaction, mark in a second short transaction.
The kitchen consumer building the `kitchen_tickets` projection transactionally with
`processed_events`. Tests §21.1, §21.2, §21.3, §21.5, §21.6, §21.11, §21.15.
Deliberately out of scope: every other mutation type, the full conflict matrix, HTTP polish,
any UI. Verification: tests green, and an event inserted by a mutation ends up as a projection row.

### M4 — Vertical slice, frontend — first demoable state
Vite + Vue 3 + TS + Pinia + Router + Tailwind. Socket.IO on the API with the Redis adapter and
rooms; the realtime consumer broadcasting per §12.2, including the client-side `eventId` and
version filtering. A minimal POS screen (menu, current order, add item, send to kitchen, order
version badge) and a minimal Kitchen screen reading the projection. No offline support, no debug
page, no styling beyond legible.
Verification: two browser windows — POS-1 sends an order to the kitchen and it appears there
through Postgres, the outbox, Redpanda, the consumer and the socket. **This is the first state
that can be shown to a person.**

### M5 — All remaining commands and the full conflict matrix
`REMOVE_ITEM`, `CHANGE_QUANTITY`, `PAY`, `CANCEL`, plus `START_PREPARING` and `MARK_READY` as
real mutations with `mutationId` and `baseVersion` (§5). The kitchen HTTP endpoints as thin
adapters over the same handler. The complete §8 rule set in one domain component, including the
kitchen transition ordering and the rule that item mutations are rejected after
`SENT_TO_KITCHEN`. `conflict_log` writes. Payments with mutation-linked idempotency.
Tests §21.4, §21.9, §21.10. Verification: the full order lifecycle works end to end, and two
concurrent `MARK_READY` mutations produce one success and one conflict.

### M6 — Error model, logging, health, CI
zod validation at every boundary. A single error handler producing `{code,message,details}` with
no stack traces, backed by typed domain errors. pino with correlation fields and a requestId per
request. The three-way health split from §17 — `live`, `ready` (Postgres only), and
`debug/dependencies` — with the reasoning captured in an ADR. `pnpm verify:integration` as the one
reproducible command (Compose up, wait for readiness, run integration tests, tear down, write
output to a file). `.github/workflows/ci.yml` running lint, typecheck, unit tests, then that same
`pnpm verify:integration`, then build — **with no `services:` block**, since the script already
owns the container lifecycle and declaring both would bind the same ports twice.
`GET /api/config` for feature-flag resolution. Verification: CI green on a clean checkout;
stopping Redpanda leaves `/api/health/ready` green and orders still accepted.

### M7 — IndexedDB persistence
The Dexie schema `orders / pendingMutations / syncMetadata`, local state written on every action,
store hydration from IndexedDB at startup. No sync engine yet — persistence only.
Verification: a page reload does not lose the local order.

### M8 — Offline queue, sequential sync, halt-on-conflict
The `Simulate Offline` toggle intercepting at the API-client layer. Pending mutation creation,
optimistic UI, a pending counter. The sequential sync engine per §14: one mutation at a time per
aggregate, handling `APPLIED`, `ALREADY_APPLIED`, `MUTATION_ID_REUSED` and `409`.
**The §14.1 rule in full**: a conflict marks that mutation `CONFLICT`, marks every later mutation
for the same order `BLOCKED` without sending it, leaves other orders syncing, and surfaces an
explicit discard-or-rebase choice in the POS. Nothing auto-resolves.
Tests §21.7 and §21.8. Verification: scenarios §19.2 and §19.3 by hand.

### M9 — Outbox hardening and crash windows
Bounded exponential backoff via `next_attempt_at`, `attempt_count`, `last_error`, and a visible
dead-letter state. Lease expiry and reclaim hardening on top of the M3 publisher. Pause and delay
controls, built as real operational switches that M12 will surface.
Tests §21.12, §21.13 and §21.16 — the publish-then-crash window, the
consumer-commit-then-crash window, and lease reclaim under two concurrent workers.
Verification: pausing the publisher leaves events in the outbox and the order intact; resuming
publishes them; a forced failure loop dead-letters visibly; killing a worker mid-publish results in
a republished event that the consumer deduplicates.

### M10 — BullMQ print job
A fake local printer endpoint that can be made to fail on demand and that honours an idempotency
key. The kitchen consumer enqueues a print job keyed by `order_id` after its transaction commits.
`print_jobs` as the durable record, `ticket_hash` for deduplicating the record, bounded backoff, a
dead-letter state, and a periodic sweep reconciling missing jobs from `kitchen_tickets`.
Test §21.14.

**The guarantee is at-least-once and a duplicate ticket can physically print** (§12.3) — the
milestone must say so in the UI and the docs, not imply exactly-once. That honesty is the point:
a missing ticket loses an order, a duplicate wastes paper, and for a kitchen that is the right
trade. This is BullMQ's one justified responsibility; see `docs/adr/010-db-outbox-retries.md` for
why it is not used for the outbox. **This is also the first milestone to cut if time runs short.**
Verification: scenario §19.9.

### M11 — Debug dashboard
Every counter from §20, `/api/debug/{events,conflicts,outbox,dependencies,metrics}`, terminal
presence in Redis, and the `/debug` page with all sections from §16 — including dead-lettered
outbox rows, print job state, and hard-vs-soft dependency marking.
Verification: all sections populate against live traffic.

### M12 — Failure simulator
The eleven controls from §18, each with visible feedback, reusing the switches built in M9 and
M10. Verification: exercise every control.

### M13 — Feature flags and the polling fallback
The `feature_flags` table plus a Redis cache, percentage rollout by a hash of `restaurantId`, and
toggling from `/debug` without a restart. The polling transport as a **complete second
implementation** of realtime updates (§13, §15), with the POS showing which transport is active.
Already-open clients pick up a flag change by polling `GET /api/config` every 15 s — not by
reload, and not by a WebSocket control event, which would be circular when the flag turns
WebSocket off.
Verification: flipping `realtime.websocket_push` off keeps the UI correct at higher latency, and a
rollout percentage puts `POS-1` and `POS-3` on different transports at the same time, side by side.

**Carried over from M11's review (`known-problems.md`, `[M11, P2]`):** the presence heartbeat is
installed by `connectRealtime`, so a client on the polling transport sends none and vanishes from
`/debug`'s active-terminal panel. Today that only affects the dead `PUSH DISABLED` branch; this
milestone makes polling a fully working transport, at which point a working terminal would be
invisible. Presence has to move out of the socket — or gain a second path — as part of M13, not
after it.

### M14 — Production images and multi-instance smoke
A multi-stage Dockerfile per app, non-root, built output only. A Compose overlay running two `api`
replicas behind the Redis adapter. A smoke test asserting that a mutation applied via replica A
reaches a WebSocket client attached to replica B. Verification: scenario §19.10 — this is what
turns the Redis-adapter claim into a tested fact.

### M15 — POS UX for rush and BAR-1
Large touch targets, one-tap quantity, no modals on the critical path, a clear conflict banner,
and the `bar-1` terminal wired up. Verification: the full flow is comfortable at speed in a
browser window sized like a terminal.

### M16 — Guided demo
`/demo` walking through all ten scenarios from §19 step by step, highlighting what to watch and
offering trigger buttons that call the M12 simulator.
Verification: each scenario can be performed by following the instructions, with no improvisation.

### M17 — PWA
Manifest and service worker — carefully: it must not break dev mode, and it must never cache API
mutations or the snapshot endpoint. Installability. Verification: installing the app and reloading
offline still shows the last local order, with the sync engine unaffected.

### M18 — Playwright E2E
The browser test from §21: POS-1 creates an order, adds an item, sends to kitchen, the kitchen
screen shows the ticket, PREPARING is marked, the POS updates. Wired into CI.
Verification: `pnpm test:e2e` green locally and in CI.

### M19 — Documentation and finale
`docs/architecture.md` with Mermaid diagrams including the blocked-queue branch. All eleven ADRs.
The weaknesses section and the answers §23 lists, each landing on an ADR or a test rather than on
prose. The scale section. The README. Final run of `pnpm lint typecheck test build` plus
`pnpm verify:integration` and a manual smoke of the main flow.
Verification: walk the Definition of done in §26 point by point, honestly.

### M20 — Backlog sweep
Not planned here; added after M19. The dedicated pass `CLAUDE.md` promised every three or four
milestones and that was deferred at every one of them, taken once over all thirty `known-problems.md`
entries. Brief: `docs/milestones/M20.md`. Verification: the three test suites, lint, typecheck,
build and `pnpm verify:integration`, plus one new test per structural fix.

---

## The second sweep, M21–M24

M20 swept the backlog in one pass over thirty unrelated entries, and the cost of that shape was
that every fix needed its own context: a service worker, a `verify:*` script, a Pinia store and a
Redis cache in the same session. The seventeen entries left are grouped instead **by the surface
the fix lives on**, so each of the four below has one Verification block rather than four, and each
can be dropped whole if the interview date closes in.

Every entry named here is a line under *Review backlog* in `docs/known-problems.md`. A milestone is
finished when its lines are gone from that file — deleted if fixed, moved up into *Accepted limits*
if the answer is that the behaviour is right and the line was mis-filed as a defect.

### M21 — Verification that can fail
The two P2s that let a green run mean nothing, and the two E2E P3s beside them. `[M18, P2]` — the
end-to-end run reuses whatever answers on `:3000` and can therefore report PASS for API code it did
not build. `[M14, P2]` — `verify:multi` migrates, seeds and writes to the **demo** database, so a
smoke run leaves orders in the demo. `[M18, P3]` — the worker is killed rather than stopped, so on
Windows the `kitchen` group holds a dead member and the next run waits out the rebalance.
`[M18, P3]` — the spec asserts no money, so a server computing `totalCents` wrongly would pass.
Verification: `pnpm test:e2e` fails against a stale API instead of passing; `pnpm verify:multi`
twice leaves the demo database untouched; the spec fails when a seeded price is changed.

### M22 — The flag path, end to end
`[M13, P2]` — a cache-aside fill can overwrite an invalidation, so a fleet-wide toggle is not
immediate for one `FLAG_CACHE_TTL_MS`. `[M20, P3]` — `flags.busy` holds one key, so two overlapping
toggles leave the first switch enabled while its request is out. Then the three entries whose
answer is *not a fix*, each to be re-argued once and moved into *Accepted limits* or deleted:
`[M19, P3]` the realtime consumer's mark-then-emit order (§12.2 chose it), `[M19, P3]` the
`TimeoutNegativeWarning` from a dependency, `[M20, P3]` a resolution reported offline is never
recorded. Verification: a fill paused across a concurrent write does not resurrect the old rows;
two toggles inside one tick disable both switches.

### M23 — The cached client
The three service-worker entries and the two `/demo` ones — one file each, one browser to test them
in. `[M17, P2]` `activate` deletes the previous build's cache under a page still running the old
bundle (ADR 017 names code splitting as the condition to revisit). `[M17, P3]` a failed precache
fails the whole installation. `[M17, P3]` the update path force-reloads the tab with no prompt, and
a half-typed table name would be lost. `[M16, P3]` no UI path puts a second terminal on an existing
order, so §19.3's literal two-terminal form needs `curl`. `[M16, P3]` `/demo`'s step ticks are
in-memory, so a reload mid-demo loses the place. Verification: a dynamic `import()` still resolves
after a rebuild-and-reload offline; POS-2 can open POS-1's order from the UI.

### M24 — The deployment surface
The three M14 P3s, all in files nothing outside `verify:multi` and CI touches. `[M14, P3]` nginx
resolves `api-1` and `api-2` once at load, so a restarted replica is proxied to a dead address.
`[M14, P3]` `worker-prod` declares no healthcheck, so `--wait` proves only that the container runs.
`[M14, P3]` the CI `images` job builds three images and never starts one, and the base images float
on tags rather than digests. Verification: recreating a replica under `verify:multi --keep` keeps
:8081 serving; the `images` job fails when an image cannot start.

---

## Portfolio passes, M25–M26

### M25 — Prometheus observability
A deliberately small Prometheus surface at `/metrics`: bounded HTTP and mutation counters, request
duration, per-instance WebSocket presence, and PostgreSQL-backed outbox/print gauges collected only
on scrape. Add one integration test, a metric catalogue, and three alert examples; do not add a
Prometheus deployment, dashboards, tracing, or pretend consumer lag is exported. Verification:
lint, typecheck, 507 tests, real integration round trips, the production images, and the existing
two-replica assertion.

### M26 — Portfolio presentation and recorded demo
Move the system's strongest engineering evidence, CI badge, and an implemented-components diagram
into the first README screenful. Reuse the existing Playwright lifecycle to record a captioned,
deterministic one-minute demonstration of realtime kitchen delivery, offline queue drain, explicit
conflict recovery, and a paused/resumed outbox. Keep the ordinary E2E spec unchanged, publish a
browser-compatible H.264 MP4 outside Git history, keep generated source media local, and clean
recorder scratch files without adding a media dependency. Verification: the recording spec and
ordinary E2E both pass, the video metadata is sane, every local README link resolves, and Mermaid
CLI renders the diagram.
