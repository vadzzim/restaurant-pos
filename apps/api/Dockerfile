# The API image (§22). Build context is the repository root, never `apps/api`: the app imports
# built `@pos/*` output, so a context that holds one app directory cannot resolve a single import.
#
#   docker build -f apps/api/Dockerfile -t pos-api .
#
# The `deps` stage below is byte-identical in all three app Dockerfiles on purpose. BuildKit keys
# its cache on instruction content, so three images share one `pnpm install` instead of paying for
# it three times. Keep them in step or that stops being true silently.

# The base images are pinned by digest, and the tag is kept beside it for the human reading this:
# `24-alpine` moved under M14's feet, which is half of what the third `[M14, P3]` (closed in M24) was
# about — a build that is green today and a different Node tomorrow. The digest is the
# multi-platform index digest, so it still resolves on arm64. Re-resolve all three Dockerfiles
# together, and keep the `deps` stage byte-identical across them (BuildKit shares one
# `pnpm install` across the three images only while that holds):
#
#   docker buildx imagetools inspect node:24-alpine --format '{{.Manifest.Digest}}'
#
# This one is node v24.20.0.

# --- deps -------------------------------------------------------------------------------------
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS deps
RUN corepack enable
WORKDIR /app

# Manifests only, so a source edit does not invalidate the install layer.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/domain/package.json packages/domain/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile

# --- build ------------------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api
RUN pnpm run build:packages && pnpm --filter @pos/api run build

# Prune devDependencies. `--frozen-lockfile` keeps this honest: it resolves the same lockfile, it
# does not re-resolve a smaller one. `dist/` is outside `node_modules` and survives.
#
# `CI=true` is required, not cosmetic: switching an existing install to `--prod` makes pnpm rebuild
# the modules directory, and it refuses to remove one without a TTY unless it is told it is running
# unattended (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY).
RUN CI=true pnpm install --frozen-lockfile --prod --ignore-scripts

# Assemble exactly what ships, here rather than as a column of COPY lines in the runtime stage:
# `cp` can skip a `node_modules` that pruning left empty, and COPY cannot. `-a` is what keeps
# pnpm's links as links — they are relative and resolve identically under /app.
RUN set -eu; \
    mkdir -p /out; \
    cp -a package.json node_modules /out/; \
    for project in packages/config packages/contracts packages/domain packages/db apps/api; do \
      mkdir -p "/out/$project"; \
      cp -a "$project/package.json" "$project/dist" "/out/$project/"; \
      if [ -d "$project/node_modules" ]; then cp -a "$project/node_modules" "/out/$project/"; fi; \
    done

# --- runtime ----------------------------------------------------------------------------------
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Built output and the pruned dependency tree, nothing else — no sources, no toolchain, no pnpm.
# `tsup` marks `dependencies` external, so `dist/index.js` imports `@pos/db` and `fastify` by
# name: the `node_modules` trees are not optional.
COPY --from=build --chown=node:node /out /app

# `node` exists in the base image with uid 1000; creating another user would only rename it.
USER node
WORKDIR /app/apps/api
EXPOSE 3000
# Not `pnpm start`: that script reads `../../.env`, deliberately absent from the image —
# configuration comes from the environment (§22) — and pnpm as PID 1 would swallow SIGTERM,
# which `src/index.ts` needs to shut the consumer and the sockets down cleanly.
CMD ["node", "dist/index.js"]
