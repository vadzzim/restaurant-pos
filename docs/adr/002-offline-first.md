# 002. Offline-first: a derived projection, a projected baseVersion, and no automatic resolution

Status: accepted
Date: 2026-08-28

## Context

§14 asks for three things at once, and they interact: the UI updates optimistically and never waits
for the server; a reload must not lose unsynced local data; and on reconnect the client syncs its
pending mutations sequentially per aggregate. §14.1 then adds the rule the original prompts left
undefined — a `409` halts the queue for that order, blocks everything queued behind it, and waits
for a human.

M7 built the storage and left a single unresolved mutation per terminal. M8 has to turn that into a
queue, and the queue is the only path to the server, which makes three questions load-bearing.

## Decision

### 1. The optimistic view is derived on read, never stored

The screen renders `projectQueue(canonicalSnapshot, queuedMutationsForThatOrder)`. The `orders`
table keeps what ADR 013 says it keeps: the last canonical snapshot the server gave us.

The obvious alternative — write the predicted order into `orders` as each mutation is queued —
creates the worst pair of writes in the milestone. The prediction and the queue row are two records
of one intent, and a crash between them leaves either a predicted order with nothing that will ever
sync it, or a queue row whose effect the screen has forgotten. Folding on read has neither
problem: the projection is a pure function of two persisted things, so a reload reproduces it
exactly, and there is only ever one write.

It also keeps the cache honest. A table documented as canonical, holding a guess, is a trap for the
next milestone that reads it.

**The cost, accepted:** the client restates the item arithmetic the server does in SQL. That
duplication is bounded — the _rules_ are `decide()`'s, imported from `@pos/domain`, the same
function the API calls, so a mutation §8 would refuse is not drawn as having applied. Only the
arithmetic is restated, because the server's version is an atomic
`insert … on conflict do update set quantity = quantity + excluded.quantity`, and lifting it into
JavaScript to share it would replace an upsert with a read-modify-write on the write path. The
projection is a prediction, and every canonical answer replaces it.

### 2. `baseVersion` is stamped from the projected version, not the canonical one

A mutation queued behind another is stamped at the version the one in front of it will produce:
`CREATE_ORDER` at 0 projects v1, so the `ADD_ITEM` behind it is stamped at 1.

This is what makes §19.2 work — four mutations queued offline all apply on reconnect, in order,
with nothing re-stamped — and it is sound because while the device is offline this client is the
only writer, so it can predict the versions the server will produce. When that assumption is false,
which is exactly §19.3, the first mutation conflicts and §14.1 takes over. That is the correct
answer, not a failure of the scheme.

The rejected alternative was to re-stamp each mutation from the canonical version as it is sent.
It would make §19.2 pass too, and it would silently rebase every queued mutation onto whatever the
server currently holds — last-write-wins, applied without anyone deciding to.

### 3. Nothing resolves itself, and a rebase is the one place a `mutationId` is regenerated

A conflicted mutation is `CONFLICT`, everything queued behind it for the same order is `BLOCKED`
and is never sent, other orders keep syncing, and the POS shows the canonical state beside the
local intent with two buttons. Silent auto-rebase is last-write-wins wearing a disguise.

**Discard** deletes the halted group in one transaction. **Rebase** re-issues them one at a time —
A with a new `mutationId` at the version the server currently holds, and only once A applies is B
re-issued at the version A produced. Not a batch re-stamp, because each successful mutation
advances the version; any step may conflict again, and a rebase onto a cancelled order fails on the
first attempt with the rest still blocked.

Everywhere else — a retry, a reconnect, a hydration, the engine's own re-send — reuses the stored
id so §9 answers `ALREADY_APPLIED`. A rebase is a genuinely different mutation, so re-sending the
old id there would be answered `ALREADY_APPLIED` for something that never applied.

`MUTATION_ID_REUSED` and `REJECTED` halt the aggregate the same way. Neither is retryable, so
leaving the row `PENDING` would spin; and for a reused id, rebase is exactly the right resolution,
because it mints the fresh id the server objected to the absence of.

### 4. The pointer is written by the screen, the cache by anyone

`syncMetadata.currentOrderId` answers "which order is this device on", so only the actions that
move the screen write it — `createOrder`, `focusOrder`, `clearCurrentOrder`, and `saveOrder` on
behalf of a caller that has just read the order on screen. The sync engine caches through
`cacheOrder`, which writes the snapshot and leaves the pointer alone.

This is the correction the first review round of M8 forced. The engine drains every order the
terminal queued, so it answers for orders the screen left long ago; a cache write that also moved
the pointer sent the next reload to the order the operator had finished and stranded the one they
were ringing up. The rule "the pointer moves even when the snapshot is refused" is still right, and
its scope is a pair of answers for the _same_ order — not any answer at all.

### 5. The send gate is derived, not read

A group of queued mutations may be sent only when **every** row in it is `PENDING` or `SYNCING`.
The `CONFLICT`/`BLOCKED` labels are written in one transaction, but the gate does not depend on
that transaction having completed: a crash mid-halt, or a rebase that stopped part-way, both leave
a group the derivation still refuses. The labels are what the operator reads; the derivation is
what the engine obeys.

### 6. `SYNCING` is not durable state

It means "this tab, right now". A crash between marking a row and its request leaving would
otherwise leave a mutation the next pass believes somebody else is attempting, so hydration
rewrites every `SYNCING` row for that terminal back to `PENDING` before the first pass. Re-sending
a mutation that did apply is safe — that is what the stable `mutationId` is for.

### 7. `Simulate Offline` intercepts in the API client, per terminal, on reads as well as writes

Not in the stores, which would grow a second code path for a demo control, and not via DevTools,
which §14 rules out because the demo has to be deterministic. Reads are cut off too: §19.3 depends
on POS-1 not learning that POS-2 cancelled the order, because a refresh nobody asked for would
re-validate the versions its queue is stamped with and the conflict the scenario exists to show
would never happen.

## Consequences

- The client has one write path. Online, the engine drains a row within a few hundred milliseconds;
  offline the same row waits. The offline demo exercises the machinery the normal flow uses.
- The engine has no timers. It runs on explicit triggers — an enqueue, hydration, a socket
  connecting, the browser coming back online, the offline toggle flipping, and a **Sync now**
  button — and a pass that hits a transport error stops and waits. A retry loop would make the
  demo non-deterministic and would hide the state it exists to show.
- A device whose IndexedDB refuses writes loses offline-first but not the order: `savePending`
  reports that the row is not there and the mutation is sent directly through the same code a pass
  would have used. M7's rule — a storage failure never breaks a command — survives the queue
  becoming the only path.
- The halt is per aggregate and the screen is per order, so the two can come apart. A halted order
  the screen has left is listed with a way back to it; a queue nobody can reach is worse than a
  queue that stops.
