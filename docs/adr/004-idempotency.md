# 004. Idempotency by mutation id plus a request hash

Status: accepted
Date: 2026-08-28

## Context

An offline-first client retries. A lost HTTP response is indistinguishable, from the client's
side, from a request that never arrived, so every mutation will sometimes be sent twice — and a
POS that charges twice or cooks twice is worse than one that fails loudly.

## Decision

The client generates a `mutationId`. `processed_mutations` has that id as its primary key, and the
row is written **inside the same transaction** as the effect, so "the change happened" and "we
recorded that it happened" cannot come apart.

A repeat returns the stored result with `status: ALREADY_APPLIED` and applies nothing.

Each row also stores `request_hash`, a sha256 over canonical JSON of `(orderId, type, payload)`
with object keys sorted. If a `mutationId` arrives again with a **different** hash, that is a
client bug or an id collision, not a retry: the answer is `409 MUTATION_ID_REUSED` and the cached
result is never returned. Returning it would confirm an operation the server never performed.

Order creation goes through the same path (`CREATE_ORDER` with a client-generated `orderId` and
`baseVersion: 0`), so there is no unprotected write anywhere in the system.

Two races are handled explicitly. A duplicate that arrives while the first copy is still in flight
loses either on the `processed_mutations` primary key or on the versioned UPDATE; in both cases the
handler looks the mutation up afterwards and answers `ALREADY_APPLIED` rather than `CONFLICT` —
otherwise a client's own retry would halt its queue over a mutation that did apply.

## Consequences

The business effect happens exactly once under retries, duplicates and concurrency, and this is
tested (§21.2, §21.3, §21.15). The cost is a row per mutation forever — a table that grows with
traffic and will eventually need archiving — plus the discipline that clients must generate ids
and never reuse them.

## Alternatives considered

Deduplicating by `(terminalId, type, payload)` within a time window was rejected: two identical
legitimate operations (add another Cola) are indistinguishable from a retry. Storing only the id
without the hash was rejected because it turns an id collision into silent data loss.
