#!/usr/bin/env bash
set -euo pipefail

deploy_root=${1:?Usage: install-launchd.sh DEPLOY_ROOT}
label=com.company.dsh-work.server
template="${deploy_root}/current/deploy/launchd/${label}.plist.template"
agents_directory="${HOME}/Library/LaunchAgents"
plist="${agents_directory}/${label}.plist"

if [[ ! -f "${template}" ]]; then
  echo "launchd template is missing: ${template}" >&2
  exit 1
fi
if [[ "${deploy_root}" == *['&<>']* ]]; then
  echo "deployment root cannot contain XML metacharacters: ${deploy_root}" >&2
  exit 1
fi

mkdir -p "${agents_directory}" "${deploy_root}/logs"
sed "s|__DEPLOY_ROOT__|${deploy_root}|g" "${template}" > "${plist}.new"
plutil -lint "${plist}.new" >/dev/null
chmod 600 "${plist}.new"
mv "${plist}.new" "${plist}"

service_target="gui/${UID}/${label}"
if launchctl print "${service_target}" >/dev/null 2>&1; then
  launchctl bootout "${service_target}" || true
  # bootout 是异步的：作业还没真正卸载就 bootstrap，launchd 会返回
  # "Bootstrap failed: 5: Input/output error"。2026-11-03 发 v2026.11.03-01 时
  # 就因此在这一步失败并把整个部署回滚，所以这里等作业卸载完再引导。
  for _attempt in {1..15}; do
    launchctl print "${service_target}" >/dev/null 2>&1 || break
    sleep 1
  done
fi
if ! launchctl bootstrap "gui/${UID}" "${plist}"; then
  # 卸载刚完成时 launchd 偶尔仍会短暂返回 EIO，等一拍再试一次。
  sleep 3
  launchctl bootstrap "gui/${UID}" "${plist}"
fi
launchctl enable "${service_target}"
launchctl kickstart -k "${service_target}"
