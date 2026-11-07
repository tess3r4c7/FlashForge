# syntax=docker/dockerfile:1
# ─── FlashForge image ────────────────────────────────────────────────────────
#
# ONE image, two programs. The API and the worker are the same code with a
# different entry point, so they ship as one image and the command decides:
#   docker run flashforge                         → API  (node dist/server.js)
#   docker run flashforge node dist/worker.js     → worker
# One build, one tag, one thing to scan. Both can never drift apart.
#
# Multi-stage build:
#   build      full toolchain: npm ci (with dev deps), prisma generate, tsc
#   migrate    = build + `prisma migrate deploy` + seed  (one-shot job)
#   prod-deps  npm ci --omit=dev  (no TypeScript, Vitest, Prisma CLI...)
#   runtime    prod-deps + compiled dist/ only, runs as non-root
#
# The runtime image never contains the TypeScript sources, the test suite,
# or the compilers. Smaller image, and less to exploit.

ARG NODE_VERSION=22

# ─── build ───────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app

# The Prisma CLI's schema engine (used by migrate) needs OpenSSL.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# Dependencies first, sources later: this layer stays cached until
# package*.json changes, so a code-only change doesn't reinstall everything.
COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
COPY prisma7.config.ts tsconfig.json ./
# `prisma generate` doesn't connect to anything, but the config file reads
# DATABASE_URL, so give it a placeholder. The generated client goes to
# src/generated/prisma (git-ignored, so it MUST be generated here).
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" \
    npx prisma generate --config prisma7.config.ts

COPY src ./src
RUN npx tsc

# ─── migrate (one-shot) ──────────────────────────────────────────────────────
# Runs BEFORE new API/worker containers start. Kept out of the API's startup:
# with 3 API replicas, 3 processes racing to migrate is asking for trouble,
# and a failed migration should stop the deploy, not crash-loop the API.
FROM build AS migrate
CMD ["sh", "-c", "npx prisma migrate deploy --config prisma7.config.ts && node dist/scripts/seed.js"]

# ─── prod-deps ───────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
# @prisma/client declares the Prisma CLI as an OPTIONAL PEER dependency. The
# lockfile marks it "devOptional" (dev via our devDependencies, optional via
# the client), and npm only leaves such packages out when BOTH dev and
# optional are omitted. Without --omit=optional, ~200MB of CLI/Studio packages
# end up in the runtime image, which never runs the CLI (migrations happen in
# the separate `migrate` image).
RUN npm ci --omit=dev --omit=optional --omit=peer && npm cache clean --force

# ─── runtime ─────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# The official image ships a "node" user. If the app were compromised it
# could not write outside /app or install packages.
USER node

EXPOSE 3000

# `node` directly, not `npm start`: npm doesn't forward SIGTERM to its child,
# so `docker stop` would wait 10s and SIGKILL us, skipping graceful shutdown
# (finish in-flight requests, let payments complete, close connections).
CMD ["node", "dist/server.js"]

