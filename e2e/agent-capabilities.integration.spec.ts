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
  await create.getByRole('textbox', { name: 'Agent 说明' }).fill('验证工作规程、内置工具装配与 MCP Connector 选择随 Agent 草稿保存。')
  await create.getByRole('textbox', { name: /SOUL\.md/ }).fill('你是独立的 AI 员工，只能处理获准的业务数据，并为每个结论留下可核对的依据。')
  await create.getByRole('button', { name: '创建并继续配置' }).click()

  // 草稿编辑流程自动保存：工作规程与 MCP 选择不需要点击保存。
  await expect(page).toHaveURL(/\/draft\?step=profile$/)
  const status = page.getByTestId('draft-save-status')
  await page.getByRole('region', { name: '职责与人格' }).getByRole('textbox', { name: /AGENTS\.md/ }).fill(procedures)
  await expect(status).toHaveText('已保存')
  await page.getByRole('button', { name: '下一步：能力' }).click()
  const capabilities = page.getByRole('region', { name: '能力' })
  await capabilities.getByRole('radio', { name: '仅使用选定 MCP' }).press('Space')
  const choice = capabilities.getByRole('combobox', { name: '选择 MCP Connector' })
  await choice.press('Enter')
  await expect(page.getByRole('option', { name: new RegExp(connectorName) })).toBeVisible()
  await choice.press('ArrowDown')
  await choice.press('Enter')
  await expect(capabilities.getByText(connectorName, { exact: true })).toBeVisible()

  const agents = await data<Array<{ id: string; name: string }>>(await page.request.get('/api/admin/v1/agents'))
  const agentId = agents.find(item => item.name === name)?.id
  expect(agentId).toBeTruthy()
  type Version = { id: string; agentId: string; version: string; mcpScope: { mode: string; connectorIds: string[] } }
  const draftVersion = async () => (await data<Version[]>(await page.request.get('/api/admin/v1/agent-versions')))
    .find(item => item.agentId === agentId)
  await expect.poll(async () => (await draftVersion())?.mcpScope).toEqual({ mode: 'selected', connectorIds: [connector.id] })
  await expect(status).toHaveText('已保存')
  const version = await draftVersion()
  // 退出编辑回到只读详情页。草稿尚未发布：版本历史只列出草稿，没有回滚目标。
  await page.getByRole('button', { name: '退出编辑' }).click()
  await page.getByRole('tab', { name: '版本历史' }).click()
  const history = page.getByRole('region', { name: '版本历史' })
  await expect(history.getByRole('row', { name: new RegExp(`v${version!.version}`) })).toContainText('草稿')
  await expect(history.getByRole('button', { name: '回滚至此' })).toHaveCount(0)
  const evidence = async () => data<{ systemPrompt: string; runtimeTools: string[]; mcpConnectorIds: string[] }>(
    await page.request.get(`/api/admin/v1/test/agent-capabilities/evidence?version_id=${version!.id}`),
  )
  expect(await evidence()).toMatchObject({ mcpConnectorIds: [connector.id] })
  expect((await evidence()).systemPrompt).toContain(procedures)
  expect((await evidence()).runtimeTools).toEqual(expect.arrayContaining(['read', 'write']))
  expect((await evidence()).runtimeTools).not.toContain('web_search')

  const another = await data<{ id: string }>(await page.request.post('/api/admin/v1/connectors/mcp', {
    data: { name: `P1 新增连接 ${suffix}`, endpoint: 'https://new-capability.example.test/mcp',
      authType: 'none', scopeDescription: '新登记的连接器不会自动进入任何 Agent' },
  }))
  expect((await evidence()).mcpConnectorIds).toEqual([connector.id])
  const unselectedEvidence = await data<{ mcpConnectorIds: string[] }>(await page.request.get(
    '/api/admin/v1/test/agent-capabilities/evidence?version_id=agent-version-dsh-work-assistant-1',
  ))
  expect(unselectedEvidence.mcpConnectorIds).not.toContain(another.id)

  await data(await page.request.patch('/api/admin/v1/connectors/mcp/status', {
    data: { connectorId: connector.id, status: 'disabled' },
  }))
  const blocked = await page.request.get(`/api/admin/v1/test/agent-capabilities/evidence?version_id=${version!.id}`)
  expect(blocked.ok()).toBe(false)
  expect(await blocked.text()).toContain('已选 MCP Connector 不可用')
})
