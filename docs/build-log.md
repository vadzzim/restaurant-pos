# Build log

Significant issues only: what broke, the root cause, and the fix. One short paragraph each.
Trivial typos are not recorded.

## M0 — scaffolding

Nothing broke. No code yet.

## M1 — monorepo and infrastructure

The registry's current TypeScript 7 release exceeded `typescript-eslint`'s supported peer range,
so the workspace was pinned to the current TypeScript 6 release. TypeScript 6 also deprecated
`baseUrl`; path aliases now use explicit relative targets and need no compatibility suppression.

Review caught that the optional Compose app profile relied on locally prebuilt shared packages,
used a localhost API proxy inside the web container, required an ignored `.env`, and could not
report Console as healthy. The profile now installs with a container-safe layout, builds shared
packages, uses a service-aware proxy, treats `.env` as optional, and checks Console's `/health`.

Redpanda started successfully but stayed unhealthy because `rpk cluster health` in the pinned
image no longer accepts `--brokers`. The healthcheck now uses the supported
`--exit-when-healthy` flag; a direct `rpk cluster info` confirmed the broker itself was running.
