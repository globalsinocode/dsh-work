import { describe, expect, it } from 'vitest'

import { moduleLevelsOf, permissionTags, permissionsBeyond } from './admin-modules'

describe('admin module helpers', () => {
  it('reads module levels from module codes and the legacy all-module codes', () => {
    expect(moduleLevelsOf(['admin:knowledge:write']).knowledge).toBe('write')
    expect(moduleLevelsOf(['admin:knowledge:write']).agent).toBe('none')
    expect(moduleLevelsOf(['admin:read']).identity).toBe('read')
    expect(moduleLevelsOf(['admin:write']).dingtalk).toBe('write')
    expect(moduleLevelsOf(['admin:write']).ops).toBe('read')
    expect(moduleLevelsOf(['admin:*']).org).toBe('write')
  })

  it('flags permissions beyond the actor after expanding implied codes', () => {
    expect(permissionsBeyond(['admin:knowledge:read', 'knowledge:docs'], ['admin:knowledge:write', 'knowledge:bases'])).toEqual([])
    expect(permissionsBeyond(['admin:agent:write'], ['admin:agent:read'])).toEqual(['admin:agent:write'])
    expect(permissionsBeyond(['anything'], ['admin:*'])).toEqual([])
  })

  it('shows module tags first and other permissions by name', () => {
    expect(permissionTags(['admin:knowledge:write', 'workbench:use'], { 'workbench:use': '使用员工工作台' }))
      .toEqual(['企业知识库·修改', '使用员工工作台'])
    expect(permissionTags(['admin:*', 'workbench:use'], {})).toEqual(['全部权限（admin:*）'])
  })
})
