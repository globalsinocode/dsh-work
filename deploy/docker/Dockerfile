# Multi-stage: build monorepo + DSH harness, then server / nginx runtime images.
# Build: docker compose -f deploy/docker/compose.yaml build
# Tags: dsh-work/server, dsh-work/web

# Modern Docker CLI (>=28.1) is required: the execution backend passes
# `--security-opt seccomp=builtin`, which older CLIs (Debian docker.io 20.10)
# misread as a profile file path.
FROM docker:cli AS docker-cli

FROM node:22-bookworm-slim AS builder

RUN set -eux; \
  apt_install() { apt-get update -o Acquire::Retries=3 "$@" && apt-get install -y --no-install-recommends git ca-certificates; }; \
  if ! apt_install; then \
    for attempt in 1 2 3 4 5; do apt_install && exit 0 || sleep 8; done; \
    sed -i '/bookworm-security/Id' /etc/apt/sources.list.d/debian.sources 2>/dev/null \
      || sed -i '/security.debian.org/d' /etc/apt/sources.list; \
    apt_install; \
  fi; \
  rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

WORKDIR /src

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server ./server
COPY packages ./packages
COPY apps ./apps
COPY deploy/.dsh ./deploy/.dsh
COPY deploy/deepseek-harness ./deploy/deepseek-harness
COPY docs/development/openapi-mobile-h5.json docs/development/openapi-mobile-h5.json
COPY docs/development/mobile-integration-guide.md docs/development/mobile-integration-guide.md

RUN pnpm install --frozen-lockfile

ARG DSH_CLIENT_COMMIT_HASH=0000000
ENV DSH_CLIENT_COMMIT_HASH=${DSH_CLIENT_COMMIT_HASH}

WORKDIR /src/deploy/deepseek-harness
RUN pnpm install --frozen-lockfile && pnpm run build
# Source-checkout 模式依赖 git rev-parse；镜像内无 .git，写入与 runtime-lock 一致的元数据供受管启动。
RUN node -e "const fs=require('node:fs');const lock=JSON.parse(fs.readFileSync('/src/server/config/dsh/runtime-lock.json','utf8'));fs.writeFileSync('dsh-runtime.json',JSON.stringify({version:lock.version,commit:lock.commit,protocolVersion:lock.protocolVersion}));"

WORKDIR /src
RUN pnpm build \
  && pnpm --config.inject-workspace-packages=true --filter @dsh-work/server deploy --prod /src/server-deploy

# --- API + DSH runtime (non-root, Docker CLI for execution containers) ---
FROM node:22-bookworm-slim AS server

RUN set -eux; \
  apt_install() { apt-get update -o Acquire::Retries=3 "$@" && apt-get install -y --no-install-recommends gosu git ca-certificates curl; }; \
  if ! apt_install; then \
    for attempt in 1 2 3 4 5; do apt_install && exit 0 || sleep 8; done; \
    sed -i '/bookworm-security/Id' /etc/apt/sources.list.d/debian.sources 2>/dev/null \
      || sed -i '/security.debian.org/d' /etc/apt/sources.list; \
    apt_install; \
  fi; \
  rm -rf /var/lib/apt/lists/*

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

COPY deploy/docker/server-entrypoint.sh /usr/local/bin/dsh-work-server-entrypoint.sh
RUN chmod 755 /usr/local/bin/dsh-work-server-entrypoint.sh

WORKDIR /app

COPY --from=builder /src/server-deploy/dist ./server/dist
COPY --from=builder /src/server-deploy/migrations ./server/migrations
COPY --from=builder /src/server-deploy/node_modules ./server/node_modules
COPY --from=builder /src/server/config ./server/config
COPY --from=builder /src/server-deploy/package.json ./server/package.json
COPY --from=builder /src/deploy/.dsh ./deploy/.dsh
COPY --from=builder /src/deploy/deepseek-harness ./deploy/deepseek-harness
COPY --from=builder /src/package.json ./package.json

ENV NODE_ENV=production \
  DSH_RUNTIME_HOME=/app/deploy/deepseek-harness \
  DSH_RUNTIME_COMMAND=/usr/local/bin/node \
  DSH_RUNTIME_ARGS_JSON='["--import","tsx/esm","apps/cli/lib/bin.js"]' \
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
