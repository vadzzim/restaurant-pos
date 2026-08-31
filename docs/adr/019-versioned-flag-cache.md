# 019. The flag cache is versioned, so a late fill cannot resurrect a toggle

Status: accepted
Date: 2026-08-31

## Context

§15 promises that a flag toggle is **fleet-wide and immediate**: the write goes to `feature_flags`,
the API invalidates the Redis cache, and the next `/api/config` on any instance resolves from the
table. ADR 008 rests on that sentence — the demo turns push off and both terminals fall back
within one 15-second poll.

Plain cache-aside does not keep it. The read is _miss → read the table → fill the cache_, and the
write is _commit → invalidate_. Those interleave:

1. A request misses and reads the rows. The flag is on.
2. `POST /api/debug/flags/:key` commits `enabled = false` and deletes the cache key.
3. The request from step 1 fills the cache with the rows from step 1.

The cache now holds the pre-toggle state for a whole `FLAG_CACHE_TTL_MS`, and every terminal in the
fleet keeps its old transport for one more interval. Deleting on invalidation does not help: the
fill happens _after_ the delete. Found by the Codex review of M13 and carried as a P2 until M22.

## Decision

**The cached value carries the version it was filled at, and a separate counter is the version.**

- `config:feature-flags:version` — an integer with no expiry. `invalidate()` is one `INCR` and
  touches nothing else.
- `config:feature-flags` — `{ version, rows }` with `PX`. A read is one `MGET` of both keys, and a
  payload whose `version` does not equal the counter **reads as a miss**.

So the step-3 fill still lands, and is never read: the counter moved in step 2, the payload it
wrote is stamped with the old one, and the next request goes to the table. A stale fill is not
merely refused — it is unreachable.

The port carries this, not the Redis client: `read()` answers `{ hit: true, rows }` or
`{ hit: false, version }`, and `write(rows, version)` takes the version back. `loadFlags` threads an
opaque string from the miss to the fill and never interprets it, so `buildApp()` without a cache is
unchanged (ADR 006) and every `fastify.inject` test stays free of infrastructure.

## Consequences

- **No Lua, no `WATCH`/`MULTI`, no lock.** One `MGET`, one `SET`, one `INCR`, each a single
  round trip. Two instances toggling at once both increment, so neither one's in-flight fill can
  become the cached answer — the property the old `DEL` was reaching for and did not have.
- **The TTL stops being the correctness bound and becomes a memory bound.** Only a version that
  moved makes a toggle visible; the expiry is there so a key cannot outlive the row it copied.
- **A cache read that threw does not fill.** It observed no version, so it has nothing to present.
  Failing closed is right for a race about a fill that should not have happened.
- **A stampede of concurrent misses is still allowed.** They all read the same rows and write the
  same value; the defect was a _stale_ fill, not a repeated one, and single-flight would be an
  abstraction against a problem nobody has.
- The version key is never deleted. It is one integer, and a version that vanished while a payload
  survived would make that payload readable again.

Proved by `apps/api/test/flags.test.ts`, which stalls a fill across a real toggle and asserts the
next poll sees the new state; reverting to an unconditional `SET` reddens it.
