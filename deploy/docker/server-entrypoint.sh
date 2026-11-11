#!/bin/sh
set -e
APP_ROOT=/app

if [ "$(id -u)" = "0" ] && [ -S /var/run/docker.sock ]; then
  chmod 666 /var/run/docker.sock 2>/dev/null || true
fi

if [ "$(id -u)" = "0" ]; then
  mkdir -p "${DSH_WORK_DATA_ROOT:-/app/data}" "${DSH_WORK_DSH_SESSIONS_ROOT:-/app/data/dsh-sessions}"
  chown -R node:node "${DSH_WORK_DATA_ROOT:-/app/data}" /app/deploy/.dsh 2>/dev/null || true
  # DSH credentials-local rejects world-readable files; Docker volumes may ship 755 from host copies.
  if [ -f /app/deploy/.dsh/.credentials.yaml ]; then
    gosu node:node chmod 700 /app/deploy/.dsh 2>/dev/null || true
    gosu node:node chmod 600 /app/deploy/.dsh/.credentials.yaml 2>/dev/null || true
  fi
  gosu node:node git config --global --replace-all safe.directory /app/deploy/deepseek-harness
  echo "dsh-work-server: running database migrations…"
  gosu node:node node "${APP_ROOT}/server/dist/infrastructure/postgres/migrate.js"
  exec gosu node:node "$@"
fi
exec "$@"
