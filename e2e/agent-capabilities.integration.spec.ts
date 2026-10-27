import { randomUUID } from 'node:crypto'
import { expect, test, type APIResponse } from '@playwright/test'

async function data<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBeTruthy()
  return (await response.json()).data as T
}

test('P1 Agent work procedures, default tools, and MCP scopes use the same persisted definition', async ({ page }) => {
  const suffix = randomUUID().slice(0, 8)
  const name = `P1 能力装配 ${suffix}`
  const connectorName = `P1 能力连接 ${suffix}`
  const procedures = '先核对授权数据的来源，再选择必要工具；保留调用证据，无法确认的结论必须交给人工复核。'
  const connector = await data<{ id: string }>(await page.request.post('/api/admin/v1/connectors/mcp', {
    data: { name: connectorName, endpoint: 'https://agent-capabilities.example.test/mcp',
      authType: 'none', scopeDescription: '隔离测试中可丢弃的合成客户数据' },
  }))

  await page.goto('/agents')
  await page.getByRole('button', { name: '创建 Agent' }).click()
  const create = page.getByRole('dialog', { name: '创建 Agent' })
  await create.getByRole('textbox', { name: 'Agent 名称' }).fill(name)
  await create.getByRole('textbox', { name: 'Agent 说明' }).fill('验证工作规程、默认 DSH 工具与 MCP Connector 选择随 Agent 草稿保存。')
  await create.getByRole('textbox', { name: /SOUL\.md/ }).fill('你是独立的 AI 员工，只能处理获准的业务数据，并为每个结论留下可核对的依据。')
  const agentCreatePosts: string[] = []
  page.on('request', request => {
    if (request.method() !== 'POST') return
    if (new URL(request.url()).pathname !== '/api/admin/v1/agents') return
    agentCreatePosts.push(request.postData() ?? '')
  })
  await create.getByRole('button', { name: '创建并继续配置' }).click()
  await expect(page).toHaveURL(/\/agents\/[^/]+\/draft\?step=profile/)
  expect(agentCreatePosts).toHaveLength(1)
  const createdDraft = JSON.parse(agentCreatePosts[0] ?? '') as { id?: string }
  expect(createdDraft.id).toBeTruthy()

  await page.getByRole('textbox', { name: /AGENTS\.md/ }).fill(procedures)
  await page.getByRole('button', { name: '能力', exact: true }).click()
  await page.getByRole('radio', { name: '仅使用选定 MCP' }).click()
  const choice = page.getByRole('combobox', { name: '选择 MCP Connector' })
  await choice.click()
  await page.getByRole('option', { name: new RegExp(connectorName) }).click()
  await expect(page.getByText('已保存', { exact: true })).toBeVisible()

  const versionCount = async (agentId: string) => {
    const listed = await data<Array<{ agentId: string }>>(await page.request.get('/api/admin/v1/agent-versions'))
    return listed.filter(item => item.agentId === agentId).length
  }
  const versionsBeforeConflict = await versionCount(createdDraft.id!)
  const conflict = await page.request.post('/api/admin/v1/agents', { data: createdDraft })
  expect(conflict.status()).toBe(409)
  expect(await versionCount(createdDraft.id!)).toBe(versionsBeforeConflict)

  const agents = await data<Array<{ id: string; name: string }>>(await page.request.get('/api/admin/v1/agents'))
  const agentId = agents.find(item => item.name === name)?.id
  expect(agentId).toBeTruthy()
  const versions = await data<Array<{ id: string; agentId: string; version: string; mcpScope: { mode: string; connectorIds: string[] } }>>(
    await page.request.get('/api/admin/v1/agent-versions'),
  )
  const version = versions.find(item => item.agentId === agentId)
  expect(version?.mcpScope).toEqual({ mode: 'selected', connectorIds: [connector.id] })
  const exported = await page.request.get(`/api/admin/v1/agents/${agentId}/versions/${version!.id}/package`)
  expect(exported.ok(), await exported.text()).toBeTruthy()
  expect(exported.headers()['content-type']).toContain('application/zip')
  expect((await exported.body()).subarray(0, 2).toString()).toBe('PK')
  await page.goto(`/agents/${agentId}`)
  await page.getByRole('tab', { name: /版本历史/ }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出包' }).click()
  expect((await download).suggestedFilename()).toBe(`${agentId}-v${version!.version}.zip`)
  const evidence = async () => data<{ systemPrompt: string; runtimeTools: string[]; mcpConnectorIds: string[] }>(
    await page.request.get(`/api/admin/v1/test/agent-capabilities/evidence?version_id=${version!.id}`),
  )
  expect(await evidence()).toMatchObject({ mcpConnectorIds: [connector.id] })
  expect((await evidence()).systemPrompt).toContain(procedures)
  expect((await evidence()).runtimeTools).toEqual(expect.arrayContaining(['read@1.0.0', 'write@1.0.0']))

  const another = await data<{ id: string }>(await page.request.post('/api/admin/v1/connectors/mcp', {
    data: { name: `P1 新增连接 ${suffix}`, endpoint: 'https://new-capability.example.test/mcp',
      authType: 'none', scopeDescription: '验证 all 动态集合与 selected 固定集合' },
  }))
  expect((await evidence()).mcpConnectorIds).toEqual([connector.id])
  const allEvidence = await data<{ mcpConnectorIds: string[] }>(await page.request.get(
    '/api/admin/v1/test/agent-capabilities/evidence?version_id=agent-version-dsh-work-assistant-1',
  ))
  expect(allEvidence.mcpConnectorIds).toEqual(expect.arrayContaining([connector.id, another.id]))

  await data(await page.request.patch('/api/admin/v1/connectors/mcp/status', {
    data: { connectorId: connector.id, status: 'disabled' },
  }))
  const blocked = await page.request.get(`/api/admin/v1/test/agent-capabilities/evidence?version_id=${version!.id}`)
  expect(blocked.ok()).toBe(false)
  expect(await blocked.text()).toContain('已选 MCP Connector 不可用或已变化')
})
