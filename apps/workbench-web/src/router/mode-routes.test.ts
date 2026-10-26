import { describe, expect, it } from 'vitest'

import router from './index'
import { locationForMode, routeMode } from './mode-routes'
import type { UiMode } from '@/types/domain'

/** 把地址解析成路由后按目标模式映射，返回映射后的完整地址；不需要映射时为 undefined。 */
function mapped(path: string, mode: UiMode) {
  const target = locationForMode(router.resolve(path), mode)
  return target === undefined ? undefined : router.resolve(target).fullPath
}

// 重定向记录（`/`、`/c`、`/tasks/:id`）在守卫之前解析，守卫只看到重定向后的路由；
// 这些入口由 e2e/collab-mode.spec.ts 在浏览器中覆盖。
describe('employee mode route mapping (project space plan 12.5)', () => {
  it('maps work-mode links to their collaboration counterparts', () => {
    expect(mapped('/workbench', 'collab')).toBe('/c/chats')
    expect(mapped('/workbench?new=123', 'collab')).toBe('/c/chats')
    expect(mapped('/workbench?agent=agent-ops', 'collab')).toBe('/c/chats/agent/agent-ops')
    expect(mapped('/workbench?skill=skill-a', 'collab')).toBe('/c/chats?skill=skill-a')
    expect(mapped('/conversations/run-1', 'collab')).toBe('/c/chats?conversation=run-1')
    expect(mapped('/workspaces', 'collab')).toBe('/c/groups')
    expect(mapped('/agents', 'collab')).toBe('/c/agents')
    expect(mapped('/workspaces/ws-supply', 'collab')).toBe('/c/chats/group/ws-supply')
    expect(mapped('/workspaces/ws-supply?tab=files', 'collab')).toBe('/c/chats/group/ws-supply?tab=files')
    expect(mapped('/workspaces/ws-supply?tab=conversation', 'collab')).toBe('/c/chats/group/ws-supply?tab=chat')
    expect(mapped('/workspaces/ws-supply?tab=unknown', 'collab')).toBe('/c/chats/group/ws-supply')
    expect(mapped('/workspaces/ws-supply/tasks/task-7', 'collab')).toBe('/c/chats/group/ws-supply/tasks/task-7')
    expect(mapped('/workspaces/ws-supply/tasks/task-7/thread/run-9', 'collab'))
      .toBe('/c/chats/group/ws-supply/tasks/task-7/thread/run-9')
    expect(mapped('/workspaces/ws-supply/conversations/run-3', 'collab'))
      .toBe('/c/chats/group/ws-supply/conversations/run-3')
  })

  it('maps collaboration links back to work mode', () => {
    expect(mapped('/c/chats', 'work')).toBe('/workbench')
    expect(mapped('/c/chats?skill=skill-a', 'work')).toBe('/workbench?skill=skill-a')
    expect(mapped('/c/chats?conversation=run-1', 'work')).toBe('/conversations/run-1')
    expect(mapped('/c/chats/agent/agent-ops', 'work')).toBe('/workbench?agent=agent-ops')
    expect(mapped('/c/chats/agent/agent-ops?session=session-1', 'work')).toBe('/conversations/session-1')
    expect(mapped('/c/chats/group/ws-supply', 'work')).toBe('/workspaces/ws-supply')
    expect(mapped('/c/chats/group/ws-supply?tab=chat', 'work')).toBe('/workspaces/ws-supply?tab=conversation')
    expect(mapped('/c/chats/group/ws-supply?tab=archive&info=1', 'work')).toBe('/workspaces/ws-supply?tab=archive')
    expect(mapped('/c/chats/group/ws-supply?tab=tasks&task=task-7', 'work')).toBe('/workspaces/ws-supply/tasks/task-7')
    expect(mapped('/c/chats/group/ws-supply/tasks/task-7', 'work')).toBe('/workspaces/ws-supply/tasks/task-7')
    expect(mapped('/c/chats/group/ws-supply/tasks/task-7/thread/run-9', 'work')).toBe('/workspaces/ws-supply/tasks/task-7/thread/run-9')
    expect(mapped('/c/chats/group/ws-supply/conversations/run-3', 'work')).toBe('/workspaces/ws-supply/conversations/run-3')
    expect(mapped('/c/chats/group/ws-supply?conversation=run-3', 'work')).toBe('/workspaces/ws-supply/conversations/run-3')
    expect(mapped('/c/chats/group/ws-supply?session=s-3', 'work')).toBe('/workspaces/ws-supply/conversations/s-3')
    expect(mapped('/c/groups', 'work')).toBe('/workspaces')
    expect(mapped('/c/groups/ws-supply', 'work')).toBe('/workspaces/ws-supply')
    expect(mapped('/c/agents', 'work')).toBe('/agents')
    expect(mapped('/c/agents/agent-ops', 'work')).toBe('/agents')
    expect(mapped('/c/unknown/page', 'work')).toBe('/workbench')
  })

  it('round-trips workspace tabs and tasks without losing the place', () => {
    for (const path of [
      '/workspaces/ws-supply',
      '/workspaces/ws-supply?tab=files',
      '/workspaces/ws-supply?tab=artifacts',
      '/workspaces/ws-supply?tab=archive',
      '/workspaces/ws-supply?tab=conversation',
      '/workspaces/ws-supply/tasks/task-7',
      '/workspaces/ws-supply/conversations/run-3',
      '/conversations/run-1',
      '/workbench?agent=agent-ops',
    ]) {
      expect(mapped(mapped(path, 'collab')!, 'work')).toBe(path)
    }
  })

  it('keeps shared pages and same-mode links unchanged', () => {
    for (const path of ['/automations', '/settings', '/skills', '/files?source=material', '/history', '/sessions/s-1', '/missing-page']) {
      expect(mapped(path, 'collab')).toBeUndefined()
      expect(mapped(path, 'work')).toBeUndefined()
      expect(routeMode(router.resolve(path))).toBeUndefined()
    }
    expect(mapped('/workbench', 'work')).toBeUndefined()
    expect(mapped('/c/chats', 'collab')).toBeUndefined()
    expect(mapped('/c/unknown/page', 'collab')).toBeUndefined()
  })

  it('escapes identifiers instead of building paths from raw text', () => {
    expect(mapped('/workspaces/ws%2Fx/tasks/t%201', 'collab')).toBe('/c/chats/group/ws%2Fx/tasks/t%201')
  })
})
