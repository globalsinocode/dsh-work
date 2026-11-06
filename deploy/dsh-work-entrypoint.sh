#!/bin/sh
# Dev container: Linux uid/gid, isolated node_modules, execution containers via docker.sock.
set -e
DSH_CHECKOUT=/work/deploy/deepseek-harness
DSH_SEED=/work/deploy/deepseek-harness-seed
INSTALL_MARKER=/work/.dsh-harness-linux-install
BUILD_MARKER=/work/.dsh-harness-linux-build

rewrite_database_url_for_docker() {
  if [ -z "${DSH_WORK_DATABASE_URL:-}" ]; then
    return 0
  fi
  case "$DSH_WORK_DATABASE_URL" in
    *@127.0.0.1:*)
      export DSH_WORK_DATABASE_URL=$(printf '%s' "$DSH_WORK_DATABASE_URL" | sed 's/@127.0.0.1:/@host.docker.internal:/')
      ;;
    *@localhost:*)
      export DSH_WORK_DATABASE_URL=$(printf '%s' "$DSH_WORK_DATABASE_URL" | sed 's/@localhost:/@host.docker.internal:/')
      ;;
  esac
}

rewrite_database_url_for_docker

if [ "$(id -u)" = "0" ] && [ -S /var/run/docker.sock ]; then
  chmod 666 /var/run/docker.sock 2>/dev/null || true
fi
if [ "$(id -u)" = "0" ]; then
  mkdir -p /work/node_modules "$DSH_CHECKOUT/node_modules"
  chown -R node:node /work/node_modules "$DSH_CHECKOUT" 2>/dev/null || true
  gosu node:node git config --global --add safe.directory /work
  gosu node:node git config --global --add safe.directory "$DSH_CHECKOUT"
  rm -rf "$DSH_CHECKOUT/.git/dsh-hooks" 2>/dev/null || true

  if [ ! -f "$DSH_CHECKOUT/pnpm-lock.yaml" ]; then
    echo "dsh-work: seeding DSH harness into Linux volume (avoid Windows bind-mount EPERM on build)…"
    gosu node:node rsync -a --exclude node_modules --exclude .git/dsh-hooks "$DSH_SEED/" "$DSH_CHECKOUT/"
  fi

  if [ ! -f /work/node_modules/.modules.yaml ]; then
    echo "dsh-work: installing Linux node_modules (first run, isolated volume)…"
    gosu node:node sh -c 'cd /work && pnpm install --frozen-lockfile'
  fi
  if [ ! -f "$INSTALL_MARKER" ]; then
    echo "dsh-work: installing Linux DSH harness dependencies…"
    gosu node:node sh -c "cd $DSH_CHECKOUT && pnpm install --frozen-lockfile --ignore-scripts"
    gosu node:node touch "$INSTALL_MARKER"
  fi
  if [ ! -f "$BUILD_MARKER" ]; then
    echo "dsh-work: building DSH harness on Linux volume (first run, may take 10–20 min)…"
    gosu node:node sh -c "cd $DSH_CHECKOUT && NODE_OPTIONS='--max-old-space-size=8192' pnpm run build"
    gosu node:node touch "$BUILD_MARKER"
    rm -f /work/.dsh-harness-linux-build.inprogress /work/.dsh-harness-build.log 2>/dev/null || true
  fi
  exec gosu node:node "$@"
fi
exec "$@"
