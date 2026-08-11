# syntax=docker/dockerfile:1
# The operator console. Build context is the repo ROOT:
#   docker build -f apps/admin/Dockerfile -t tradew-admin .
#
# This image mirrors apps/web/Dockerfile deliberately — same monorepo build
# gotchas, same runtime shape. It is NOT meant to be published on the public
# domain: the admin console is operator-only and the compose override that runs
# it binds it to loopback (reachable via an SSH tunnel), never through Caddy.
#
# NEXT_PUBLIC_TRADEW_WEB_URL is baked into the client bundle at build time (it is
# only a link target for "View as Trader", not a credential). ADMIN_API_URL and
# ADMIN_API_TOKEN are read at server start from the environment, so they are
# runtime config and need no rebuild to change.

FROM node:20-bookworm-slim AS build
WORKDIR /repo
COPY . .
RUN npm ci
# Same as web: @tradew/types resolves through its built dist and nothing builds
# it automatically, so `next build` fails without this. @tradew/ui is consumed
# source-only via transpilePackages and is deliberately not built here.
RUN npm run build -w @tradew/types
ARG NEXT_PUBLIC_TRADEW_WEB_URL=/
ENV NEXT_PUBLIC_TRADEW_WEB_URL=$NEXT_PUBLIC_TRADEW_WEB_URL
RUN npm run build -w @tradew/admin

FROM node:20-bookworm-slim AS runtime
WORKDIR /repo/apps/admin
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/packages /repo/packages
COPY --from=build /repo/apps/admin/.next ./.next
COPY --from=build /repo/apps/admin/package.json ./package.json
COPY --from=build /repo/apps/admin/next.config.mjs ./next.config.mjs

RUN chown -R node:node /repo/apps/admin
USER node

EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npx", "next", "start"]
