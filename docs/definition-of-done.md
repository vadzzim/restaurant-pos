# Definition of done, walked

`docs/spec.md` §26, clause by clause, with the thing that proves each one. Written in M19 against
the repository as it stands, and deliberately unflattering: **four** clauses below are not fully
met — two of them not met at all — and one more is carried by an argument rather than by a test.

Legend: **proved** — an automated check fails if the clause is false. **argued** — the reasoning is
written down and reviewable, but no test would fail. **partial** — stated where it falls short.

---

### 1. A fresh developer can start the project from the README — _argued_

`README.md` gives the prerequisites, four commands to start, the URLs, and five verification
commands.
Two things a fresh checkout genuinely needs and cannot get from `pnpm install` are named there: the
`.env` copy, and `playwright install chromium` (which `pnpm test:e2e` does for you).

Not proved: nobody has run it on a machine that never built this repository. The closest evidence is
the CI workflow, which installs from the lockfile and runs the same commands — and see clause 18.

### 2. Two independent POS terminals work — _proved_

`TERMINALS` in `@pos/contracts`, routes `/pos/pos-1` and `/pos/pos-2`. Independence is per terminal
in storage and in the engine: `apps/web/test/sync-engine.test.ts` — _"blocks only the followers of
the terminal that conflicted"_ and _"drains the terminal requested during a running pass, not the
one it started with"_; `apps/web/test/order-store-behaviour.test.ts` — _"a queued mutation belongs
to the terminal that formed it"_; `apps/web/test/persistence.test.ts` — _"the cached order and the
terminal pointer"_.

**Partial, and stated in `known-problems.md`:** no UI path puts a second terminal onto an existing
order, so §19.3's literal two-window form needs `curl`. `/demo` uses the `Create Version Conflict`
arm instead, which produces the same halt.

### 3. The kitchen receives orders in real time from a real projection — _proved_

The projection is a table, not a log line: `apps/worker/test/kitchen-projection.test.ts` walks
`SENT_TO_KITCHEN → PREPARING → READY` as mutations land. The _real time_ half crosses processes and
is `e2e/kitchen-flow.spec.ts` under `pnpm test:e2e` — POS → API → outbox → Redpanda → consumer →
projection → WebSocket → the other browser context, with no reload and no polling.

### 4. The POS stays usable offline — _proved_

`apps/web/test/offline-toggle.test.ts` (_"Simulate Offline"_) and `order-store-behaviour.test.ts`
(_"the queue is a queue, not a slot"_) for the optimistic path with the network cut;
`hydration.test.ts` for what survives — _"a reload keeps the order and the identity of what was in
flight"_, and _"a device that cannot store anything still takes orders"_ for the storage-refused
case. Reload-with-no-network is the service worker: `service-worker.test.ts` and
`cache-policy.test.ts`, and the M17 verification walked an offline reload drawing the product grid.

### 5. Pending mutations synchronise sequentially, and a conflict halts the queue for that order with an explicit operator resolution — _proved_

`apps/web/test/sync-engine.test.ts`, §21.7 and §21.8: creation order preserved; the conflict marked
and everything behind it `BLOCKED`; the halted group not re-sent on the next pass; a different
order still syncing. The resolutions are the `§14.1 resolutions` block — discard drops the group,
rebase re-issues **one at a time** at the version the previous one produced, and stops on a second
conflict with the rest still blocked.

### 6. Stale writes are detected — _proved_

`apps/api/test/mutations.test.ts` §21.1 — _"lets exactly one of two mutations at the same
baseVersion win"_. See clause 17 for what that test does and does not establish.

### 7. Kitchen commands obey the same concurrency model — _proved_

§21.10 in the same file — _"lets one of two MARK_READY mutations at the same baseVersion win"_ and
_"refuses a kitchen transition taken out of order"_ — plus _"the kitchen command endpoints (§17)
construct the same mutations the canonical write path would"_, which is what makes the two adapters
thin rather than a second write path.

### 8. A duplicate mutation cannot duplicate a side effect, and a reused `mutationId` with a new payload is rejected — _proved_

§21.2 _"applies the business effect exactly once"_ and _"serialises two concurrent retries into one
effect"_; §21.3 _"rejects a reused id carrying a different payload and keeps the original effect"_.
Two further races the reviews found are covered: a concurrent reuse, and an id reused across two
orders where only the primary key can catch it.

### 9. Order creation is itself an idempotent mutation — _proved_

§21.15: `ALREADY_APPLIED` and one order for the same mutation; the existing order for a new
`mutationId` with identical content; a conflict for the same `orderId` with different content.

### 10. The outbox publisher never holds a lock across a broker call, and its at-least-once behaviour is stated rather than hidden — _proved and stated_

`apps/worker/test/outbox-publisher.test.ts` — _"claims, publishes outside the transaction, then
marks the row published"_ — plus the lease tests (§21.16) and _"gives up on a send still outstanding
when the lease runs out, and spends no attempt"_.

Stated, not hidden: ADR 010, and two entries in `known-problems.md` — a send abandoned at the end of
its lease may still reach the broker, and a row can be reclaimed for ever with `reclaim_count` on
`/debug` as the only alarm.

### 11. Cross-tenant mutations are rejected — _proved_

§21.11 — _"rejects with 403 and changes nothing"_ — and the kitchen adapters get the same test.
Also the race: _"does not hand a concurrent CREATE_ORDER from another restaurant the winner order"_.

### 12. The database change and event creation are atomic — _proved_

§21.5 — _"writes the order change and the event together, or neither"_.

### 13. Events genuinely flow through Redpanda, with retries and dead-lettering in PostgreSQL — _proved_

`apps/worker/test/kafka-roundtrip.integration.test.ts` publishes an outbox row through a real broker
and a real consumer group into a kitchen ticket, under `pnpm verify:integration`. Retries and
dead-lettering: _"schedules a retry with backoff when the broker rejects the publish"_ and
_"dead-letters a row that exhausts its attempts instead of dropping it"_, plus _"a batch interrupted
by the broker going away spends one attempt and abandons the rest of the claim untouched"_ — the
rule that keeps dead-lettering meaningful.

**Stated limit:** Kafka is in the test path exactly twice (this and clause 17's redelivery test).
Everything else uses a fake transport.

### 14. A duplicate Kafka event does not duplicate effects — _proved_

§21.6 — _"applies the same event twice as one projection row and one `processed_events` row"_ — and
the two neighbours that are easy to conflate with it: never moving the projection backwards on an
older redelivery, and recording events it does not project so they are not re-read for ever.

### 15. Canonical updates reach connected clients over WebSocket, across two API instances — _proved_

`apps/api/test/multi-instance.integration.test.ts` §19.10 — _"delivers a mutation applied through
replica A to a client attached to replica B"_. It is excluded from the default suite and runs under
`pnpm verify:multi`, against the **production images**, two addressable replicas and nginx — and
since M24 nginx is in the assertion rather than only in the stack: the run probes
`:8081/api/health/ready` through the proxy, which is the only automated proof that it resolves an
upstream at request time.

### 16. The polling fallback works and is percentage-rolled by feature flag — _proved_

`apps/web/test/transport.test.ts` — the socket opens when the flag is on, the snapshot is polled
when it is off, and the transport is re-chosen on the 15-second config poll.
`apps/api/test/flags.test.ts` — the rollout hash is stable per restaurant, a percentage separates
the two seeded restaurants, the master switch overrides the percentage, a toggle is invalidated in
the cache without a restart, and — since M22 — a fill stalled across that toggle does not put the
pre-toggle rows back (ADR 019).

### 17. Critical consistency guarantees have automated tests, including the two crash-window cases — _proved, with one honest gap_

Both crash windows are real integration tests: §21.12 _"the publish-then-crash window"_ —
republishes the event and the consumer applies the projection exactly once — and §21.13 _"the
consumer-commit-then-crash window"_ — redelivers the uncommitted event and leaves the projection
where it was.

**The gap, and it is the one I would close first:** §21.1 and §21.10 assert **invariants**, they do
not force the interleaving. They cannot fail falsely, but neither is a proof that the unguarded code
was broken — the reasoning is in `build-log.md`, and reasoning is not a test. Forcing a genuine race
needs advisory-lock choreography or a fault-injecting proxy.

### 18. CI is green on a clean checkout — **not met**

`.github/workflows/ci.yml` is complete — three jobs (`verify`, `e2e`, `images`), installing from the
lockfile, declaring no service containers of its own because `verify:integration` and `test:e2e` own
their lifecycles, and uploading both verification logs. It has **never run**: this repository has no
git remote. What has been established is that its commands pass locally, which is the same command
list.

To close it: push to a remote and read the run. Nothing in the workflow is known to be wrong; it is
simply unexecuted, and calling that "green" would be the kind of claim this document exists to
refuse.

### 19. The architecture doc and interview guide are complete and honest about weaknesses — _met, by inspection_

`docs/architecture.md` — three Mermaid diagrams (system, offline sync including the blocked-queue
branch, outbox), plus the §23 scale section split into _already true here_ and _would have to be
built_. `docs/interview-guide.md` — the five-minute pitch, the fifteen-minute walkthrough, the
demo script table over all ten §19 scenarios, answers to all eighteen questions §23 names, and ten
weaknesses drawn from `known-problems.md` rather than invented.

Honesty is delegated rather than performed: `docs/known-problems.md` carries the accepted limits and
a P2/P3 backlog of twenty-eight entries, and the guide chooses from it.

### 20. `pnpm lint typecheck test build` are green — _proved, by running them_

Green in M19. `pnpm test` is the whole default suite; `multi-instance.integration.test.ts` is
excluded by its own config and covered by clause 15.

### 21. The main flow has been smoke-tested by hand — **not met**

`pnpm test:e2e` automates §19.1 end to end, and that is not what this clause asks for. A human has
not walked it in M19: CLAUDE.md rule 3 makes the infrastructure the user's to start, so the run is
theirs and no evidence of it exists here. Recorded as unmet until it does.

To close it: `/demo`, scenario **Normal flow**, whose steps name what to watch at each press.
