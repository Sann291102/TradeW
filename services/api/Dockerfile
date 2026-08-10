# syntax=docker/dockerfile:1
# Build context is the repo ROOT (needs packages/ + workspace lockfile):
#   docker build -f services/api/Dockerfile -t tradew-api .
# Multi-arch: on OCI Ampere A1 (arm64) build with `--platform linux/arm64`.

FROM node:20-bookworm-slim AS build
WORKDIR /repo
# openssl is required by Prisma's query engine at generate + runtime.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm ci
RUN npx prisma generate --schema packages/database/prisma/schema.prisma
# Workspace dependencies FIRST.
#
# `@tradew/types`, `@tradew/market-data` and `@tradew/ai-core` are published to
# the workspace by their `types: dist/index.d.ts` path, not by their source, and
# no package declares a prepare/postinstall hook that builds them. Without this
# line `nest build` fails with 15 errors — TS2307 on all three modules, plus
# cascading TS18046s where `instanceof` narrowing against an unresolved error
# class leaves the caught value `unknown`.
#
# This image had never built. It failed locally only inside the container,
# because a developer machine always has `packages/*/dist` lying around from a
# previous `npm run build`, and `.dockerignore` excludes `dist` from the build
# context — so the one environment that reveals the bug is the one nothing ran.
# `services/sentinel/Dockerfile` and `services/market-data/Dockerfile` already
# did this correctly; only this file was missing it. Found 2026-08-10 by the new
# `docker` CI job, which exists for exactly this class of defect.
RUN npm run build -w @tradew/types -w @tradew/market-data -w @tradew/ai-core
RUN npm run build -w @tradew/api

FROM node:20-bookworm-slim AS runtime
WORKDIR /repo/services/api
# `tini` is a real init, not a nicety. Node runs as PID 1 in a container, and
# PID 1 does not get the kernel's default signal handlers — a SIGTERM that Node
# has no explicit handler for is simply discarded, so `docker stop` waits out
# its full grace period and then SIGKILLs. That skips Nest's shutdown hooks
# (see main.ts) and therefore the final telemetry flush, the Prisma disconnect
# and the job-lease release, turning every deploy into a hard kill.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
# node_modules carries the generated Prisma client (node_modules/.prisma).
COPY --from=build /repo/node_modules /repo/node_modules
# The workspace packages' built output. npm workspaces symlink
# node_modules/@tradew/* into packages/*, so copying node_modules alone brings
# the links and not what they point at — the process would start and then fail
# on the first require of @tradew/market-data. Same COPY the sentinel and
# market-data images already had.
COPY --from=build /repo/packages /repo/packages
COPY --from=build /repo/services/api/dist ./dist
COPY --from=build /repo/services/api/package.json ./package.json
# Prisma schema + migration history, so this same image can also run
# `prisma migrate deploy` as the one-shot migrate service in compose.
COPY --from=build /repo/packages/database/prisma /repo/packages/database/prisma

# Drop privileges. `node` (uid 1000) ships with the base image. Until this
# line the API ran as root, which meant a remote-code-execution bug anywhere in
# this process — or in any of its ~1,000 transitive dependencies — started with
# root inside the container and only the container boundary between it and the
# host. Nothing here needs root: the process binds 4000 (unprivileged), reads
# its own tree and writes nothing to disk.
RUN chown -R node:node /repo/services/api
USER node

EXPOSE 4000
# Distinct from the compose healthcheck on purpose: this one is baked into the
# image so any runtime (plain `docker run`, ECS, Nomad) gets it without extra
# configuration. /health is liveness — "is this process wedged?" — and must not
# depend on the database, or a database blip would restart every container at
# once. Readiness (/ready, which does check the DB) belongs to the load
# balancer, not to the thing that decides whether to kill the process.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
