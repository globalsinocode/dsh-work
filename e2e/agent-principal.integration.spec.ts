import { expect, test } from '@playwright/test'

type Principal = {
  principalId: string
  agentId: string
  status: 'active' | 'disabled'
  authorizationVersion: number
  roleIds: string[]
  dataScopes: string[]
}

test('AE-02 administrator governs an independent Agent executor without changing the human requester', async ({ page }) => {
  const agentId = 'agent-dsh-work-assistant'
  const versionId = 'agent-version-dsh-work-assistant-1'
  const roles = await page.request.get('/api/admin/v1/agents/principal-role-options')
  expect(roles.ok()).toBeTruthy()
  expect((await roles.json()).data).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'role-employee', status: 'active' }),
  ]))
  await page.goto('/agents')
  await page.getByRole('row').filter({ hasText: 'dsh-work' }).first().click()
  const drawer = page.locator('.el-drawer').filter({ hasText: 'Agent 治理详情' })
  const identity = drawer.locator('section').filter({ hasText: '独立执行身份' }).first()
  await expect(identity).toContainText(`principal-agent-${agentId}`)
  await expect(identity.getByText('普通员工')).toBeVisible()

  const evidence = async () => {
    const response = await page.request.get(`/api/admin/v1/test/agent-principal/evidence?agent_version_id=${versionId}`)
    expect(response.ok()).toBeTruthy()
    return (await response.json()).data as { allowed: boolean; executorPrincipalId?: string }
  }
  expect(await evidence()).toMatchObject({ allowed: true, executorPrincipalId: `principal-agent-${agentId}` })

  await identity.locator('.el-switch').click()
  await identity.getByRole('button', { name: '保存身份授权' }).click()
  await page.getByRole('button', { name: '确认更新' }).click()
  await expect.poll(async () => (await evidence()).allowed).toBe(false)

  await identity.locator('.el-switch').click()
  await identity.getByRole('button', { name: '保存身份授权' }).click()
  await page.getByRole('button', { name: '确认更新' }).click()
  await expect.poll(async () => (await evidence()).allowed).toBe(true)

  const currentResponse = await page.request.get(`/api/admin/v1/agents/${agentId}/principal`)
  expect(currentResponse.ok()).toBeTruthy()
  const current = (await currentResponse.json()).data as Principal
  const revoked = await page.request.patch(`/api/admin/v1/agents/${agentId}/principal`, {
    data: { expectedAuthorizationVersion: current.authorizationVersion, status: 'active',
      roleIds: current.roleIds, dataScopes: [] },
  })
  expect(revoked.ok(), await revoked.text()).toBeTruthy()
  // This existing version needs a scoped platform tool, so revoking its scope
  // still denies execution; a Soul-only Agent is covered by the creation case.
  await expect.poll(async () => (await evidence()).allowed).toBe(false)
  const latest = (await revoked.json()).data as Principal
  const stale = await page.request.patch(`/api/admin/v1/agents/${agentId}/principal`, {
    data: { expectedAuthorizationVersion: current.authorizationVersion, status: 'active',
      roleIds: current.roleIds, dataScopes: current.dataScopes },
  })
  expect(stale.status()).toBe(409)
  const restored = await page.request.patch(`/api/admin/v1/agents/${agentId}/principal`, {
    data: { expectedAuthorizationVersion: latest.authorizationVersion, status: 'active',
      roleIds: current.roleIds, dataScopes: current.dataScopes },
  })
  expect(restored.ok(), await restored.text()).toBeTruthy()
  await expect.poll(async () => (await evidence()).allowed).toBe(true)
})

test('AE-02 Principal remains manageable when the role option request fails', async ({ page }) => {
  await page.route('**/api/admin/v1/agents/principal-role-options', route => route.fulfill({ status: 503,
    contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: 'role directory unavailable' } }),
  }))
  await page.goto('/agents')
  await page.getByRole('row').filter({ hasText: 'dsh-work' }).first().click()
  const identity = page.locator('.el-drawer').locator('section').filter({ hasText: '独立执行身份' }).first()
  await expect(identity).toContainText('principal-agent-agent-dsh-work-assistant')
  await expect(identity.getByText('角色目录暂不可用')).toBeVisible()
  await identity.locator('.el-switch').click()
  await identity.getByRole('button', { name: '保存身份授权' }).click()
  await page.getByRole('button', { name: '确认更新' }).click()
  const status = async () => {
    const response = await page.request.get('/api/admin/v1/agents/agent-dsh-work-assistant/principal')
    return ((await response.json()).data as Principal).status
  }
  await expect.poll(status).toBe('disabled')
  await identity.locator('.el-switch').click()
  await identity.getByRole('button', { name: '保存身份授权' }).click()
  await page.getByRole('button', { name: '确认更新' }).click()
  await expect.poll(status).toBe('active')
})

test('AE-02 a basic Agent gets an independent executor without inheriting creator permissions', async ({ page }) => {
  await page.goto('/agents')
  await page.getByRole('button', { name: '创建 Agent' }).click()
  const dialog = page.getByRole('dialog', { name: '创建 Agent' })
  await dialog.getByLabel('Agent 名称').fill('无默认执行授权测试')
  await dialog.getByLabel('Agent 说明').fill('验证员工可见角色不会自动变成 AI 员工的执行授权。')
  await dialog.getByLabel('SOUL.md（人格与工作原则）').fill('你是测试 Agent，只处理本次明确提供的输入；需要业务系统数据时先要求授权。')
  await dialog.getByRole('button', { name: '下一步' }).click()
  await dialog.getByRole('button', { name: '权限与运行限制' }).click()
  await expect(dialog.getByText('可见性与定义范围')).toHaveCount(0)
  await expect(dialog.getByText('AI 员工执行授权')).toHaveCount(0)
  await dialog.getByRole('button', { name: '下一步' }).click()
  await dialog.getByRole('button', { name: '完成创建' }).click()
  await expect(page.getByRole('dialog', { name: 'Agent 草稿已保存' }))
    .toContainText('独立执行身份已自动创建，可直接进行基础试运行')
  const agents = await page.request.get('/api/admin/v1/agents')
  expect(agents.ok()).toBeTruthy()
  const created = ((await agents.json()).data as Array<{ id: string; name: string }>).find(item => item.name === '无默认执行授权测试')
  expect(created).toBeTruthy()
  const response = await page.request.get(`/api/admin/v1/agents/${created?.id}/principal`)
  expect(response.ok()).toBeTruthy()
  expect((await response.json()).data).toMatchObject({ status: 'active', roleIds: [], dataScopes: [] })

  await page.getByRole('dialog', { name: 'Agent 草稿已保存' })
    .getByRole('button', { name: '进入人工试运行验证' }).click()
  const publication = page.getByRole('region', { name: '发布范围' })
  await expect(publication).toContainText('发布前设置员工可见角色')
  await publication.getByText('选择发布后可使用 Agent 的员工角色').click()
  await page.getByRole('option', { name: '普通员工' }).click()
  await publication.getByRole('button', { name: '保存发布范围' }).click()
  await expect(publication).toContainText('1 个可见角色 · 0 个平台数据范围')
  const publishedScope = await page.request.get('/api/admin/v1/agents')
  expect(publishedScope.ok()).toBeTruthy()
  expect(((await publishedScope.json()).data as Array<{ id: string; roleIds: string[]; dataScopes: string[] }>)
    .find(item => item.id === created?.id)).toMatchObject({ roleIds: ['role-employee'], dataScopes: [] })
})
