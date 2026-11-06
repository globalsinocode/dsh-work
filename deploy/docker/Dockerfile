# Multi-stage: build monorepo + DSH harness, then server / nginx runtime images.
# Build: docker compose -f deploy/docker/compose.yaml build
# Tags: dsh-work/server, dsh-work/web

FROM node:22-bookworm-slim AS builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

WORKDIR /src

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server ./server
COPY packages ./packages
COPY apps ./apps
COPY deploy/.dsh ./deploy/.dsh
COPY deploy/deepseek-harness ./deploy/deepseek-harness

RUN pnpm install --frozen-lockfile

WORKDIR /src/deploy/deepseek-harness
RUN pnpm install --frozen-lockfile && pnpm run build

WORKDIR /src
RUN pnpm build

# --- API + DSH runtime (non-root, Docker CLI for execution containers) ---
FROM node:22-bookworm-slim AS server

RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu git ca-certificates curl docker.io \
  && rm -rf /var/lib/apt/lists/*

COPY deploy/docker/server-entrypoint.sh /usr/local/bin/dsh-work-server-entrypoint.sh
RUN chmod 755 /usr/local/bin/dsh-work-server-entrypoint.sh

WORKDIR /app

COPY --from=builder /src/server/dist ./server/dist
COPY --from=builder /src/server/migrations ./server/migrations
COPY --from=builder /src/server/config ./server/config
COPY --from=builder /src/server/package.json ./server/package.json
COPY --from=builder /src/deploy/.dsh ./deploy/.dsh
COPY --from=builder /src/deploy/deepseek-harness ./deploy/deepseek-harness
COPY --from=builder /src/package.json ./package.json

ENV NODE_ENV=production \
  DSH_RUNTIME_HOME=/app/deploy/deepseek-harness \
  DSH_HOME=/app/deploy/.dsh \
  DSH_WORK_DATA_ROOT=/app/data \
  DSH_WORK_DSH_SESSIONS_ROOT=/app/data/dsh-sessions \
  DSH_WORK_SERVER_PORT=4190

EXPOSE 4190

USER root
ENTRYPOINT ["/usr/local/bin/dsh-work-server-entrypoint.sh"]
CMD ["node", "server/dist/main.js"]

# --- HTTPS front door (static dist + API reverse proxy) ---
FROM nginx:1.30.4-alpine AS web

COPY --from=builder /src/apps/workbench-web/dist /srv/workbench
COPY --from=builder /src/apps/admin-web/dist /srv/admin
COPY deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY deploy/nginx/proxy_params /etc/nginx/proxy_params

ENV DSH_WORK_SERVER_PORT=4190 \
  DSH_WORK_NGINX_UPSTREAM_HOST=server \
  DSH_WORK_NGINX_DNS_RESOLVER=127.0.0.11 \
  DSH_WORK_WORKBENCH_SERVER_NAMES=localhost \
  DSH_WORK_ADMIN_SERVER_NAMES=localhost \
  DSH_WORK_HEALTHCHECK_HOST=localhost

EXPOSE 8443 8444
