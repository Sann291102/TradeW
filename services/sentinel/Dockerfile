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
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
# Bind all interfaces inside the container (overrides the 127.0.0.1 dev default).
ENV HOST=0.0.0.0
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/packages /repo/packages
COPY --from=build /repo/services/sentinel/dist ./dist
COPY --from=build /repo/services/sentinel/package.json ./package.json
EXPOSE 4010
CMD ["node", "dist/main.js"]
