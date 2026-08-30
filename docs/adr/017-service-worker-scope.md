# 017. The service worker caches the shell, on an allow-list, and never waits

Status: accepted
Date: 2026-08-30

## Context

The client has been offline-first since M8: Dexie holds the queue and the last snapshot (ADR 013).
What it could not survive was a **reload** with no network — index.html and the bundle come from the
server, so the tab never reached the code that knows how to be offline. M17 closes that, on a
codebase where a caching mistake is not a slow page but a wrong one.

## Decision

**The worker owns the shell, never data.** Two caches over one dataset drift, and the one that would
win has no conflict rules in it.

**An allow-list, in one pure module.** `src/sw/cache-policy.ts` maps a request to `shell`, `asset`,
`menu` or `passthrough`; anything unnamed is `passthrough`, which means the handler does not call
`respondWith` at all, so the request behaves as if no worker were installed. A deny-list is one new
endpoint away from caching a mutation. Non-`GET` is decided before any path is read. The only API
response cached is `GET /api/menu`, stale-while-revalidate. `GET /api/orders/:id` never is: a stale
snapshot does not look like an error, it looks like the server's truth, and the conflict machinery
would never fire. The module has no `fetch`, no `caches`, no DOM and no imports, so its tests run in
Node over every endpoint in `src/api/client.ts`.

**`skipWaiting` + `clientsClaim`, and one guarded reload on `controllerchange`,** rather than an
update prompt. The worst failure of a demo is an interviewer reloading into last week's bundle, and
no unsaved in-memory state is lost — the queue is on disk. Safe only because `router.ts` imports all
four views statically, so there are no lazy chunks a claimed page could ask for after `activate`
dropped the old cache. **Introducing code splitting means revisiting this.**

**Registration only under `import.meta.env.PROD`:** in dev a worker intercepting module requests
makes HMR lie, which reads as a compiler bug.

**No build-time precache manifest.** The document is precached on install; hashed assets are cached
as the installing page fetches them. A generated asset list would buy a case nobody has and rot when
the output layout changes. **One cache per build**; `activate` deletes every other.

## Consequences

Built separately (`vite/service-worker-plugin.ts`) as a classic `iife` at a stable `/sw.js`: an app
entry would be an ES module sharing code-split chunks, needing `{ type: 'module' }`. It gets
`tsconfig.sw.json`, because `WebWorker` and `DOM` declare the same names differently — hence also
the single `self as unknown as ServiceWorkerGlobalScope` cast. Nothing in `src/sw/` may import from
the rest of `src/`.
