#!/usr/bin/env bash
set -euo pipefail

project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "${project_root}"

deployment_scripts=(
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
DSH_WORK_BIND_ADDRESSES=192.168.33.20 \
DSH_WORK_BIND_ADDRESS=192.168.33.20 \
DSH_WORK_WORKBENCH_ORIGINS=https://192.168.33.20:4174 \
DSH_WORK_ADMIN_ORIGINS=https://192.168.33.20:4180 \
node scripts/deploy/render-endpoint-compose.mjs "${endpoint_fixture}" "${project_root}" >/dev/null
docker compose --env-file deploy/runtime.env.example \
  -f deploy/compose.yaml \
  -f "${endpoint_fixture}/generated/compose.endpoints.yaml" config >/dev/null
rm -rf "${endpoint_fixture}"
python3 -c "import plistlib; plistlib.load(open('deploy/launchd/com.company.dsh-work.server.plist.template', 'rb'))"
python3 -c "import plistlib; plistlib.load(open('deploy/launchd/com.company.dsh-work.release-watcher.plist.template', 'rb'))"

grep -F 'listen 8443 ssl;' deploy/nginx/default.conf.template >/dev/null
grep -F 'listen 8444 ssl;' deploy/nginx/default.conf.template >/dev/null
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

echo "deployment configuration gate passed"
