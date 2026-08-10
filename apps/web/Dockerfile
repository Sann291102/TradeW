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
# `@tradew/types` resolves through its `types: dist/index.d.ts`, and nothing
# builds it automatically — no package declares a prepare/postinstall hook.
# Without this line `next build` fails with "Cannot find module '@tradew/types'".
#
# This image had never built. It fails only inside the container: a developer
# machine always has `packages/types/dist` from an earlier `npm run build`, and
# `.dockerignore` excludes `dist` from the build context, so the sole
# environment that exposes the gap is the one nothing was running. Found
# 2026-08-10 by the new `docker` CI job.
#
# `@tradew/ui` is deliberately NOT built here — it is consumed source-only via
# Next's `transpilePackages` (see packages/ui and next.config.mjs), which is the
# design, not an omission.
RUN npm run build -w @tradew/types
ARG NEXT_PUBLIC_API_URL=/api
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build -w @tradew/web

FROM node:20-bookworm-slim AS runtime
WORKDIR /repo/apps/web
# tini so SIGTERM reaches Next as PID 1 and in-flight SSR requests finish
# instead of being cut — see the longer note in services/api/Dockerfile.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=build /repo/node_modules /repo/node_modules
# npm workspaces symlink node_modules/@tradew/* into packages/*, so copying
# node_modules alone brings the links and not their targets. `@tradew/ui` is
# transpiled from source at build time and `@tradew/types` is types-only, so the
# server would mostly survive without this — but a symlink pointing at nothing
# is a landmine for the first runtime import that needs it.
COPY --from=build /repo/packages /repo/packages
COPY --from=build /repo/apps/web/.next ./.next
COPY --from=build /repo/apps/web/package.json ./package.json
COPY --from=build /repo/apps/web/next.config.mjs ./next.config.mjs
# next.config.mjs `import`s this at server start to build the /feed allowlist.
# It was previously not copied, so the production image's Next server would fail
# to load its own config — a bug that no local run could surface, because
# locally the file is simply there. (There is no apps/web/public directory
# today; add a COPY for it here the moment one appears.)
COPY --from=build /repo/apps/web/feed-proxy-routes.mjs ./feed-proxy-routes.mjs

# Unprivileged runtime user — see services/api/Dockerfile. Next writes its
# build cache under .next at runtime, so that path has to be owned by the user
# it runs as or the server fails on first render.
RUN chown -R node:node /repo/apps/web
USER node

EXPOSE 3000
# Next has no dedicated health route; the root document is the liveness signal.
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
# `next start` serves the production build. (For a smaller image later, switch
# next.config to `output: 'standalone'` and copy only .next/standalone.)
CMD ["npx", "next", "start"]
