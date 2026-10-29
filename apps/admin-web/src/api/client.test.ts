import { afterEach, describe, expect, it, vi } from 'vitest'

import { AdminApiError, adminApi } from './client'

afterEach(() => vi.unstubAllGlobals())

describe('admin API client', () => {
  it('keeps permission failure details returned by the management API', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: 'permission_denied',
        message: '当前账号不是平台管理员',
        object: 'Runtime runtime-local-01',
        suggestion: '切换到平台管理员账号后重试。',
        traceId: 'trace-admin-001',
      },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } })))

    const error = await adminApi.getRuntimes().catch(cause => cause)
    expect(error).toBeInstanceOf(AdminApiError)
    expect(error).toMatchObject({
      status: 403,
      code: 'permission_denied',
      object: 'Runtime runtime-local-01',
      traceId: 'trace-admin-001',
    })
  })

  it('writes employee role assignments to the dsh-work identity API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { id: 'user-1', roles: [] },
      meta: { api: 'admin', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await adminApi.grantIdentityRole('user/1', { roleId: 'role-employee' })

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/v1/identity/users/user%2F1/roles',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ roleId: 'role-employee' }),
      }),
    )
  })

  it('uses server-side filters and pagination for the employee directory', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        items: [], total: 0, page: 2, pageSize: 20,
        summary: { synchronized: 0, active: 0, authorized: 0 },
      },
      meta: { api: 'admin', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await adminApi.getIdentityUsers({ query: '张 三', status: 'active', page: 2, pageSize: 20 })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/v1/identity/users?query=%E5%BC%A0+%E4%B8%89&status=active&page=2&page_size=20',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('uses the fixed Agent mutation routes and carries agentId in each body', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      data: { agent: {}, version: {} },
      meta: { api: 'admin', adapter: 'postgres', timestamp: new Date().toISOString() },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const draftInput = {
      agentId: 'agent/a',
      name: '更新后的 Agent',
      description: '验证固定 Agent 草稿路由。',
      owner: '平台组',
      department: '研发部',
      welcomeMessage: '你好',
      examplePrompts: ['介绍能力'],
      systemPrompt: '遵守当前授权边界完成任务。',
      maxOutputBytes: 65_536,
      maxToolCalls: 20,
      timeoutSeconds: 300,
      skills: [],
      changeSummary: '更新名称',
    }
    await adminApi.updateAgentDraft(draftInput)
    await adminApi.setAgentStatus({ agentId: 'agent/a', status: 'disabled' })
    await adminApi.rollbackAgent({ agentId: 'agent/a', version: '1.0.0' })

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/admin/v1/agents/draft', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify(draftInput),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/admin/v1/agents/status', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ agentId: 'agent/a', status: 'disabled' }),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/admin/v1/agents/rollback', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ agentId: 'agent/a', version: '1.0.0' }),
    }))
  })
})
