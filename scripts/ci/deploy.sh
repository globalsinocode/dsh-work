#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "${project_root}"

deployment_scripts=(
  deploy/execution-image/smoke-test.sh
  scripts/deploy/backup.sh
  scripts/deploy/set-macmini-endpoints.sh
  scripts/deploy/init-intranet-ca.sh
  scripts/deploy/install-launchd.sh
  scripts/deploy/install-release-watcher.sh
  scripts/deploy/issue-intranet-certificate.sh
  scripts/deploy/preflight.sh
  scripts/deploy/render-endpoint-compose.sh
  scripts/deploy/release.sh
  scripts/deploy/restore.sh
  scripts/deploy/rollback.sh
  scripts/deploy/run-server.sh
  scripts/deploy/watch-release.sh
  scripts/release/build-release.sh
)

for script in "${deployment_scripts[@]}"; do
  bash -n "${script}"
done

certificate_fixture=$(mktemp -d "${TMPDIR:-/tmp}/dsh-work-ca-test.XXXXXX")
cleanup() {
  rm -rf "${certificate_fixture}"
}
trap cleanup EXIT
bash scripts/deploy/init-intranet-ca.sh \
  --ca-dir "${certificate_fixture}/ca" >/dev/null 2>&1
bash scripts/deploy/issue-intranet-certificate.sh \
  --ca-dir "${certificate_fixture}/ca" \
  --ip 192.168.50.20 \
  --ip 192.168.50.21 \
  --dns work.example.com \
  --output-dir "${certificate_fixture}/issued" >/dev/null 2>&1
openssl verify \
  -CAfile "${certificate_fixture}/issued/root-ca.crt" \
  "${certificate_fixture}/issued/server.crt" >/dev/null
[[ ! -e "${certificate_fixture}/issued/root-ca.key" ]]
if openssl x509 -help 2>&1 | grep -q -- '-checkip'; then
  openssl x509 -in "${certificate_fixture}/issued/server.crt" -noout -checkip 192.168.50.20 >/dev/null
  openssl x509 -in "${certificate_fixture}/issued/server.crt" -noout -checkip 192.168.50.21 >/dev/null
else
  openssl x509 -in "${certificate_fixture}/issued/server.crt" -noout -text \
    | grep -F 'IP Address:192.168.50.20' >/dev/null
  openssl x509 -in "${certificate_fixture}/issued/server.crt" -noout -text \
    | grep -F 'IP Address:192.168.50.21' >/dev/null
fi
if openssl x509 -help 2>&1 | grep -q -- '-checkhost'; then
  openssl x509 -in "${certificate_fixture}/issued/server.crt" -noout -checkhost work.example.com >/dev/null
else
  openssl x509 -in "${certificate_fixture}/issued/server.crt" -noout -text \
    | grep -F 'DNS:work.example.com' >/dev/null
fi
rm -rf "${certificate_fixture}"
trap - EXIT

node scripts/ci/release-watcher.test.mjs
node scripts/ci/deployment-safety.test.mjs

endpoint_fixture=$(mktemp -d "${TMPDIR:-/tmp}/dsh-work-endpoints-test.XXXXXX")
NODE_ENV=production \
DSH_WORK_BIND_ADDRESSES=192.168.1.99 \
DSH_WORK_BIND_ADDRESS=192.168.1.99 \
DSH_WORK_WORKBENCH_ORIGINS=https://192.168.1.99:4174 \
DSH_WORK_ADMIN_ORIGINS=https://192.168.1.99:4180 \
node scripts/deploy/render-endpoint-compose.mjs "${endpoint_fixture}" "${project_root}" >/dev/null
docker compose --env-file deploy/runtime.env.example \
  -f deploy/compose.yaml \
  -f "${endpoint_fixture}/generated/compose.endpoints.yaml" config >/dev/null
rm -rf "${endpoint_fixture}"
python3 -c "import plistlib; plistlib.load(open('deploy/launchd/com.company.dsh-work.server.plist.template', 'rb'))"
python3 -c "import plistlib; plistlib.load(open('deploy/launchd/com.company.dsh-work.release-watcher.plist.template', 'rb'))"

grep -F 'listen 8443 ssl;' deploy/nginx/default.conf.template >/dev/null
grep -F 'listen 8444 ssl;' deploy/nginx/default.conf.template >/dev/null
grep -F 'server ${DSH_WORK_UPSTREAM_HOST}:${DSH_WORK_SERVER_PORT} max_fails=0;' deploy/nginx/default.conf.template >/dev/null
grep -F 'DSH_WORK_UPSTREAM_HOST: ${DSH_WORK_UPSTREAM_HOST:-host.docker.internal}' deploy/compose.yaml >/dev/null
grep -F 'DSH_WORK_UPSTREAM_HOST' deploy/runtime.env.example >/dev/null
grep -F 'workflow_dispatch:' .github/workflows/release.yml >/dev/null
grep -Eq 'actions/attest@[0-9a-f]{40}[[:space:]]+# v4\.' .github/workflows/release.yml
grep -F 'gh release edit "${tag}" --draft=false --latest' .github/workflows/release.yml >/dev/null
grep -F 'git ls-remote --tags --refs origin' .github/workflows/release.yml >/dev/null
grep -F 'gh release verify "${tag}"' .github/workflows/release.yml >/dev/null
grep -F -- '--json isImmutable' .github/workflows/release.yml >/dev/null
grep -F 'release.immutable !== true' scripts/deploy/watch-release.sh >/dev/null
grep -F 'release.author?.login !== "github-actions[bot]"' scripts/deploy/watch-release.sh >/dev/null
grep -F 'release_version_script="${automation_root}/release-version.sh"' scripts/deploy/watch-release.sh >/dev/null
grep -F 'release-version.sh.new' scripts/deploy/install-release-watcher.sh >/dev/null
grep -F 'bash "${DWP_BUNDLE}/scripts/deploy/release.sh" "${DWP_VERSION}" "${DWP_ROOT}"' docs/release/mac-mini-deployment-runbook.md >/dev/null
grep -F 'bash "${DWP_BUNDLE}/scripts/deploy/install-release-watcher.sh" "${DWP_ROOT}"' docs/release/mac-mini-deployment-runbook.md >/dev/null
grep -F 'PATH=/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin' deploy/runtime.env.example >/dev/null
grep -F -- '--deny-self-hosted-runners' scripts/deploy/release.sh >/dev/null
grep -F '/releases/latest' scripts/deploy/watch-release.sh >/dev/null
if grep -Eq '^[[:space:]]+push:' .github/workflows/release.yml; then
  echo "manual release workflow must not run on push" >&2
  exit 1
fi
if grep -Eq 'runs-on:.*self-hosted' .github/workflows/release.yml; then
  echo "public repository release workflow must not target a production self-hosted runner" >&2
  exit 1
fi

# Render the Nginx template with the pinned image and check the upstream syntax. The template is
# the only place that reaches the host backend, and an unreachable IPv6 resolution there caused
# production 502 "no live upstreams"; both the default name and a pinned IPv4 must parse.
nginx_image=$(sed -n 's/.*DSH_WORK_NGINX_IMAGE:-\([^}]*\).*/\1/p' deploy/compose.yaml | head -1)
[[ -n "${nginx_image}" ]] || { echo "cannot resolve the Nginx image from deploy/compose.yaml" >&2; exit 1; }
nginx_fixture=$(mktemp -d "${TMPDIR:-/tmp}/dsh-work-nginx-test.XXXXXX")
cleanup_nginx() {
  rm -rf "${nginx_fixture}"
}
trap cleanup_nginx EXIT
mkdir -p "${nginx_fixture}/tls"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=work.example.com' \
  -keyout "${nginx_fixture}/tls/server.key" -out "${nginx_fixture}/tls/server.crt" >/dev/null 2>&1
cp deploy/nginx/proxy_params "${nginx_fixture}/proxy_params"
# envsubst must only replace the deployment variables: Nginx's own $http_upgrade/$connection_upgrade
# must survive, and the image entrypoint does the same by listing the defined variables.
cat > "${nginx_fixture}/check.sh" <<'SH'
set -eu
envsubst '${DSH_WORK_UPSTREAM_HOST} ${DSH_WORK_SERVER_PORT} ${DSH_WORK_WORKBENCH_SERVER_NAMES} ${DSH_WORK_ADMIN_SERVER_NAMES}' \
  < /template.conf > /etc/nginx/conf.d/default.conf
nginx -t
SH
for upstream_host in host.docker.internal 192.0.2.10; do
  docker run --rm --entrypoint sh --add-host host.docker.internal:127.0.0.1 \
    -e DSH_WORK_UPSTREAM_HOST="${upstream_host}" \
    -e DSH_WORK_SERVER_PORT=4190 \
    -e DSH_WORK_WORKBENCH_SERVER_NAMES=work.example.com \
    -e DSH_WORK_ADMIN_SERVER_NAMES=admin.example.com \
    -v "${project_root}/deploy/nginx/default.conf.template:/template.conf:ro" \
    -v "${nginx_fixture}/tls:/etc/dsh-work/tls:ro" \
    -v "${nginx_fixture}/proxy_params:/etc/nginx/proxy_params:ro" \
    -v "${nginx_fixture}/check.sh:/check.sh:ro" \
    "${nginx_image}" /check.sh >/dev/null \
    || { echo "Nginx template is invalid for upstream host ${upstream_host}" >&2; exit 1; }
done
rm -rf "${nginx_fixture}"
trap - EXIT

echo "deployment configuration gate passed"
