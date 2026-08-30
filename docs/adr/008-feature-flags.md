# 008. The flag gates the transport, not the write path

Status: accepted
Date: 2026-08-30

## Context

An earlier draft put the single mutation path behind a flag, as the headline example of a safe
rollout. A review pointed out that the only write path in the system, switched off, is not a
rollout — it is an outage with a nicer name. The requirement underneath was real: show a change
reaching some restaurants before others, and reversed without a deploy. That needs a subject with
**two complete implementations**.

## Decision

The one flag is `realtime.websocket_push`, and it chooses a **transport**: WebSocket push (§13) or
polling the snapshot. Turning it off costs latency and nothing else — the client already treated a
socket event as a hint to refetch, never as data, so the polling branch reuses the same canonical
read.

**Resolution is `enabled && bucket < rolloutPercent`**, `bucket` being an FNV-1a hash of
`${key}:${restaurantId}` modulo 100: per restaurant, not per request, so a terminal does not change
transport between two polls. The key is in the hash so a second flag at 10 % does not land on the
same restaurants as the first.

**Resolved on the server** (`GET /api/config`), never in the browser — two terminals of one
restaurant applying the rule themselves could disagree about it. **An open client learns about a
change by polling** that endpoint every `CONFIG_POLL_MS`: a WebSocket control event is circular, and
a forced reload costs more than fifteen seconds of delay.

## Consequences

- The write path is never gated: everything §5–§9 guarantees holds on both transports, which is
  why the flag is safe to flip in front of an audience.
- Redis caches the rows and a write invalidates the key, so a toggle is fleet-wide and immediate
  rather than bounded by a TTL. Redis stays soft: a cache failure falls through to PostgreSQL.
- Presence needed a second path (`POST /api/presence`), because a terminal on the polling transport
  holds no socket to heartbeat over and would otherwise vanish from `/debug`.
- A percentage between the two seeded buckets — 1 and 24 — puts `POS-1` and `POS-3` on different
  transports at once. That number is a fact about the hash, and a test pins both buckets.
