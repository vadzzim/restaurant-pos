# The web image (§22): the Vue bundle, served by nginx, which also fronts the API replicas.
# Build context is the repository root, never `apps/web` — the app imports built `@pos/*` output,
# so a context holding one app directory cannot resolve a single import.
#
#   docker build -f apps/web/Dockerfile -t pos-web .
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
COPY apps/web apps/web
# There is no prune step here and no `node_modules` in the runtime image: Vite emits a
# self-contained bundle, so unlike the API and the worker this app really is built output alone.
RUN pnpm run build:packages && pnpm --filter @pos/web run build

# --- runtime ----------------------------------------------------------------------------------
# The unprivileged image rather than `nginx:alpine` plus a `USER` line: stock nginx binds :80 and
# writes its pid and caches under root-owned paths, so `USER nginx` on it simply fails to start.
# This variant listens on 8080 and owns its own writable paths by construction.
# Pinned like the Node base above; this digest is nginx 1.29.8. **Do not lower the minor**:
# `nginx.conf` uses the `resolve` parameter of `server`, which was nginx Plus-only until 1.27.3.
FROM nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6 AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
