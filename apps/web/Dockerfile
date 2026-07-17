# syntax=docker/dockerfile:1
# Build context is the repo ROOT:
#   docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_API_URL=/api -t tradew-web .
# NEXT_PUBLIC_API_URL is baked into the client bundle at build time. Default
# "/api" keeps the browser same-origin (Caddy proxies /api/* to the API), which
# avoids CORS entirely.

FROM node:20-bookworm-slim AS build
WORKDIR /repo
COPY . .
RUN npm ci
ARG NEXT_PUBLIC_API_URL=/api
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build -w @tradew/web

FROM node:20-bookworm-slim AS runtime
WORKDIR /repo/apps/web
ENV NODE_ENV=production
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/apps/web/.next ./.next
COPY --from=build /repo/apps/web/package.json ./package.json
COPY --from=build /repo/apps/web/next.config.mjs ./next.config.mjs
EXPOSE 3000
# `next start` serves the production build. (For a smaller image later, switch
# next.config to `output: 'standalone'` and copy only .next/standalone.)
CMD ["npx", "next", "start"]
