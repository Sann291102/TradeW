# syntax=docker/dockerfile:1
# Build context is the repo ROOT (needs packages/ + workspace lockfile):
#   docker build -f services/market-data/Dockerfile -t tradew-market-data .
#
# Added 2026-08-04 — this service previously had no Dockerfile, no compose
# entry, and no CI job despite being real, built code (see audit notes in
# archive/README.md's 2026-08-04 entry / the implementation report). It's
# a SINGLETON by design (see src/main.ts) — never scale this beyond one
# replica; the broker feed connection set is a per-account resource.

FROM node:20-bookworm-slim AS build
WORKDIR /repo
# openssl is required by Prisma's query engine at generate + runtime.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm ci
RUN npx prisma generate --schema packages/database/prisma/schema.prisma
RUN npm run build -w @tradew/types -w @tradew/market-data -w @tradew/market-data-service

FROM node:20-bookworm-slim AS runtime
WORKDIR /repo/services/market-data
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
# Bind all interfaces inside the container (overrides the 127.0.0.1 dev default).
ENV HOST=0.0.0.0
# node_modules carries the generated Prisma client (node_modules/.prisma).
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/packages /repo/packages
COPY --from=build /repo/services/market-data/dist ./dist
COPY --from=build /repo/services/market-data/package.json ./package.json
EXPOSE 4020
CMD ["node", "dist/main.js"]
