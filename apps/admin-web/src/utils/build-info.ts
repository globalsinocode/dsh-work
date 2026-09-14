const injectedReleaseVersion = typeof __DSH_WORK_RELEASE_VERSION__ === 'undefined'
  ? '开发构建'
  : __DSH_WORK_RELEASE_VERSION__
const injectedBuildCommit = typeof __DSH_WORK_BUILD_COMMIT__ === 'undefined'
  ? '开发构建'
  : __DSH_WORK_BUILD_COMMIT__
const injectedDshVersion = typeof __DSH_WORK_DSH_VERSION__ === 'undefined'
  ? '—'
  : __DSH_WORK_DSH_VERSION__
const injectedDshCommit = typeof __DSH_WORK_DSH_COMMIT__ === 'undefined'
  ? '—'
  : __DSH_WORK_DSH_COMMIT__
const injectedDshProtocolVersion = typeof __DSH_WORK_DSH_PROTOCOL_VERSION__ === 'undefined'
  ? '—'
  : __DSH_WORK_DSH_PROTOCOL_VERSION__

export const buildInfo = {
  application: 'dsh-work 管理平台',
  releaseVersion: injectedReleaseVersion,
  buildCommit: injectedBuildCommit,
  dshVersion: injectedDshVersion,
  dshCommit: injectedDshCommit,
  dshProtocolVersion: injectedDshProtocolVersion,
} as const

export function shortCommit(commit: string) {
  return /^[0-9a-f]{40}$/.test(commit) ? commit.slice(0, 12) : commit
}
