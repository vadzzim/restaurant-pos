# Known problems and open questions

> Not read at the start of a session. `PROGRESS.md` links here, and the *First command of the next
> session* block names the two or three entries that actually block the next milestone.
>
> Two kinds of entry live here:
>
> 1. **Accepted limits** — things that are deliberately this way, most of them worth saying out loud
>    in the interview. Do not "fix" one without checking the ADR it came from.
> 2. **The review backlog** — P2 and P3 findings from review rounds. Since 2026-08-30 a milestone
>    gets **one** review pass and fixes only P1s; everything below P1 is written here as a line and
>    swept in a dedicated pass every three or four milestones. See `CLAUDE.md`, *Review discipline*.

## Review backlog (P2 / P3, not yet fixed)

*Empty. The next review pass appends here instead of opening a second round.*

Format: `- **[MXX, PN]** one line — where, and what would prove it.`

## Accepted limits and open questions


- **`START_PREPARING` and `MARK_READY` conflict on a repeat rather than answering
  `ALREADY_APPLIED`.** This is deliberate (§8: out-of-order transitions conflict) and it is what
  makes §21.10 legible, but it means a kitchen display that lost a response and then *discarded*
  the pending command will be told `INVALID_STATUS_TRANSITION` if it presses again — technically
  right, and it reads like a failure. Worth saying out loud in the interview.
- **The kitchen commands from a lagging projection** and takes a conflict when it is behind
  (ADR 012). The projection is therefore load-bearing for writes, not only for display: a kitchen
  consumer that is down freezes the versions the rail commands at. M11's `/debug` is where that lag
  becomes a number.
- Scope grew across the reviews and nothing was cut, by explicit choice. Watch the usage budget.
- **A duplicate ticket can physically print, and nothing in this repository can prevent it**
  (§12.3, ADR 014). If the device emits the ticket and the worker dies before writing `PRINTED`, the
  retry prints it again. `ticket_hash` deduplicates the record, the `Idempotency-Key` deduplicates
  the request within the device's own memory, and the kitchen screen says so in those words.
- **The fake printer's idempotency ledger is in memory and holds 500 keys.** Restarting the API
  forgets every key, so a retry arriving afterwards prints a second ticket; so does a key evicted by
  the 501st print. Deliberate — a real device's dedup window is its own memory — and it means
  §21.14 proves a property of the endpoint, never of the paper.
- **`print_jobs.attempt_count` and BullMQ's `attemptsMade` can disagree**, on purpose. A BullMQ
  dashboard would show a different number from the one that decides anything.
- **`PRINT_STALE_MS` is coupled to `PRINT_BACKOFF_BASE_MS` and `PRINT_MAX_ATTEMPTS`**, and nothing
  enforces it. Set the staleness below the longest backoff a healthy retry can be waiting out and
  the sweep will enqueue jobs that are merely slow. The defaults leave a wide margin (60 s against a
  16 s worst case) and a check would need the sweep to know the queue's configuration.
- **The sweep skips `CANCELLED` tickets and the live path does not**, so an order cancelled a second
  after being sent to the kitchen can still print, while one cancelled before the sweep runs will
  not. The rule cannot be made symmetric without delaying every ticket.
- **The print worker is fleet-wide and single-device.** One queue, one fake printer, no
  per-restaurant routing, `concurrency` left at one. Two workers would race on the same
  `print_jobs` row and spend attempts twice as fast.
- **A ticket sent to the kitchen in the first milliseconds of the worker's life may not be
  enqueued.** `enqueue` refuses while the Redis client is not `ready`, and the alternative — waiting
  for readiness — costs the whole bound on every event during an outage. The connection is opened at
  boot, long before the consumer group has joined, so the window is theoretical; if it is ever hit,
  the sweep picks the ticket up within `PRINT_RECONCILE_MS`.
- **An abandoned enqueue may still land.** The timeout rejects the promise; it cannot unsend the
  command. The `jobId` is the ticket hash, so a late `add` is a no-op — but "the worker reported a
  failed enqueue" and "nothing was queued" are not the same statement, exactly as with the outbox's
  `sendWithinLease`.
- **Shutdown against a Redis that has gone quiet mid-connection is not covered by a test.** The
  never-reachable half is (`print-queue.test.ts`). Reproducing the other half needs a TCP proxy
  that swallows bytes, and the fault itself produces unhandled `Connection is closed.` rejections
  from ioredis, which would fail the suite for a reason unrelated to this code. The reasoning that
  it is bounded is in `build-log.md`, round 3.
- **A Redis outage is invisible until M11.** Nothing prints, the sweep logs a warning every
  `PRINT_RECONCILE_MS`, readiness stays green (ADR 014), and no screen says why.
- Infrastructure URLs intentionally have development defaults. M14 production images must require
  explicit values rather than inheriting localhost defaults.
- **Kafka is in the test path twice, and only twice.** `kafka-roundtrip.integration.test.ts` runs
  outbox row → producer → Redpanda → consumer group → projection for real, and M9's
  `consumer-redelivery.integration.test.ts` runs §21.13's offset window. Both are under
  `pnpm verify:integration`. Everything else still uses a fake transport or calls a handler
  directly, **no other test opens a socket**, and the realtime consumer's KafkaJS wiring is covered
  only by the structurally identical worker path.
- **A row can be reclaimed for ever and nothing stops it.** `reclaim_count` climbs, a warning is
  logged, and that is all: a poison event that kills the publisher process every time it is picked
  up would loop indefinitely. Dead-lettering on a reclaim ceiling was rejected on purpose — a
  rolling restart would then dead-letter healthy events (ADR 010) — so the answer is a human
  reading M11's `/debug`, not a counter.
- **The publish delay is per send, so a large one shrinks the batch.** With `publish_delay_ms` set
  high, the lease guard stops each pass after a row or two and the rest of the claim is released and
  re-claimed next pass. That is correct and it is also wasteful; it only happens while a human has
  deliberately slowed the publisher down for a demo. The switch refuses a delay large enough to stop
  publication altogether, and the worker warns when a pass spends its lease publishing nothing — but
  a row written straight into `outbox_controls` by SQL bypasses the first of those.
- **A send abandoned at the end of its lease may still reach the broker.** KafkaJS cannot cancel a
  request; ending the session closes the socket and that is all. The residue is a duplicate of an
  event already on the topic, which both consumers deduplicate — but "the publisher gave up on it"
  and "the broker never got it" are not the same statement, and `/debug` will not be able to tell
  them apart either.
- **A pause is observed within one `OUTBOX_POLL_MS`, not instantly**, and the worker keeps polling
  the control row while paused. A pause thrown while a row is serving its `publish_delay_ms` is seen
  when that delay ends, which can be seconds. Both are the cost of the control living in PostgreSQL
  rather than in the process that flips it.
- **`outbox_controls` is fleet-wide.** Two workers cannot be paused independently, and nothing
  records *who* paused the publisher or when — only `updated_at`. §18 asks for a demo switch, not an
  audit trail.
- **`/api/debug/dependencies` reports no consumer lag.** It needs a Kafka admin describing group
  offsets and belongs with §20's other counters in M11. The report is also a snapshot, not a
  monitor: it cannot say how long a dependency has been down, and the outbox backlog age is the
  only duration in it.
- **A degraded API keeps receiving traffic, and that is the design.** Readiness green with Redpanda
  down means clients reach an instance whose screens do not update live; §13's reconnect-and-refetch
  and M13's polling transport are the mitigation, not the probe (ADR 011).
- **The worker no longer fails fast.** A misconfigured broker address produces a warning every five
  seconds rather than an exit, which is easier to miss than a crash. The heartbeat carries
  `brokerConnected` for exactly that reason. Two supervision loops now exist, one per process,
  deliberately not shared (ADR 011).
- **`GET /api/config` is the M4 stub of an M13 feature.** It reads `feature_flags` directly: no
  Redis cache, no percentage rollout, and the client fetches it once at bootstrap instead of every
  15 s. With the flag off the screens are correct but receive no live updates, because the polling
  transport — the flag's other, complete branch — is M13's.
- **`GET /api/kitchen/tickets` is not in §17's endpoint list**; it was added because the kitchen
  screen must read the projection. `GET /api/restaurants/:restaurantId/orders` is still unbuilt.
- **The socket has no authentication.** Any browser can subscribe to any restaurant's rooms.
  Deliberate for a demo with no auth anywhere, and worth saying out loud.
- **The projection wait is bounded and can still lose.** The kitchen screen shows `PROJECTION LAG`
  and the ticket appears only when a later event lands or the page is reloaded.
- **One named residue in `expectationFor`:** a cancellation of an order that *was* sent to the
  kitchen, but whose ticket this screen has not seen yet, gets no projection wait — the client
  cannot tell it apart from a cancellation of an `OPEN` order. Bounded by the next event or a
  reload. Closing it would mean putting "did this order ever reach the kitchen" into the
  `OrderCancelled` payload: a display concern in a domain event, which is why it was not done.
- **The kitchen still has one slot per order, with its own Retry and Discard.** It already halts at
  the aggregate, which is what §14.1 asks for, but it has no queue and no rebase: a kitchen command
  that conflicts is simply reported and the operator presses again. Deliberate — §21.8 is about the
  POS queue, and giving the kitchen the same machinery would have doubled the milestone.
- **The engine syncs only the terminal whose screen is up.** A queue for POS-1 does not drain while
  the tab is showing POS-2. One screen per terminal is the assumption the whole client already
  makes; worth saying out loud, because a real fleet would want a background worker per device.
- **A halted order the screen has left is listed, and can be returned to, and that is all.** New
  commands are refused while the order *on screen* is halted, so a halt is resolved rather than
  walked away from — but nothing stops the operator leaving an order *before* it conflicts and
  finding it halted later. `haltedElsewhere` and `focusOrder` exist for exactly that.
- **The optimistic projection can differ from what the server produces.** It prices items from the
  menu, not from the order, and the item arithmetic is a second implementation of the server's SQL.
  Every canonical answer replaces it, so the divergence is bounded by one round trip — but a demo
  that adds an item whose price changed server-side will visibly correct itself.
- **The client database is shared by every tab on the origin.** Two POS tabs on the same terminal
  id write the same pointer and the same pending slot. The in-memory slot already assumed one
  screen per terminal, so nothing changed — but a demo that opens two tabs on `/pos/pos-1` would
  find it.
- **A cached snapshot is briefly stale after a reload**, between hydration and the first refetch.
  That is what the cache is for, and it is visibly wrong for a moment against a server that moved
  on while the tab was closed.
- **§18's eleven controls are in three places, and none of them is `/debug`.** `Simulate Offline` is
  on the POS header, `Pause Outbox Publisher` and `Delay Outbox Publishing` are behind
  `pnpm -F @pos/worker outbox`, and `Fail Printer` is behind `pnpm -F @pos/worker printer`. M12
  gathers all of them into one page; the remaining seven do not exist yet.
- **The client has no backoff and no automatic retry.** By design (ADR 002): the engine runs on
  explicit triggers so the demo is deterministic. A server that is down and a socket that never
  reconnects therefore leave the queue sitting until the operator presses **Sync now**.
- **A poison message on the realtime topic is lost to that consumer group permanently.** A
  consumer-side dead-letter topic is the real answer and is not built. The publish side already
  dead-letters through `outbox_events`.
- **The concurrent tests assert invariants, they do not force the interleaving.** §21.1 and §21.10
  cannot fail falsely, but neither is a proof that the unguarded code was broken — the reasoning in
  `build-log.md` is.
- `outbox_events` and `processed_mutations` grow without bound. Archiving is out of scope.

