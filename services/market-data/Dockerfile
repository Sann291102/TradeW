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
# tini so SIGTERM reaches Node as PID 1 — see services/api/Dockerfile. It
# matters more here than anywhere else: an unclean exit leaves a broker feed
# socket to be reaped on timeout, and Dhan counts live connections per account
# (five, then it evicts the oldest with code 805), so a hard-killed replica can
# cost the next one its slot.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
# Bind all interfaces inside the container (overrides the 127.0.0.1 dev default).
ENV HOST=0.0.0.0
# node_modules carries the generated Prisma client (node_modules/.prisma).
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/packages /repo/packages
COPY --from=build /repo/services/market-data/dist ./dist
COPY --from=build /repo/services/market-data/package.json ./package.json
# The Dhan live-feed bridge (`scripts/live-feed-server.ts`) ships in this image
# too, run as a SEPARATE compose service from the same build — see the
# `live-feed` service in infra/docker/docker-compose.prod.yml.
#
# It is not part of the Nest build: it is a standalone ts-node script, and it
# had no container at all until 2026-08-10 even though production proxies
# `/feed/*` to it (apps/web/feed-proxy-routes.mjs) and Sentinel reads its
# `/candles` and `/quotes` for live market data. In other words the deployed
# stack referenced a process that the deployed stack did not run. Copying the
# sources and their tsconfig is what makes it runnable here; `ts-node` is
# already present because the build stage's `npm ci` installs devDependencies.
COPY --from=build /repo/services/market-data/scripts ./scripts
COPY --from=build /repo/services/market-data/tsconfig.json ./tsconfig.json
COPY --from=build /repo/services/market-data/tsconfig.scripts.json ./tsconfig.scripts.json

# Unprivileged runtime user — see services/api/Dockerfile.
RUN chown -R node:node /repo/services/market-data
USER node

EXPOSE 4020
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4020)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
