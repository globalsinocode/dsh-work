#!/usr/bin/env bash
set -euo pipefail

deploy_root=${1:?Usage: preflight.sh DEPLOY_ROOT RELEASE_DIR}
release_dir=${2:?Usage: preflight.sh DEPLOY_ROOT RELEASE_DIR}
runtime_env=${3:-"${deploy_root}/runtime.env"}
candidate_endpoint_compose=${4:-"${deploy_root}/generated/.compose.endpoints.preflight-$$.yaml"}
external_endpoint_candidate=false
[[ $# -lt 4 ]] || external_endpoint_candidate=true

cleanup() {
  [[ "${external_endpoint_candidate}" == true ]] || rm -f "${candidate_endpoint_compose}"
}
trap cleanup EXIT

fail() {
  echo "preflight failed: $*" >&2
  exit 1
}

[[ "$(uname -s)" == Darwin ]] || fail "dsh-work host deployment requires macOS"
[[ "$(uname -m)" == arm64 ]] || fail "the supported Mac mini target is Apple Silicon (arm64)"
[[ -r "${runtime_env}" ]] || fail "missing ${runtime_env}"

set -a
# shellcheck disable=SC1090
source "${runtime_env}"
set +a

for command_name in docker git curl gh shasum launchctl openssl plutil ifconfig; do
  command -v "${command_name}" >/dev/null || fail "required command is unavailable: ${command_name}"
done
gh auth status >/dev/null 2>&1 || fail "GitHub CLI is not authenticated"
gh release verify --help >/dev/null 2>&1 || fail "GitHub CLI does not support immutable Release verification"
gh attestation verify --help | grep -F -- '--deny-self-hosted-runners' >/dev/null \
  || fail "GitHub CLI does not support the required provenance policy"
docker info >/dev/null 2>&1 || fail "Docker Desktop is not running"
docker compose version >/dev/null 2>&1 || fail "Docker Compose is unavailable"

node_bin=${DSH_WORK_NODE_BIN:?Set DSH_WORK_NODE_BIN in runtime.env}
[[ -x "${node_bin}" ]] || fail "Node.js is not executable: ${node_bin}"
node_supported=$("${node_bin}" -p "const [major,minor]=process.versions.node.split('.').map(Number); String((major===22&&minor>=19)||major>=24)")
[[ "${node_supported}" == true ]] || fail "Node.js 22.19+ or 24+ is required"

[[ "${NODE_ENV:-}" == production ]] || fail "NODE_ENV must be production"
[[ -z "${DSH_RUNTIME_COMPATIBILITY:-}" ]] \
  || fail "DSH_RUNTIME_COMPATIBILITY is development-only and must be unset in production"
[[ "${DSH_WORK_AUTH_MODE:-}" != prototype ]] || fail "prototype authentication is forbidden in production"
[[ "${DSH_WORK_COOKIE_SECURE:-}" == true ]] || fail "secure cookies are mandatory"
[[ "${DSH_WORK_SERVER_HOST:-}" == 127.0.0.1 ]] || fail "the native server must bind only to 127.0.0.1"

for required_path in \
  "${release_dir}/release.json" \
  "${release_dir}/server/dist/main.js" \
  "${release_dir}/server/dist/modules/identity/config.js" \
  "${release_dir}/server/dist/modules/runtime/dsh-runtime-installation.js" \
  "${release_dir}/server/dist/infrastructure/postgres/migrate.js" \
  "${release_dir}/server/migrations" \
  "${release_dir}/server/config/dsh/runtime-lock.json" \
  "${release_dir}/apps/workbench-web/dist/index.html" \
  "${release_dir}/apps/admin-web/dist/index.html" \
  "${release_dir}/deploy/compose.yaml" \
  "${release_dir}/scripts/deploy/configure-macmini-endpoints.mjs" \
  "${release_dir}/scripts/deploy/render-endpoint-compose.sh" \
  "${release_dir}/scripts/deploy/render-endpoint-compose.mjs" \
  "${release_dir}/scripts/deploy/set-macmini-endpoints.sh"; do
  [[ -e "${required_path}" ]] || fail "release payload is incomplete: ${required_path}"
done

if ! (
  cd "${release_dir}"
  "${node_bin}" --input-type=module <<'JS'
import { loadStartupIdentityConfiguration } from './server/dist/modules/identity/config.js'
const configuration = loadStartupIdentityConfiguration()
if (configuration.aiHubConfigurationIssue) console.warn(`AI Hub 登录未启用：${configuration.aiHubConfigurationIssue}。独立账号登录仍可用。`)
JS
); then
  fail "Production identity configuration is invalid"
fi

endpoint_compose=$("${release_dir}/scripts/deploy/render-endpoint-compose.sh" \
  "${deploy_root}" "${release_dir}" "${candidate_endpoint_compose}" "${runtime_env}")
[[ -r "${endpoint_compose}" ]] || fail "generated endpoint Compose override is unreadable"

if ! "${node_bin}" -e '
  const url = new URL(process.env.DSH_WORK_DATABASE_URL ?? "")
  const expected = {
    host: "127.0.0.1",
    port: process.env.DSH_WORK_POSTGRES_PORT ?? "5434",
    user: process.env.DSH_WORK_POSTGRES_USER,
    password: process.env.DSH_WORK_POSTGRES_PASSWORD,
    database: process.env.DSH_WORK_POSTGRES_DB,
  }
  const actual = {
    host: url.hostname,
    port: url.port,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
  }
  if (Object.keys(expected).some(key => actual[key] !== expected[key])) process.exit(1)
'; then
  fail "DSH_WORK_DATABASE_URL does not match the local PostgreSQL settings"
fi

[[ -r "${DSH_WORK_TLS_CERT_FILE:?Set DSH_WORK_TLS_CERT_FILE}" ]] || fail "TLS certificate is unreadable"
[[ -r "${DSH_WORK_TLS_KEY_FILE:?Set DSH_WORK_TLS_KEY_FILE}" ]] || fail "TLS private key is unreadable"
[[ -r "${DSH_WORK_CA_CERT_FILE:?Set DSH_WORK_CA_CERT_FILE}" ]] || fail "internal CA certificate is unreadable"
certificate_directory=$(cd "$(dirname "${DSH_WORK_TLS_CERT_FILE}")" && pwd -P)
for forbidden_ca_key in "${certificate_directory}/root-ca.key" "${certificate_directory}/internal-ca.key"; do
  [[ ! -e "${forbidden_ca_key}" ]] \
    || fail "offline CA private keys must never be stored on the Mac mini: ${forbidden_ca_key}"
done
openssl x509 -in "${DSH_WORK_TLS_CERT_FILE}" -noout -checkend 86400 >/dev/null || fail "TLS certificate expires in less than 24 hours"
bind_address_values=${DSH_WORK_BIND_ADDRESSES:-${DSH_WORK_BIND_ADDRESS:?Set DSH_WORK_BIND_ADDRESSES}}
old_ifs=${IFS}
IFS=',' read -r -a bind_addresses <<<"${bind_address_values}"
IFS=${old_ifs}
for bind_address in "${bind_addresses[@]}"; do
  bind_address=${bind_address//[[:space:]]/}
  if ! ifconfig | awk -v expected="${bind_address}" \
    '$1 == "inet" && $2 == expected { found = 1 } END { exit(found ? 0 : 1) }'; then
    fail "configured private IP is not assigned to a Mac mini interface: ${bind_address}"
  fi
  if openssl x509 -help 2>&1 | grep -q -- '-checkip'; then
    openssl x509 -in "${DSH_WORK_TLS_CERT_FILE}" -noout -checkip "${bind_address}" >/dev/null \
      || fail "TLS certificate does not contain IP SAN ${bind_address}"
  else
    openssl x509 -in "${DSH_WORK_TLS_CERT_FILE}" -noout -text \
      | grep -F "IP Address:${bind_address}" >/dev/null \
      || fail "TLS certificate does not contain IP SAN ${bind_address}"
  fi
done

origin_values=${DSH_WORK_WORKBENCH_ORIGINS:-${AI_HUB_WORKBENCH_PORTAL_URL:?Set workbench Origins}}
origin_values+=",${DSH_WORK_ADMIN_ORIGINS:-${AI_HUB_ADMIN_PORTAL_URL:?Set admin Origins}}"
IFS=',' read -r -a configured_origins <<<"${origin_values}"
IFS=${old_ifs}
checked_dns_names=' '
for configured_origin in "${configured_origins[@]}"; do
  origin_host=$("${node_bin}" -e 'process.stdout.write(new URL(process.argv[1].trim()).hostname)' \
    "${configured_origin}")
  [[ "${origin_host}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && continue
  [[ "${checked_dns_names}" != *" ${origin_host} "* ]] \
    || continue
  checked_dns_names+="${origin_host} "
  if openssl x509 -help 2>&1 | grep -q -- '-checkhost'; then
    openssl x509 -in "${DSH_WORK_TLS_CERT_FILE}" -noout -checkhost "${origin_host}" >/dev/null \
      || fail "TLS certificate does not contain DNS SAN ${origin_host}"
  else
    openssl x509 -in "${DSH_WORK_TLS_CERT_FILE}" -noout -text \
      | grep -F "DNS:${origin_host}" >/dev/null \
      || fail "TLS certificate does not contain DNS SAN ${origin_host}"
  fi
done
openssl verify -CAfile "${DSH_WORK_CA_CERT_FILE}" "${DSH_WORK_TLS_CERT_FILE}" >/dev/null \
  || fail "TLS certificate is not signed by the configured offline CA"
certificate_public_key=$(openssl x509 -in "${DSH_WORK_TLS_CERT_FILE}" -pubkey -noout \
  | openssl pkey -pubin -outform DER 2>/dev/null \
  | shasum -a 256 | awk '{print $1}')
private_public_key=$(openssl pkey -in "${DSH_WORK_TLS_KEY_FILE}" -pubout -outform DER 2>/dev/null \
  | shasum -a 256 | awk '{print $1}')
[[ "${certificate_public_key}" == "${private_public_key}" ]] || fail "TLS certificate and private key do not match"

off_host_root=${DSH_WORK_OFF_HOST_BACKUP_DIRECTORY:?Set DSH_WORK_OFF_HOST_BACKUP_DIRECTORY}
[[ "${off_host_root}" == /* && "${off_host_root}" != / ]] \
  || fail "off-host backup directory must be an absolute non-root path"
[[ -d "${off_host_root}" && ! -L "${off_host_root}" && -w "${off_host_root}" ]] \
  || fail "off-host backup directory must be a writable mounted directory: ${off_host_root}"
local_device=$(df -P "${deploy_root}" | awk 'NR==2 {print $1}')
off_host_device=$(df -P "${off_host_root}" | awk 'NR==2 {print $1}')
[[ -n "${local_device}" && -n "${off_host_device}" && "${local_device}" != "${off_host_device}" ]] \
  || fail "off-host backups must use a filesystem distinct from ${deploy_root}"

runtime_home=${DSH_RUNTIME_HOME:?Set DSH_RUNTIME_HOME in runtime.env}
runtime_is_worktree=$(git -C "${runtime_home}" rev-parse --is-inside-work-tree 2>/dev/null) \
  || fail "DSH_RUNTIME_HOME is not a Git checkout or worktree: ${runtime_home}"
[[ "${runtime_is_worktree}" == true ]] \
  || fail "DSH_RUNTIME_HOME is not a Git checkout or worktree: ${runtime_home}"
locked_version=$("${node_bin}" -e "const p=require(process.argv[1]); process.stdout.write(p.version ?? '')" \
  "${release_dir}/server/config/dsh/runtime-lock.json")
locked_commit=$("${node_bin}" -e "const p=require(process.argv[1]); process.stdout.write(p.commit ?? '')" \
  "${release_dir}/server/config/dsh/runtime-lock.json")
[[ "${locked_version}" == "${DSH_EXPECTED_VERSION:?Set DSH_EXPECTED_VERSION}" ]] \
  || fail "release DSH version lock does not match runtime.env"
[[ "${locked_commit}" == "${DSH_EXPECTED_COMMIT:?Set DSH_EXPECTED_COMMIT}" ]] \
  || fail "release DSH commit lock does not match runtime.env"
actual_commit=$(git -C "${runtime_home}" rev-parse HEAD)
[[ "${actual_commit}" == "${locked_commit}" ]] || fail "installed DSH commit does not match the release lock"
actual_version=$("${node_bin}" -e "const p=require(process.argv[1]); process.stdout.write(p.version ?? '')" "${runtime_home}/package.json")
[[ "${actual_version}" == "${locked_version}" ]] || fail "installed DSH version does not match the release lock"
[[ -r "${runtime_home}/apps/cli/src/bin.ts" ]] || fail "DSH CLI source entry is missing"
[[ -r "${runtime_home}/packages/bundle/acp-app/cordis.patch.yml" ]] || fail "DSH ACP profile bundle is missing"
[[ -d "${runtime_home}/node_modules/tsx" ]] || fail "DSH dependencies are not installed"
[[ -r "${runtime_home}/apps/cli/lib/bin.js" ]] || fail "DSH CLI build output is missing; run its locked build"
if [[ -n "$(git -C "${runtime_home}" status --porcelain --untracked-files=no)" ]]; then
  fail "DSH tracked files are modified; production requires the locked clean checkout"
fi

dsh_preflight_root=$(mktemp -d "${TMPDIR:-/tmp}/dsh-work-deploy-preflight.XXXXXX")
if ! (
  cd "${release_dir}"
  "${node_bin}" --input-type=module -e '
    const { preflightDshRuntime, resolveDshRuntimeInstallation } = await import(
      "./server/dist/modules/runtime/dsh-runtime-installation.js"
    )
    const env = {
      ...process.env,
      DSH_WORK_DATA_ROOT: process.argv[2],
      DSH_WORK_DSH_SESSIONS_ROOT: process.argv[3],
    }
    const installation = await resolveDshRuntimeInstallation({ projectRoot: process.argv[1], env })
    await preflightDshRuntime(installation)
  ' "${release_dir}" "${dsh_preflight_root}" "${dsh_preflight_root}/sessions"
); then
  rm -rf "${dsh_preflight_root}"
  fail "installed DSH failed ACP initialize/session creation; verify its Node version, locked build and DSH_HOME credentials"
fi
rm -rf "${dsh_preflight_root}"

runtime_mode=$(stat -f '%Lp' "${runtime_env}")
if (( (8#${runtime_mode} & 8#077) != 0 )); then
  fail "${runtime_env} must not be readable or writable by group/others; run chmod 600"
fi

available_kib=$(df -Pk "${deploy_root}" | awk 'NR==2 {print $4}')
(( available_kib >= 5 * 1024 * 1024 )) || fail "at least 5 GiB free disk space is required"

if [[ "${external_endpoint_candidate}" != true ]]; then
  mv "${candidate_endpoint_compose}" "${deploy_root}/generated/compose.endpoints.yaml"
fi
trap - EXIT
echo "preflight passed for ${release_dir}"
