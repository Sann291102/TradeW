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
RUN npm run build -w @tradew/api

FROM node:20-bookworm-slim AS runtime
WORKDIR /repo/services/api
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
# node_modules carries the generated Prisma client (node_modules/.prisma).
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/services/api/dist ./dist
COPY --from=build /repo/services/api/package.json ./package.json
# Prisma schema + migration history, so this same image can also run
# `prisma migrate deploy` as the one-shot migrate service in compose.
COPY --from=build /repo/packages/database/prisma /repo/packages/database/prisma
EXPOSE 4000
CMD ["node", "dist/main.js"]
