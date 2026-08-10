# syntax=docker/dockerfile:1
# Build context is the repo ROOT:
#   docker build -f services/sentinel/Dockerfile -t tradew-sentinel .
# Sentinel depends on the @tradew/ai-core and @tradew/types workspaces, so
# those are built first and their dist/ shipped alongside (npm workspace
# symlinks in node_modules resolve into packages/).

FROM node:20-bookworm-slim AS build
WORKDIR /repo
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm ci
RUN npx prisma generate --schema packages/database/prisma/schema.prisma
RUN npm run build -w @tradew/types -w @tradew/ai-core -w @tradew/sentinel

FROM node:20-bookworm-slim AS runtime
WORKDIR /repo/services/sentinel
# tini so SIGTERM reaches Node as PID 1 and Nest's shutdown hooks actually run
# — see the longer note in services/api/Dockerfile.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
# Bind all interfaces inside the container (overrides the 127.0.0.1 dev default).
ENV HOST=0.0.0.0
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/packages /repo/packages
COPY --from=build /repo/services/sentinel/dist ./dist
COPY --from=build /repo/services/sentinel/package.json ./package.json

# ── SENTINEL'S CITATION CORPUS ──────────────────────────────────────────────
#
# These are not documentation in this image, they are DATA. `si.config.ts`'s
# DEFAULT_CORPUS_ROOTS scans all six at runtime to build the BM25 index that
# every SentinelIntelligence verdict cites.
#
# Missing them fails SILENTLY, which is why this block exists (added
# 2026-08-10). The citation guarantee is structural — `VerdictBuilder.knowledge()`
# cannot be called without citations, and the cross-checker drops uncited
# verdicts rather than flagging them — so an empty corpus produces no error, no
# warning and no failed health check. It produces a Sentinel that never speaks,
# which is a designed and entirely normal-looking outcome. The flagship premium
# feature would have shipped as a well-behaved no-op.
#
# `findRepoRoot()` walks up looking for a directory containing both `services`
# and `packages`, which resolves to /repo here, so these must land at /repo/<name>.
# Adding a root to DEFAULT_CORPUS_ROOTS means adding a COPY here and an
# exception in .dockerignore.
# The book directory's name contains a space, which the shell-style COPY form
# cannot express — hence the JSON array form for this one line only.
COPY --from=build ["/repo/docs/Trading Books", "/repo/docs/Trading Books"]
COPY --from=build /repo/docs/product-architecture /repo/docs/product-architecture
COPY --from=build /repo/docs/handbook /repo/docs/handbook
COPY --from=build /repo/knowledge /repo/knowledge
COPY --from=build /repo/knowledge-base /repo/knowledge-base
COPY --from=build /repo/agents /repo/agents

# The index is written back to services/sentinel/data at runtime, so that path
# has to be writable by the unprivileged user below.
RUN mkdir -p /repo/services/sentinel/data

# Unprivileged runtime user — see services/api/Dockerfile. Sentinel reads a
# knowledge corpus off disk and holds a Postgres pool; neither needs root.
RUN chown -R node:node /repo/services/sentinel
USER node

EXPOSE 4010
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4010)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
