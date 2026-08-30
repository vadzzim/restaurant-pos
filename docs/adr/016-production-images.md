# 016. Production images ship the pruned workspace, not a bundled file

Status: accepted
Date: 2026-08-30

## Context

§22 asks for "a multi-stage Dockerfile per app, non-root, with the built output only". The obvious
reading — `COPY dist/index.js`, `CMD node index.js` — is not available: `tsup` marks everything in
`dependencies` external, so `apps/api/dist/index.js` opens with `import { getDb } from '@pos/db'`.
Four internal packages, and every app imports their built output.

## Decision

**Build context is the repository root; the runtime stage carries a pruned workspace tree.** Three
stages: `deps` installs from the lockfile with manifests only, `build` compiles and then runs
`CI=true pnpm install --frozen-lockfile --prod` to prune devDependencies, and `runtime` takes
`dist/`, `package.json` and the surviving `node_modules` for the root, the four packages and the one
app. pnpm's links are relative and resolve identically under `/app`.

The `deps` stage is byte-identical in all three Dockerfiles, so BuildKit's content cache gives three
images one `pnpm install`.

`apps/web` is the exception: Vite emits a self-contained bundle, so its runtime is
`nginxinc/nginx-unprivileged` with static files and no Node — that image rather than `nginx:alpine`
plus a `USER` line, which cannot bind :80 or write its pid.

## Consequences

- `node_modules` is part of "built output only" for the two Node apps. Honest about what runs, at
  the cost of size.
- Migrations are not in the image — they are `tsx` scripts over the drizzle journal — so
  `verify-multi-instance.mjs` migrates from the host before the replicas start.
- `CMD` is `node dist/index.js`, never `pnpm start`: that script reads `../../.env`, deliberately
  absent, and pnpm as PID 1 would swallow the SIGTERM both apps need to shut down cleanly.

## Alternatives considered

- **`pnpm deploy`** — designed for this, but in pnpm 10 it needs `inject-workspace-packages` or
  `--legacy`, and changing the workspace's linker to suit the image would change what every local
  build resolves. The image must not dictate the workspace.
- **Bundling `@pos/*` in** (`--noExternal`) — rejected: the image's module graph would differ from
  the one every test runs, so an image-only failure would stay invisible until deployment.
