# 011. Health is split three ways, and readiness ignores the broker

Status: accepted
Date: 2026-08-28

## Context

This system has three infrastructural dependencies and they are not equally hard. PostgreSQL holds
the orders: without it nothing can be written or read. Redis fans Socket.IO broadcasts across API
instances: without it an instance still reaches its own sockets. Redpanda carries the domain events:
without it the outbox fills up and screens stop updating live — and **orders are still accepted**,
which is the single sentence the whole architecture exists to make true (§10, ADR 005).

A health endpoint that cannot express that difference destroys it. One `/health` returning
`{ok:true}` when everything is reachable and `{ok:false}` otherwise would mark the API unready on a
broker outage; an orchestrator would pull it out of the load balancer, and a working POS would go
offline for a fault the design specifically survives. The failure the outbox exists to prevent would
then be caused by the probe that was supposed to detect it.

Two related questions arrive with it. What does the **worker** do when the broker is down — it
exited, while the API retried in the background. And where does the informational view live, given
that §16's `/debug` page and §20's counters are M11's work, not M6's.

## Decision

**Health is three endpoints, and each answers exactly one question (§17).**

- `/api/health/live` — is the process running? It touches no dependency at all. A liveness probe
  that consulted the database would restart a healthy API because the database blinked, turning one
  outage into two.
- `/api/health/ready` — can _this instance_ accept a write? It checks the **hard** dependencies,
  which today means PostgreSQL and nothing else, and answers **503** when it cannot. Redis and
  Redpanda are not consulted, by rule and not by omission.
- `/api/debug/dependencies` — informational, for a human: every dependency with its `kind`
  (`hard`/`soft`), its status, its latency, and one sentence saying what its absence costs. Plus the
  outbox backlog, because "Redpanda is down" and "and 47 events are waiting" are one thought.

The dependency report has **three** overall states, not two: `ok`, `degraded` (only soft
dependencies down — live updates suffer, writes do not) and `unavailable` (a hard one is down).
`degraded` is the state the demo is _for_.

Each probe carries its own timeout, so an unreachable dependency cannot hang the report that exists
to explain it. Probe implementations are injected at composition time: `buildApp()` stays routes-only
(ADR 006) and defaults to the PostgreSQL probe alone, so an injected test needs no infrastructure —
and registration fails loudly if the list contains no hard dependency, because a readiness probe with
nothing to check would answer 200 forever.

**The worker supervises its broker connection instead of exiting, and does not run the publisher
while disconnected.** The API's consumer is supervised because the API has other work to do without
a broker. The worker seems not to — both its jobs need Redpanda — so "let it run and let publishes
fail" looks equivalent. It is not: **each failed publish increments `attempt_count`**, and at the
current settings an outage of a few minutes would exhaust `OUTBOX_MAX_ATTEMPTS` and **dead-letter
events that were never bad**. Dead-lettering must keep meaning _this event is bad_; M9 and §18 are
built on that meaning. So the worker stays alive, retries the connection with backoff, and idles the
publisher loop whenever there is no live session to publish through. The backlog waits untouched and
drains on recovery.

**The session dies on a failed send, and the liveness flag belongs to the session.** KafkaJS emits
the producer's `DISCONNECT` instrumentation event for an explicit disconnect, not for the broker
vanishing under an open socket — which is the one case all of this exists for, so that event alone
would leave the publisher running through exactly the outage it is meant to sit out. A send failure
is the signal the worker is guaranteed to receive, so it is the one the session hangs on, and
`publishOnce` breaks out of the rest of its batch rather than charging every remaining row an
attempt for the same outage.

The flag that says so lives on the `BrokerConnection`, not on the supervisor, and is flipped
synchronously before the error is rethrown. `broker.current()` still returns a session while its
teardown is in flight — and later returns its replacement — so a guard written against the
supervisor would read "alive" for the whole window it exists to close, and then answer for a
different session than the one the publisher is holding.

**A record the broker rejected does not end the session, and the list of those is a whitelist.**
`MESSAGE_TOO_LARGE` and its kind say the connection carried the request and brought back a refusal
about _this row_; tearing the session down for one would take the kitchen consumer with it and
abandon every unrelated row of the batch, once per retry, until the poison row dead-lettered. That
is the mirror of the argument above: `attempt_count` must keep meaning _this event is bad_, and a
bad event must not be allowed to mean _the broker is gone_.

The condition is `RECORD_REJECTIONS`, an explicit set, and **not** "is it a protocol error at all".
`TOPIC_AUTHORIZATION_FAILED` is one too, and it means every row of the batch will fail — reading it
as a record rejection would charge an attempt to each of them and dead-letter healthy events, which
is what this whole section exists to prevent. So anything not on the list ends the session, and the
asymmetry is the reason: being wrong about an unfamiliar code costs one reconnect, being wrong the
other way costs an order's event.

## Consequences

- A broker outage is now demonstrable rather than asserted: stop Redpanda, `/api/health/ready` stays
  green, mutations still return `APPLIED`, `/api/debug/dependencies` says `degraded` and names the
  growing backlog. That is scenario §19.7 with a number attached.
- An orchestrator can use these endpoints as they are: `live` for the restart decision, `ready` for
  the traffic decision. M14's production images inherit that without further work.
- **A degraded instance keeps receiving traffic, and that is the point and the cost.** Readiness
  green with Redpanda down means clients connect to an API whose screens do not update live. The
  mitigation is not in the probe: it is §13's reconnect-and-refetch and M13's polling transport.
- **The report is a snapshot, not a monitor.** It probes when asked, so it cannot say how long a
  dependency has been down; the outbox backlog age is the only duration in it. Consumer lag is
  absent entirely — it needs a Kafka admin describing group offsets and belongs with M11's counters.
- The worker no longer fails fast. A misconfigured broker address now produces a warning every five
  seconds instead of an immediate exit, which is quieter than a crash and easier to miss. The
  heartbeat carries `brokerConnected` for exactly that reason.
- **One attempt is still spent at the moment the broker drops**, by the event whose send discovers
  it. That is the honest reading of "we tried and it did not work", and the outbox's own
  `next_attempt_at` backoff paces everything after it. The rows abandoned behind it keep their lease
  for `OUTBOX_LEASE_MS`, so a recovery inside that window waits the lease out before republishing;
  releasing the claim eagerly belongs with M9's lease hardening.
- **A probe timeout gives up on a check, it cannot cancel one.** Each check is therefore bounded at
  its own client — the pool's `connectionTimeoutMillis`, the probe broker's disabled retries — or a
  long outage leaves one abandoned operation behind per health request. Redis needs **two** sources
  rather than one: the adapter client's `status` answers "are broadcasts connected?", and a third
  client with `enableOfflineQueue: false` and a `commandTimeout` carries the actual `PING`, because
  a half-open socket leaves ioredis reporting `ready` with nothing moving. That client is discarded
  and reopened whenever a probe fails: the timeout rejects the promise, but only closing the socket
  takes the command out of ioredis's ordered response queue.
- Two supervision loops now exist, one in each process, deliberately not shared. They differ in
  logger type, in what a session owns and in why they exist; their only common home would be a new
  runtime package, which is more structure than forty lines of loop earns.

## Alternatives considered

**One `/health` endpoint.** Rejected: it forces one answer to two different questions — restart me
versus stop sending me traffic — and the only way to keep a POS working through a broker outage
would be to make that endpoint lie about the broker.

**Readiness checks every dependency.** Rejected outright; it contradicts §17 and would take a
working POS offline on a broker outage.

**Readiness checks PostgreSQL and Redis.** Tempting, because a broadcast that reaches only one
instance is a real degradation. Rejected: the degradation is invisible to a client that follows §13
(refetch the canonical snapshot on reconnect), and paying for it with unreadiness would take writes
offline to protect a hint.

**The worker exits when the broker is down, and something restarts it.** Rejected: the dev Compose
services declare no restart policy, so the process would simply be gone and the demo's recovery
story would need a human to notice. It is also the loudest possible response to a condition the
system is designed to ride out.

**The worker runs the publisher regardless and lets the outbox retry machinery absorb the outage.**
Rejected: this is the option that silently destroys data quality. It converts a broker outage into a
pile of dead-lettered events, and the dead-letter state is load-bearing for M9 and §18.
