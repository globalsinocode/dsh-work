import { expect, test } from '@playwright/test'

type Access = {
  agentId: string
  revision: number
  principalId: string
  principalStatus: 'active' | 'disabled'
  visibleRoleIds: string[]
  roleIds: string[]
  dataScopes: string[]
}

const accessPath = (agentId: string) => `/api/admin/v1/agents/${agentId}/access`

test('AE-02 administrator governs an independent Agent executor without changing the human requester', async ({ page }) => {
  const agentId = 'agent-dsh-work-assistant'
  const versionId = 'agent-version-dsh-work-assistant-1'
  await page.goto('/agents')
  await page.getByRole('row').filter({ hasText: 'dsh-work' }).first().click()
  await page.getByRole('tab', { name: '岗位权限' }).click()
  await expect(page).toHaveURL(/section=access/)
  const access = page.getByRole('tabpanel', { name: '岗位权限' }).getByRole('region', { name: '岗位权限' })
  await expect(access.getByTestId('agent-access-overview')).toContainText('普通员工')
  await expect(access.getByTestId('agent-access-overview')).toContainText('可以向它请求工作')

  const evidence = async () => {
    const response = await page.request.get(`/api/admin/v1/test/agent-principal/evidence?agent_version_id=${versionId}`)
    expect(response.ok()).toBeTruthy()
    return (await response.json()).data as { allowed: boolean; executorPrincipalId?: string; dataScopes?: string[] }
  }
  expect(await evidence()).toMatchObject({ allowed: true, executorPrincipalId: `principal-agent-${agentId}` })

  await access.locator('.el-switch').click()
  await access.getByRole('button', { name: '保存岗位权限' }).click()
  await page.getByRole('button', { name: '确认更新' }).click()
  await expect.poll(async () => (await evidence()).allowed).toBe(false)
  await expect(access.getByTestId('agent-access-overview')).toContainText('执行身份已停用')

  await access.locator('.el-switch').click()
  await access.getByRole('button', { name: '保存岗位权限' }).click()
  await page.getByRole('button', { name: '确认更新' }).click()
  await expect.poll(async () => (await evidence()).allowed).toBe(true)

  const currentResponse = await page.request.get(accessPath(agentId))
  expect(currentResponse.ok()).toBeTruthy()
  const current = (await currentResponse.json()).data as Access
  const revoked = await page.request.patch(accessPath(agentId), {
    data: { expectedRevision: current.revision, visibleRoleIds: current.visibleRoleIds,
      roleIds: current.roleIds, dataScopes: [] },
  })
  expect(revoked.ok(), await revoked.text()).toBeTruthy()
  // The default read tool is confined to the Run workspace. Revoking business
  // scopes does not disable it, and the authorization decision cannot restore them.
  await expect.poll(evidence).toMatchObject({
    allowed: true, executorPrincipalId: `principal-agent-${agentId}`, dataScopes: [],
  })
  const latest = (await revoked.json()).data as Access
  expect(latest.dataScopes).toEqual([])
  const stale = await page.request.patch(accessPath(agentId), {
    data: { expectedRevision: current.revision, visibleRoleIds: current.visibleRoleIds,
      roleIds: current.roleIds, dataScopes: current.dataScopes },
  })
  expect(stale.status()).toBe(409)
  const restored = await page.request.patch(accessPath(agentId), {
    data: { expectedRevision: latest.revision, visibleRoleIds: current.visibleRoleIds,
      roleIds: current.roleIds, dataScopes: current.dataScopes },
  })
  expect(restored.ok(), await restored.text()).toBeTruthy()
  await expect.poll(async () => (await evidence()).allowed).toBe(true)
})

test('AE-02 access panel reports a read failure and recovers on retry', async ({ page }) => {
  let failing = true
  await page.route('**/api/admin/v1/agents/agent-dsh-work-assistant/access', async route => {
    if (failing && route.request().method() === 'GET') {
      await route.fulfill({ status: 503, contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'unavailable', message: '岗位权限暂不可用' } }) })
      return
    }
    await route.continue()
  })
  await page.goto('/agents/agent-dsh-work-assistant?section=access')
  const access = page.getByRole('tabpanel', { name: '岗位权限' }).getByRole('region', { name: '岗位权限' })
  await expect(access).toContainText('岗位权限暂不可用')
  failing = false
  await access.getByRole('button', { name: '重新读取' }).click()
  await expect(access.getByTestId('agent-access-overview')).toContainText('可以向它请求工作')
})

test('AE-02 a basic Agent gets an independent executor without inheriting creator permissions', async ({ page }) => {
  await page.goto('/agents')
  await page.getByRole('button', { name: '创建 Agent' }).click()
  const dialog = page.getByRole('dialog', { name: '创建 Agent' })
  await dialog.getByLabel('Agent 名称').fill('无默认执行授权测试')
  await dialog.getByLabel('Agent 说明').fill('验证员工可见角色不会自动变成 AI 员工的执行授权。')
  await dialog.getByLabel('SOUL.md（人格与工作原则）').fill('你是测试 Agent，只处理本次明确提供的输入；需要业务系统数据时先要求授权。')
  await expect(dialog.getByText('可见性与定义范围')).toHaveCount(0)
  await expect(dialog.getByText('AI 员工执行授权')).toHaveCount(0)
  await dialog.getByRole('button', { name: '创建并继续配置' }).click()
  await expect(page.getByRole('heading', { name: '无默认执行授权测试' })).toBeVisible()
  await expect(page.getByRole('tab', { name: '职责与人格', selected: true })).toBeVisible()
  const agents = await page.request.get('/api/admin/v1/agents')
  expect(agents.ok()).toBeTruthy()
  const created = ((await agents.json()).data as Array<{ id: string; name: string }>).find(item => item.name === '无默认执行授权测试')
  expect(created).toBeTruthy()
  const response = await page.request.get(accessPath(created!.id))
  expect(response.ok()).toBeTruthy()
  expect((await response.json()).data).toMatchObject({
    principalStatus: 'active', visibleRoleIds: [], roleIds: [], dataScopes: [],
  })

  await page.getByRole('tab', { name: '验证与发布' }).click()
  const card = page.getByRole('region', { name: '岗位权限摘要' })
  await expect(card).toContainText('还没有设置可见角色')
  await card.getByRole('button', { name: '调整' }).click()
  await expect(page.getByRole('tab', { name: '岗位权限', selected: true })).toBeVisible()
  const panel = page.getByRole('tabpanel', { name: '岗位权限' }).getByRole('region', { name: '岗位权限' })
  await panel.getByText('选择可以使用该 Agent 的员工角色').click()
  await page.getByRole('option', { name: '普通员工' }).click()
  await panel.getByRole('button', { name: '保存岗位权限' }).click()
  await page.getByRole('button', { name: '确认更新' }).click()
  await expect(panel.getByTestId('agent-access-overview')).toContainText('普通员工')
  await page.getByRole('tab', { name: '验证与发布' }).click()
  await expect(card).toContainText('1 个可见角色 · 0 个岗位角色 · 0 个数据范围')
  const updated = await page.request.get(accessPath(created!.id))
  expect((await updated.json()).data).toMatchObject({ visibleRoleIds: ['role-employee'], roleIds: [], dataScopes: [] })
  const listed = await page.request.get('/api/admin/v1/agents')
  expect(((await listed.json()).data as Array<{ id: string; roleIds: string[] }>)
    .find(item => item.id === created?.id)).toMatchObject({ roleIds: ['role-employee'] })
})
