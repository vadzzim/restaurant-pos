# 015. The failure simulator: one endpoint pair, and seven switches that stay in the tab

Status: accepted
Date: 2026-08-30

## Context

§18 wants eleven controls on `/debug`. M11 built that page read-only and §17 lists one debug write
(M13's flag toggle), so the failure mode was five new endpoints for four switches. The eleven divide
by **where the switch lives**, not by what they break.

## Decision

**One endpoint pair for the four server-side controls**, shaped like M13's:
`GET /api/debug/simulator` and `POST /api/debug/simulator/:control`, the control a zod enum so an
unknown one is a 400 listing the real ones. The `POST` returns the new state, so a button needs no
second round trip. `read`/`setOutboxControls` moved into `@pos/db` when `/debug` became their second
writer, beside `printer-controls.ts`.

**`replay-last-event` resets an outbox row; the API grows no Kafka producer.** The publisher is the
only thing that writes to the topic (ADR 005, 010), so the newest published row is put back to
claimable and sent again for the consumers to deduplicate. A producer here would publish behind the
outbox's back, and §19.6 is a claim about that very path.

**The other seven never reach the API.** A duplicate send, a reused id, a tampered `baseVersion`, a
terminal that refuses to call, a socket a screen declines to open — each is something a _client_
does, and an endpoint for any would mean the server holding per-tab state it cannot expire. Module
refs in `api/simulator-arms.ts`, beside the offline switch M8 put there.

## Consequences

Two lifetimes, visible rather than implied: a fleet-wide row surviving a worker restart against a ref
dying with the tab. `/debug` groups the buttons by exactly that.

**Client controls do not cross tabs.** Arm on `/debug`, walk to `/pos/pos-1`: fine. A POS in a second
tab sees nothing — consistent with one screen per terminal (ADR 013), and said on the panel.

**`/debug` is now a write surface with no authentication.** `Force Polling Transport` only reaches
the `PUSH DISABLED` branch, which has no live updates until M13.

## Alternatives considered

An endpoint per control: four times the surface, no extra expressiveness. Persisting the client
switches across tabs: a broadcast mechanism nothing asks for.
