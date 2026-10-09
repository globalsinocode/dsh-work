#!/usr/bin/env bash
set -euo pipefail

version=${1:?Usage: release.sh VERSION [DEPLOY_ROOT]}
version=${version#v}
umask 077

script_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source "${script_directory}/release-version.sh"
require_supported_release_version "${version}"
control_root=$(cd "${script_directory}/../.." && pwd)
deploy_root=${2:-${DSH_WORK_DEPLOY_ROOT:-${control_root}}}
runtime_env="${deploy_root}/runtime.env"
tag="v${version}"
bundle_name="dsh-work-${tag}"
release_dir="${deploy_root}/releases/${tag}"
artifact_dir="${deploy_root}/release-artifacts/${tag}"
archive="${artifact_dir}/${bundle_name}.tar.gz"
checksum="${artifact_dir}/${bundle_name}.tar.gz.sha256"
label=com.company.dsh-work.server
service_target="gui/${UID}/${label}"

[[ -r "${runtime_env}" ]] || { echo "missing ${runtime_env}; copy deploy/runtime.env.example and protect it with chmod 600" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "${runtime_env}"
set +a
[[ "${DSH_WORK_DEPLOY_ROOT:?Set DSH_WORK_DEPLOY_ROOT in runtime.env}" == "${deploy_root}" ]] \
  || { echo "runtime.env DSH_WORK_DEPLOY_ROOT does not match ${deploy_root}" >&2; exit 1; }

mkdir -p \
  "${deploy_root}/releases" \
  "${deploy_root}/release-artifacts" \
  "${deploy_root}/backups" \
  "${deploy_root}/data" \
  "${deploy_root}/logs"
if [[ -e "${deploy_root}/current" && ! -L "${deploy_root}/current" ]]; then
  echo "refusing to replace a non-symlink deployment path: ${deploy_root}/current" >&2
  exit 1
fi
lock_directory="${deploy_root}/.release.lock"
if ! mkdir "${lock_directory}" 2>/dev/null; then
  locked_pid=''
  [[ -r "${lock_directory}/pid" ]] && locked_pid=$(<"${lock_directory}/pid")
  if [[ "${locked_pid}" =~ ^[0-9]+$ ]] && kill -0 "${locked_pid}" 2>/dev/null; then
    echo "another release or rollback is active: ${lock_directory} (PID ${locked_pid})" >&2
    exit 1
  fi
  rm -f "${lock_directory}/pid"
  if ! rmdir "${lock_directory}" 2>/dev/null || ! mkdir "${lock_directory}" 2>/dev/null; then
    echo "cannot recover stale deployment lock: ${lock_directory}" >&2
    exit 1
  fi
fi
printf '%s\n' "$$" > "${lock_directory}/pid"

temporary_directory=''
cleanup() {
  if [[ -n "${temporary_directory}" && -d "${temporary_directory}" ]]; then
    rm -rf "${temporary_directory}"
  fi
  rm -f "${lock_directory}/pid"
  rmdir "${lock_directory}" 2>/dev/null || true
}
trap cleanup EXIT

command -v gh >/dev/null || { echo "GitHub CLI is required to verify public Release provenance" >&2; exit 1; }
gh auth status >/dev/null 2>&1 \
  || { echo "GitHub CLI is not authenticated; use a read-only credential for the public repository" >&2; exit 1; }
gh attestation verify --help | grep -F -- '--signer-workflow' >/dev/null \
  || { echo "GitHub CLI is too old for artifact provenance verification" >&2; exit 1; }

repository=${DSH_WORK_GITHUB_REPOSITORY:?Set DSH_WORK_GITHUB_REPOSITORY}
[[ "${repository}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] \
  || { echo "invalid GitHub repository: ${repository}" >&2; exit 1; }
temporary_directory=$(mktemp -d "${deploy_root}/.release-download.XXXXXX")
metadata_file="${temporary_directory}/release-metadata.json"
gh release view "${tag}" \
  --repo "${repository}" \
  --json tagName,targetCommitish,isDraft,isImmutable,isPrerelease,author,assets \
  > "${metadata_file}"

release_commit=$("${DSH_WORK_NODE_BIN:?Set DSH_WORK_NODE_BIN in runtime.env}" -e '
  const { readFileSync } = require("node:fs")
  const release = JSON.parse(readFileSync(process.argv[1], "utf8"))
  const expectedTag = process.argv[2]
  const expectedAssets = new Set([`dsh-work-${expectedTag}.tar.gz`, `dsh-work-${expectedTag}.tar.gz.sha256`])
  if (release.tagName !== expectedTag) throw new Error("GitHub Release tag mismatch")
  if (release.isDraft || release.isPrerelease) throw new Error("GitHub Release is not a stable published release")
  if (release.isImmutable !== true) throw new Error("GitHub Release immutability is not enabled")
  if (release.author?.login !== "github-actions[bot]") throw new Error("GitHub Release was not published by GitHub Actions")
  if (!/^[0-9a-f]{40}$/.test(release.targetCommitish ?? "")) throw new Error("GitHub Release target is not a commit SHA")
  for (const name of expectedAssets) {
    if ((release.assets ?? []).filter(asset => asset.name === name && asset.state === "uploaded").length !== 1) {
      throw new Error(`GitHub Release asset is missing or ambiguous: ${name}`)
    }
  }
  process.stdout.write(release.targetCommitish)
' "${metadata_file}" "${tag}")

gh release verify "${tag}" --repo "${repository}"

if [[ ! -d "${artifact_dir}" ]]; then
  mkdir "${temporary_directory}/artifacts"
  gh release download "${tag}" \
    --repo "${repository}" \
    --pattern "${bundle_name}.tar.gz" \
    --pattern "${bundle_name}.tar.gz.sha256" \
    --dir "${temporary_directory}/artifacts"
  (
    cd "${temporary_directory}/artifacts"
    shasum -a 256 -c "${bundle_name}.tar.gz.sha256"
  )
  mv "${temporary_directory}/artifacts" "${artifact_dir}"
fi

[[ -f "${archive}" && -f "${checksum}" ]] \
  || { echo "cached Release artifacts are incomplete: ${artifact_dir}" >&2; exit 1; }
(
  cd "${artifact_dir}"
  shasum -a 256 -c "${bundle_name}.tar.gz.sha256"
)
gh release verify-asset "${tag}" "${archive}" --repo "${repository}"
# 来源 ref 由构件自述（build-release.sh 写入 ${GITHUB_REF}），落白名单后才交给 attestation 校验。
# 白名单保留 main：既能继续安装上游官方 Release，也能安装我们自己的 release/* 发布线。
# 旧构件没有 sourceRef 字段时按 refs/heads/main 兜底 —— 与放行前的行为完全一致，
# 不放宽任何校验（attestation 仍要求签名 workflow 与 source-digest 匹配）。
release_payload_file="${temporary_directory}/release-payload.json"
tar -xzOf "${archive}" "${bundle_name}/release.json" > "${release_payload_file}"
release_source_ref=$("${DSH_WORK_NODE_BIN}" -e '
  const { readFileSync } = require("node:fs")
  const payload = JSON.parse(readFileSync(process.argv[1], "utf8"))
  const declared = payload.sourceRef
  process.stdout.write(typeof declared === "string" && declared.length > 0 ? declared : "refs/heads/main")
' "${release_payload_file}")
case "${release_source_ref}" in
  refs/heads/main|refs/heads/release/*) ;;
  *) echo "release source ref is not acceptable: ${release_source_ref}" >&2; exit 1 ;;
esac
gh attestation verify "${archive}" \
  --repo "${repository}" \
  --signer-workflow "${repository}/.github/workflows/release.yml" \
  --source-ref "${release_source_ref}" \
  --source-digest "${release_commit}" \
  --deny-self-hosted-runners

tar -xzf "${archive}" -C "${temporary_directory}"
extracted_release="${temporary_directory}/${bundle_name}"
[[ -f "${extracted_release}/release.json" ]] \
  || { echo "downloaded release is incomplete" >&2; exit 1; }

payload_version=$("${DSH_WORK_NODE_BIN:?Set DSH_WORK_NODE_BIN in runtime.env}" \
  -e "const p=require(process.argv[1]); process.stdout.write(p.version ?? '')" \
  "${extracted_release}/release.json")
[[ "${payload_version}" == "${version}" ]] \
  || { echo "release payload version ${payload_version} does not match requested ${version}" >&2; exit 1; }
payload_commit=$("${DSH_WORK_NODE_BIN}" \
  -e "const p=require(process.argv[1]); process.stdout.write(p.commit ?? '')" \
  "${extracted_release}/release.json")
[[ "${payload_commit}" == "${release_commit}" ]] \
  || { echo "release payload commit does not match immutable GitHub Release target" >&2; exit 1; }

old_release=''
if [[ -L "${deploy_root}/current" ]]; then
  [[ -d "${deploy_root}/current" ]] \
    || { echo "active release symlink is broken: ${deploy_root}/current" >&2; exit 1; }
  old_release=$(cd "${deploy_root}/current" && pwd -P)
fi
if [[ -L "${release_dir}" || ( -e "${release_dir}" && ! -d "${release_dir}" ) ]]; then
  echo "release path is not a regular directory: ${release_dir}" >&2
  exit 1
fi
if [[ -d "${release_dir}" ]]; then
  existing_release=$(cd "${release_dir}" && pwd -P)
  if [[ -n "${old_release}" && "${existing_release}" == "${old_release}" ]]; then
    echo "refusing to replace the active release directory: ${release_dir}" >&2
    exit 1
  fi
  stale_release="${temporary_directory}/stale-release"
  mv "${release_dir}" "${stale_release}"
  if ! mv "${extracted_release}" "${release_dir}"; then
    mv "${stale_release}" "${release_dir}"
    echo "failed to replace cached release directory: ${release_dir}" >&2
    exit 1
  fi
else
  mv "${extracted_release}" "${release_dir}"
fi

"${release_dir}/scripts/deploy/preflight.sh" "${deploy_root}" "${release_dir}"
compose_file="${release_dir}/deploy/compose.yaml"
endpoint_compose="${deploy_root}/generated/compose.endpoints.yaml"
state_root="${deploy_root}/automation/state"
mkdir -p "${state_root}"

run_compose() {
  local base_file=$1
  shift
  docker compose --env-file "${runtime_env}" -f "${base_file}" -f "${endpoint_compose}" "$@"
}

restart_old_release() {
  if [[ -z "${old_release}" || ! -d "${old_release}" ]]; then
    if launchctl print "${service_target}" >/dev/null 2>&1; then
      launchctl bootout "${service_target}"
    fi
    run_compose "${compose_file}" stop web >/dev/null 2>&1 || true
    echo "no previous release is available; the failed first deployment was stopped" >&2
    return
  fi
  ln -sfn "${old_release}" "${deploy_root}/current"
  run_compose "${old_release}/deploy/compose.yaml" up -d --wait postgres
  "${old_release}/scripts/deploy/install-launchd.sh" "${deploy_root}"
  run_compose "${old_release}/deploy/compose.yaml" up -d --wait --force-recreate web
  echo "application files rolled back to ${old_release}; database migrations were not downgraded" >&2
}

mark_attempted() {
  printf '%s\n' "${tag}" > "${state_root}/attempted-release.new"
  mv "${state_root}/attempted-release.new" "${state_root}/attempted-release"
}

if [[ -n "${old_release}" && -d "${old_release}" ]]; then
  if launchctl print "${service_target}" >/dev/null 2>&1; then
    launchctl bootout "${service_target}"
  fi
  if ! "${old_release}/scripts/deploy/backup.sh" "${deploy_root}" "${old_release}"; then
    echo "pre-release backup failed" >&2
    restart_old_release
    exit 1
  fi
  mark_attempted
  if ! run_compose "${compose_file}" up -d --wait postgres; then
    echo "candidate PostgreSQL configuration failed after the backup" >&2
    restart_old_release
    exit 1
  fi
else
  run_compose "${compose_file}" up -d --wait postgres
  mark_attempted
fi

node_bin=${DSH_WORK_NODE_BIN:?Set DSH_WORK_NODE_BIN in runtime.env}
if ! (
  cd "${release_dir}"
  "${node_bin}" server/dist/infrastructure/postgres/migrate.js
); then
  echo "database migration failed; the active release was not changed" >&2
  restart_old_release
  exit 1
fi

ln -sfn "${release_dir}" "${deploy_root}/current"
if [[ -n "${old_release}" && -d "${old_release}" && "${old_release}" != "${release_dir}" ]]; then
  ln -sfn "${old_release}" "${deploy_root}/previous"
fi

if ! "${release_dir}/scripts/deploy/install-launchd.sh" "${deploy_root}"; then
  restart_old_release
  exit 1
fi
if ! run_compose "${compose_file}" up -d --wait --force-recreate web; then
  restart_old_release
  exit 1
fi

workbench_origin=${DSH_WORK_WORKBENCH_DEFAULT_ORIGIN:-${AI_HUB_WORKBENCH_PORTAL_URL:?Set the workbench default Origin}}
admin_origin=${DSH_WORK_ADMIN_DEFAULT_ORIGIN:-${AI_HUB_ADMIN_PORTAL_URL:?Set the admin default Origin}}
health_url="${workbench_origin%/}/health"
healthy=false
for _attempt in {1..30}; do
  if curl --fail --silent --show-error --cacert "${DSH_WORK_CA_CERT_FILE}" "${health_url}" >/dev/null; then
    healthy=true
    break
  fi
  sleep 2
done
if [[ "${healthy}" != true ]]; then
  echo "release health check failed: ${health_url}" >&2
  restart_old_release
  exit 1
fi

printf '%s\n' "${tag}" > "${deploy_root}/active-release.new"
mv "${deploy_root}/active-release.new" "${deploy_root}/active-release"
rm -f "${state_root}/attempted-release"
echo "release activated: ${tag}"
echo "workbench: ${workbench_origin%/}/workbench"
echo "admin: ${admin_origin%/}/overview"
