# 018. The E2E run owns the stack; the spec owns the reset

Status: accepted
Date: 2026-08-31

## Context

§21's last line is one browser test — the only check here that crosses every process: browser → API
→ outbox → Redpanda → consumer → projection → WebSocket → a second browser. CLAUDE.md forbids
bringing the stack up by hand or reading a log stream, so the run has to own it.

## Decision

**Against the production preview build.** M17 made `dev` and `build` different — the service worker
exists only in the latter — so the spec runs against `preview` (:4173, `dist/`, the proxy nginx
serves in the image). :5173 would test a bundle nobody ships.

**`scripts/verify-e2e.mjs` owns the lifecycle; Playwright owns the bundle's server.** The script
reuses `lib/compose-run.mjs` — up, migrate, seed, build, teardown of only what it started — and runs
the API and the worker as long-lived `node dist/index.js` children (`startService`, spawned
**without** a shell so a kill is a kill on Windows). `webServer` handles the preview: it already
waits for a port and reaps a process tree. Compose's `app` profile is unused — it is the _dev_ stack.

**Poll, never sleep, and pay for readiness in setup.** Readiness is `/api/health/ready` (503 until
all three dependencies answer, ADR 011) _plus_ both Kafka consumer groups having their assignment,
read off each process's log. A group join can take half a minute — a worker killed on Windows never
sends `LeaveGroup`, so the previous run holds a member until its session expires and nobody consumes
during the rebalance — and that is a setup cost, not the pipeline's. Charging it to an assertion is
what made the third trial run fail. Every cross-process assertion is web-first with a named budget;
no `waitForTimeout` anywhere.

**The reset is in the spec, not the script.** The four §18 controls are rows in PostgreSQL (ADR 015)
and `realtime.websocket_push` is seeded `onConflictDoNothing`, so a demo's leftovers survive a
re-seed and fail this test the way a broken broker would. `beforeEach` clears them, so the spec run
against a developer's own stack gets the same guarantee.

## Consequences

No test hooks in the markup — locators are roles, labels and text — and no database reset: the cover
is unique per run and every kitchen locator is scoped to that card. `tsconfig.e2e.json` exists
because Playwright resolves like a bundler while every app here is `NodeNext`. Chromium only,
`workers: 1`, one retry in CI with a retained trace: a failure here is usually a timeout, and the
trace is the only thing that says whose.
