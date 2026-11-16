#!/usr/bin/env bash
# Plan, check, apply, or roll back endpoint-only dsh-work configuration.

set -euo pipefail

action=${1:-}
[[ -n "${action}" ]] || { echo 'Usage: set-macmini-endpoints.sh plan|check|apply|rollback ...' >&2; exit 2; }
shift
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
control_root=$(cd "${script_dir}/../.." && pwd)
deploy_root=${DSH_WORK_DEPLOY_ROOT:-${control_root}}
confirm=false
configure_args=()

fail() { printf 'set-macmini-endpoints: %s\n' "$1" >&2; exit 1; }
while (($# > 0)); do
  case "$1" in
    --deploy-root) deploy_root=${2:?}; shift 2 ;;
    --bind-address | --workbench-origin | --admin-origin | --workbench-default-origin | --admin-default-origin)
      configure_args+=("$1" "${2:?}"); shift 2 ;;
    --confirm) confirm=true; shift ;;
    -h | --help)
      printf '%s\n' \
        'Usage: bash scripts/deploy/set-macmini-endpoints.sh plan|check|apply|rollback' \
        '  [--deploy-root ABSOLUTE_PATH] [--bind-address PRIVATE_IPV4]...' \
        '  [--workbench-origin HTTPS_ORIGIN]... [--admin-origin HTTPS_ORIGIN]...' \
        '  [--workbench-default-origin HTTPS_ORIGIN] [--admin-default-origin HTTPS_ORIGIN]' \
        '  [--confirm]'
      exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done
[[ "${deploy_root}" == /* && "${deploy_root}" != / ]] || fail 'deploy root must be an absolute non-root path'
runtime_env="${deploy_root}/runtime.env"
current_release="${deploy_root}/current"
endpoint_compose="${deploy_root}/generated/compose.endpoints.yaml"
previous_env="${deploy_root}/runtime.env.before-endpoints"
previous_compose="${deploy_root}/generated/compose.endpoints.before-endpoints.yaml"
[[ -f "${runtime_env}" && ! -L "${runtime_env}" ]] || fail "runtime env not found: ${runtime_env}"
[[ -d "${current_release}" ]] || fail "active release not found: ${current_release}"

show_values() {
  grep -E '^(DSH_WORK_BIND_ADDRESS|DSH_WORK_BIND_ADDRESSES|DSH_WORK_WORKBENCH_ORIGINS|DSH_WORK_ADMIN_ORIGINS|DSH_WORK_WORKBENCH_DEFAULT_ORIGIN|DSH_WORK_ADMIN_DEFAULT_ORIGIN)=' "$1" || true
}
restart_active() {
  # This function is called from a conditional, where Bash disables errexit.
  "${current_release}/scripts/deploy/install-launchd.sh" "${deploy_root}" || return $?
  docker compose --env-file "${runtime_env}" -f "${current_release}/deploy/compose.yaml" \
    -f "${endpoint_compose}" up -d --wait --force-recreate web
}
verify_origins() {
  (
    set -a
    source "${runtime_env}"
    set +a
    values="${DSH_WORK_WORKBENCH_ORIGINS},${DSH_WORK_ADMIN_ORIGINS}"
    IFS=',' read -r -a origins <<<"${values}"
    for origin in "${origins[@]}"; do
      curl --fail --silent --show-error --cacert "${DSH_WORK_CA_CERT_FILE}" "${origin}/health" >/dev/null \
        || fail "health check failed for ${origin}"
    done
  )
}

if [[ "${action}" == rollback ]]; then
  [[ "${confirm}" == true ]] || fail 'rollback requires --confirm'
  [[ -f "${previous_env}" && -f "${previous_compose}" ]] || fail 'rollback snapshot is incomplete'
  lock_directory="${deploy_root}/.release.lock"
  mkdir "${lock_directory}" 2>/dev/null || fail 'another release or endpoint change is active'
  trap 'rm -f "${lock_directory}/pid"; rmdir "${lock_directory}" 2>/dev/null || true' EXIT
  printf '%s\n' "$$" >"${lock_directory}/pid"
  install -m 0600 "${previous_env}" "${runtime_env}"
  install -m 0600 "${previous_compose}" "${endpoint_compose}"
  restart_active
  verify_origins
  printf 'Rolled back dsh-work endpoint configuration.\n'
  exit 0
fi

case "${action}" in plan | check | apply) ;; *) fail "unsupported action: ${action}" ;; esac
((${#configure_args[@]} > 0)) || fail 'candidate actions require endpoint arguments'
candidate_env=$(mktemp "${deploy_root}/.runtime.endpoints.XXXXXX")
candidate_compose="${deploy_root}/generated/.compose.endpoints.candidate-$$.yaml"
cleanup() { rm -f "${candidate_env}" "${candidate_compose}"; }
trap cleanup EXIT
node_bin=$(sed -n 's/^DSH_WORK_NODE_BIN=//p' "${runtime_env}" | tail -n 1)
[[ -x "${node_bin}" ]] || fail 'configured Node executable is unavailable'
"${node_bin}" "${current_release}/scripts/deploy/configure-macmini-endpoints.mjs" \
  --env-file "${runtime_env}" --output "${candidate_env}" "${configure_args[@]}"
"${current_release}/scripts/deploy/render-endpoint-compose.sh" \
  "${deploy_root}" "${current_release}" "${candidate_compose}" "${candidate_env}" >/dev/null
printf '%s\n' 'Current endpoints:'; show_values "${runtime_env}"
printf '%s\n' 'Candidate endpoints:'; show_values "${candidate_env}"
[[ "${action}" != plan ]] || exit 0
"${current_release}/scripts/deploy/preflight.sh" \
  "${deploy_root}" "${current_release}" "${candidate_env}" "${candidate_compose}"
[[ "${action}" != check ]] || exit 0
[[ "${confirm}" == true ]] || fail 'apply requires --confirm'
lock_directory="${deploy_root}/.release.lock"
mkdir "${lock_directory}" 2>/dev/null || fail 'another release or endpoint change is active'
trap 'cleanup; rm -f "${lock_directory}/pid"; rmdir "${lock_directory}" 2>/dev/null || true' EXIT
printf '%s\n' "$$" >"${lock_directory}/pid"
install -m 0600 "${runtime_env}" "${previous_env}"
install -m 0600 "${endpoint_compose}" "${previous_compose}"
install -m 0600 "${candidate_env}" "${runtime_env}"
install -m 0600 "${candidate_compose}" "${endpoint_compose}"
if ! restart_active || ! verify_origins; then
  install -m 0600 "${previous_env}" "${runtime_env}"
  install -m 0600 "${previous_compose}" "${endpoint_compose}"
  restart_active || fail 'endpoint apply failed and automatic rollback could not restart the old configuration'
  fail 'endpoint apply failed; previous configuration restored'
fi
printf 'Applied dsh-work endpoint configuration.\n'
