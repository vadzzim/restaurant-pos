# 013. Client persistence: three Dexie tables, and who may write them

Status: accepted
Date: 2026-08-28

## Context

§14 requires that a page reload not lose unsynced local data, and names the storage: `orders`,
`pendingMutations` and `syncMetadata` in IndexedDB via Dexie. M8 will build a sync engine on top of
that queue, including §14.1's halt-on-conflict.

Two things about the client made this more than a schema.

First, the two kinds of state are not equally important, and treating them the same would be a
mistake in both directions. The order snapshot is a copy of something the server owns and refetches
on every startup and every reconnect (§13). A pending mutation is the opposite: it is a fact the
server may not know, and the only thing that can resolve it under §9 is the `mutationId` the client
generated. Losing a snapshot costs a repaint. Losing a `mutationId` costs either an order that was
never placed or a duplicate of one that was.

Second, three of the four review findings in M4 were the same bug: **client state that outlives the
screen which created it, with no rule about who may write it.** The fixes gave each piece an owner —
`adopt` refuses a snapshot older than the one held, `refetch` re-checks that its order is still
current, `pendingByTerminal` is keyed by terminal, `connection.start`/`stop` claim a generation.
Persistence adds a writer that begins before the screen is ready and finishes after it may have
moved on, which is precisely the shape those bugs had.

## Decision

Three tables in one Dexie database, at schema version 1, with only the indexes something asks for.

**`orders` is a cache and is never authoritative.** Every screen hydrates it and then refetches. Its
one job is that a reload with the network down still shows the operator the order in front of them.
It is pruned: a row no terminal points at and no pending mutation names is deleted at hydration.

**`pendingMutations` is the durable fact**, keyed by `mutationId`, which is **never regenerated**.
It carries the whole §14 status union so M7 and M8 agree on the schema, but M7 writes only
`SYNCING` — set before the request goes out — and `PENDING`, set back when no answer arrives. The
POS and the kitchen share this one table, because M8 syncs one queue: two tables would mean two
sync engines and two places for §14.1's halt to live.

**`syncMetadata` is per terminal**, because the terminal is what survives a reload; the tab, the
route and the Pinia store do not. In M7 it holds one pointer: which order this device is working
on.

**Displaying and caching are separate, and the cache is keyed by the terminal that asked.** `adopt`
installs a snapshot on screen and writes nothing; the two callers that obtained a snapshot from the
server — `send` and `refetch` — are the ones that cache it. Only they know which terminal the
question was asked on behalf of, which is not always the terminal on screen: an answer can arrive
after the operator has walked to another till, and it still belongs to the one that sent it.

**A pending row is deleted only after the answer that settles it is durable.** The two writes are
not atomic. Deleting first leaves a crash window in which a `CREATE_ORDER` has lost its snapshot,
its `orderId` and its `mutationId` at once — and because creation clears the pointer before sending,
the reload shows an empty till and the operator rings the order up a second time. In the other
order the worst case is a row that outlived its answer, which Retry resolves as `ALREADY_APPLIED`.

**Hydration goes through the existing owners and re-checks its claim after every await.** It calls
`adopt` rather than assigning, so the monotonic-version rule still holds; it additionally refuses to
install anything if the store already holds an order, because `adopt` accepts a _different_ order
unconditionally and cannot tell a hydration from a `CREATE_ORDER` response; it fills a pending slot
only if that slot is empty; and it writes nothing at all if the screen it was hydrating for is gone.
That last claim is a **generation**, not the terminal id: the id outlives the screen, so a view that
unmounts and is re-entered on the same terminal would let the departed screen's read write into its
successor. The kitchen's read is filtered by `restaurantId` as well as by terminal, because every
kitchen display shares one terminal id across every restaurant.

**Hydration ends with a canonical read, and that read is part of hydration rather than of the
view.** The cache is never authoritative, so leaving the refresh to the caller means it happens only
on the paths that remember it — and the socket's `onConnected` refetch does not run at all when
`realtime.websocket_push` is off or `GET /api/config` fails, which would leave a stale order on
screen for as long as the tab stayed open.

**A storage failure is reported, never thrown.** Each repository call resolves with a neutral value
and records the failure in one exported ref, shown as a `NOT DURABLE` badge. The ref is not cleared
by a later success.

## Consequences

- A reload keeps the order and, more importantly, keeps the identity of a mutation whose answer
  never came. Retry still means "the same mutation", so §9 answers `ALREADY_APPLIED`.
- M8 inherits a queue with a stable schema and a status vocabulary already in place, and does not
  have to migrate rows written by M7.
- Every hydration path is a checked writer, so the M4 class of bug does not return through the door
  this milestone opened.
- **The cache can be stale and briefly is.** Between hydration and the first refetch the screen
  shows what the device last knew. That is the point of it, and it is visibly wrong for a moment
  after a reload against a server that has moved on.
- **Nothing is optimistic yet.** §14 also says the UI updates optimistically and never waits for
  the server; that sentence needs the queue, so the screens still show the server's canonical
  answer. This ADR does not claim otherwise.
- **The database is shared by every tab on the origin.** Two POS tabs on the same terminal id write
  the same pointer and the same pending slot. Today the in-memory slot already assumes one screen
  per terminal, so this changes nothing; if the demo ever wants two tabs on one terminal, this is
  where it breaks.
- Persistence adds two awaits to the path of every command. On IndexedDB that is sub-millisecond
  and it buys the ordering §14 requires — durable before attempted, and settled before forgotten.
- **The crash windows are ordered, not closed.** Two IndexedDB writes cannot be made atomic across
  a tab that dies between them, so the design chooses which side of each window to fail on: a row
  that outlived its answer over an answer that outlived its row, and a stale cache over no cache.
  Both survivable states are ones Retry or a refetch resolves.
- **A failed write is not retried.** The badge says the device is no longer durable; it does not
  repair it. Repair would mean a write-ahead queue for the queue, which is not worth building for
  a failure mode whose honest answer is "use a different device".

## Alternatives considered

- **A Pinia persistence plugin.** Rejected: it serialises whole-store state to `localStorage`.
  That is not IndexedDB, not selective, and not the three tables §14 and M8 need — and it would
  persist derived and transient fields (`inFlight`, `lastError`, `lagging`) whose restoration is
  meaningless or actively wrong.
- **`localStorage` directly.** Synchronous, string-only, ~5 MB, and no indexes. The queue needs to
  be read in creation order and filtered by aggregate, terminal and restaurant.
- **Persisting the order snapshot only, and keeping the pending mutation in memory.** This is the
  inversion of the actual risk: the snapshot is recoverable from the server and the `mutationId`
  is not.
- **A separate table for kitchen commands.** Rejected: M8 syncs one queue, and §14.1's halt is one
  rule. Two tables would duplicate both.
- **Regenerating `mutationId` on hydration** — never seriously considered, and named here because
  it is the single change to this milestone that would lose money silently.
- **Letting storage failures reject into the command path.** Rejected: it converts a durability
  problem into a lost mutation, which is the exact failure the storage exists to prevent.
