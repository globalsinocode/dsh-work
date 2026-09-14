import { describe, expect, it } from 'vitest'

import { buildInfo, shortCommit } from './build-info'

describe('build info', () => {
  it('exposes the release and locked runtime metadata injected at build time', () => {
    expect(buildInfo.application).toBe('dsh-work 管理平台')
    expect(buildInfo.releaseVersion).toMatch(/^\d{4}\.\d{2}\.\d{2}-\d{2}$|^开发构建$/)
    expect(buildInfo.buildCommit).toMatch(/^[0-9a-f]{40}$|^开发构建$/)
    expect(buildInfo.dshVersion).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$|^—$/)
    expect(buildInfo.dshCommit).toMatch(/^[0-9a-f]{40}$|^—$/)
    expect([1, '—']).toContain(buildInfo.dshProtocolVersion)
  })

  it('shortens only full Git commit SHAs', () => {
    expect(shortCommit('a'.repeat(40))).toBe('a'.repeat(12))
    expect(shortCommit('开发构建')).toBe('开发构建')
  })
})
