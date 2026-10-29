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
  await expect(page).toHaveURL(/\/draft\?step=profile$/)
  const steps = page.getByRole('navigation', { name: '编辑步骤' })
  await expect(steps.getByRole('button', { name: /职责与人格/ })).toHaveAttribute('aria-current', 'step')
  const agents = await page.request.get('/api/admin/v1/agents')
  expect(agents.ok()).toBeTruthy()
  const created = ((await agents.json()).data as Array<{ id: string; name: string }>).find(item => item.name === '无默认执行授权测试')
  expect(created).toBeTruthy()
  const response = await page.request.get(accessPath(created!.id))
  expect(response.ok()).toBeTruthy()
  expect((await response.json()).data).toMatchObject({
    principalStatus: 'active', visibleRoleIds: [], roleIds: [], dataScopes: [],
  })

  // 角色由管理员手动选择，不预填、不自动授予；未完成「角色与权限」不能进入验证与发布。
  await expect(steps.getByRole('button', { name: /角色与权限/ })).toHaveAccessibleName('3. 角色与权限，待设置')
  await steps.getByRole('button', { name: /验证与发布/ }).click()
  await expect(page.getByText('请先在「角色与权限」中选择可见角色和岗位角色')).toBeVisible()
  await expect(page).toHaveURL(/\/draft\?step=audience$/)
  const untouched = await page.request.get(accessPath(created!.id))
  expect((await untouched.json()).data).toMatchObject({ visibleRoleIds: [], roleIds: [], dataScopes: [] })
})

test('AE-02 the draft flow requires visible and job roles chosen by hand and saves them when leaving the step', async ({ page }) => {
  await page.goto('/agents')
  await page.getByRole('button', { name: '创建 Agent' }).click()
  const dialog = page.getByRole('dialog', { name: '创建 Agent' })
  await dialog.getByLabel('Agent 名称').fill('角色与权限步骤测试')
  await dialog.getByLabel('Agent 说明').fill('验证草稿流程中角色必填、手动选择，并随下一步保存。')
  await dialog.getByLabel('SOUL.md（人格与工作原则）').fill('你是测试 Agent，只处理本次明确提供的输入；需要业务系统数据时先要求授权。')
  await dialog.getByRole('button', { name: '创建并继续配置' }).click()
  await expect(page).toHaveURL(/\/draft\?step=profile$/)
  const created = ((await (await page.request.get('/api/admin/v1/agents')).json()).data as Array<{ id: string; name: string }>)
    .find(item => item.name === '角色与权限步骤测试')

  const steps = page.getByRole('navigation', { name: '编辑步骤' })
  await steps.getByRole('button', { name: /角色与权限/ }).click()
  const section = page.getByRole('region', { name: '角色与权限' })
  await expect(section.getByRole('button', { name: '保存岗位权限' })).toHaveCount(0)

  // 必填未完成时停留在本步并标出字段。
  await page.getByRole('button', { name: '下一步：验证与发布' }).click()
  await expect(section.getByText('请选择可以使用它的员工角色')).toBeVisible()
  await expect(section.getByText('请选择它持有的岗位角色')).toBeVisible()
  await expect(page).toHaveURL(/\/draft\?step=audience$/)

  // 多选下拉选择后点标题收起，避免两个下拉中同名选项冲突。
  const closeDropdown = async () => {
    await section.getByRole('heading', { name: '角色与权限' }).click()
    await expect(page.getByRole('listbox')).toHaveCount(0)
  }
  await section.getByText('选择可以使用该 Agent 的员工角色').click()
  await page.getByRole('option', { name: '普通员工' }).click()
  await closeDropdown()
  await section.getByRole('combobox', { name: '岗位角色' }).click()
  // 只做标记、不预选：含管理权限的角色标出风险；选择业务角色不提示改选。
  await expect(page.getByRole('option', { name: /平台管理员/ })).toContainText('含管理权限')
  await page.getByRole('option', { name: /普通员工/ }).click()
  await closeDropdown()
  await expect(section.getByTestId('role-privileged-warning')).toHaveCount(0)
  await section.getByText('不需要企业数据时可留空').click()
  await page.keyboard.type('workspace:authorized')
  await page.keyboard.press('Enter')
  await closeDropdown()

  await page.getByRole('button', { name: '下一步：验证与发布' }).click()
  await expect(page).toHaveURL(/\/draft\?step=release$/)
  await expect(page.getByRole('region', { name: '岗位权限摘要' })).toContainText('1 个可见角色 · 1 个岗位角色 · 1 个数据范围')
  // 服务端验证前检查同样要求岗位角色。
  await expect(page.getByRole('region', { name: '验证前检查' })).toContainText('岗位角色')
  await expect(page.getByRole('region', { name: '验证前检查' })).toContainText('持有 1 个当前有效岗位角色')
  await expect(steps.getByRole('button', { name: /角色与权限/ })).toHaveAccessibleName('3. 角色与权限，已完成')
  const saved = (await (await page.request.get(accessPath(created!.id))).json()).data as Access
  expect(saved).toMatchObject({ visibleRoleIds: ['role-employee'], roleIds: ['role-employee'], dataScopes: ['workspace:authorized'] })
})
