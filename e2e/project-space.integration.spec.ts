import { expect, test } from '@playwright/test'

// P1 项目空间用户旅程（e2e/TEST-CATALOG.md PS-E2E-03/04/06）。
// 专用可丢弃 PostgreSQL + 真实 HTTP API；Runtime 为确定性合成实现，
// 不证明真实 DSH、模型质量、OIDC 或生产权限。
type Seed = {
  workspaceId: string
  archivedWorkspaceId: string
  archivedTaskId: string
  agentId: string
  agentMemberId: string
  ownerTaskId: string
  archivedItemPrefix: string
  synthetic: boolean
}

/** 用例自建数据带随机后缀：同一夹具上重跑或 --repeat-each 时互不干扰。 */
function uniqueTitle(label: string) {
  return `${label}-${Math.random().toString(36).slice(2, 8)}`
}

async function loadSeed(page: import('@playwright/test').Page): Promise<Seed> {
  const response = await page.request.get('/api/workbench/v1/test/fixtures')
  expect(response.ok()).toBeTruthy()
  const data = (await response.json()).data as Seed
  expect(data.synthetic).toBe(true)
  return data
}

test.describe('PS-E2E-03 Agent 任务执行、线程续接与成果', () => {
  test.use({ extraHTTPHeaders: { 'x-test-user-id': 'U00002' } })

  test('成员创建 Agent 任务、启动执行，并在任务线程中直接续接', async ({ page }) => {
    const seed = await loadSeed(page)
    await page.goto(`/workspaces/${seed.workspaceId}?tab=tasks`)
    await expect(page.getByRole('tab', { name: /^任务/ })).toHaveAttribute('aria-selected', 'true')

    const title = uniqueTitle('PS-E2E-03 Agent 任务')
    await page.getByRole('button', { name: '新建任务' }).click()
    const dialog = page.getByRole('dialog', { name: '新建任务' })
    await dialog.getByLabel('任务标题').fill(title)
    await dialog.getByTestId('project-task-assignee').click()
    await page.getByRole('option', { name: /项目空间助手/ }).click()
    await dialog.getByRole('button', { name: '保存' }).click()
    await expect(dialog).toBeHidden()

    const row = page.getByTestId('project-task-row').filter({ hasText: title })
    await expect(row).toHaveCount(1)
    await row.getByRole('button', { name: '交给 Agent 执行' }).click()

    // 启动后直接进入任务线程；无须 @ 承接 Agent。
    await expect(page).toHaveURL(new RegExp(`/workspaces/${seed.workspaceId}/conversations/run-`))
    await expect(page.getByTestId('task-thread-badge')).toContainText(title)
    await expect(page.getByTestId('task-thread-notice')).toContainText('项目空间助手')
    await expect(page.getByText(/受控测试运行已完成/).first()).toBeVisible({ timeout: 20_000 })

    const listResponse = await page.request.get(`/api/workbench/v1/workspaces/${seed.workspaceId}/project-tasks`)
    expect(listResponse.ok()).toBeTruthy()
    const tasks = (await listResponse.json()).data.items as Array<{ title: string; status: string; sessionId: string | null }>
    const startedTask = tasks.find(item => item.title === title)
    expect(startedTask?.sessionId).toBeTruthy()

    // 续接：回复默认交给承接 Agent，产生同一线程的第二次运行。
    await page.getByLabel('对话输入').fill('继续整理进展')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page.getByText('继续整理进展')).toBeVisible()
    await expect.poll(async () => {
      const threadResponse = await page.request.get(`/api/workbench/v1/sessions/${startedTask!.sessionId}`)
      if (!threadResponse.ok()) return 0
      const thread = (await threadResponse.json()).data as { runs: Array<{ status: string }> }
      return thread.runs.length
    }, { timeout: 20_000 }).toBeGreaterThanOrEqual(2)

    const finalList = await page.request.get(`/api/workbench/v1/workspaces/${seed.workspaceId}/project-tasks`)
    const finalTask = ((await finalList.json()).data.items as Array<{ title: string; status: string }>)
      .find(item => item.title === title)
    expect(finalTask?.status).toBe('done')
  })
})

test.describe('PS-E2E-04 只读成员与归档空间的任务写入口', () => {
  test.use({ extraHTTPHeaders: { 'x-test-user-id': 'U00003' } })

  test('只读成员能看任务列表，但没有任何写入口', async ({ page }) => {
    const seed = await loadSeed(page)
    await page.goto(`/workspaces/${seed.workspaceId}?tab=tasks`)
    const row = page.getByTestId('project-task-row').filter({ hasText: 'P1 活跃空间任务' })
    await expect(row).toHaveCount(1)
    await expect(page.getByRole('button', { name: '新建任务' })).toHaveCount(0)
    await expect(row.locator('button')).toHaveCount(0)
  })
})

test.describe('PS-E2E-04 归档空间写入口', () => {
  test.use({ extraHTTPHeaders: { 'x-test-user-id': 'U00001' } })

  test('负责人打开归档空间时任务保持只读', async ({ page }) => {
    const seed = await loadSeed(page)
    await page.goto(`/workspaces/${seed.archivedWorkspaceId}?tab=tasks`)
    await expect(page.getByTestId('workspace-archived-alert')).toBeVisible()
    const row = page.getByTestId('project-task-row').filter({ hasText: '归档前的任务' })
    await expect(row).toHaveCount(1)
    await expect(page.getByRole('button', { name: '新建任务' })).toHaveCount(0)
    await expect(row.locator('button')).toHaveCount(0)
  })
})

// 只覆盖目录 PS-E2E-06 的第 1 步（完成任务 → 档案员整理 → 档案页可见）；其余步骤见 TEST-CATALOG“未覆盖”。
test.describe('PS-E2E-06 任务完成后档案员整理', () => {
  test.use({ extraHTTPHeaders: { 'x-test-user-id': 'U00001' } })

  test('完成员工任务触发档案整理，档案页可见整理结果', async ({ page }) => {
    const seed = await loadSeed(page)
    await page.goto(`/workspaces/${seed.workspaceId}?tab=tasks`)

    const title = uniqueTitle('PS-E2E-06 员工任务')
    const archivedItem = `${seed.archivedItemPrefix}${title}已完成`
    await page.getByRole('button', { name: '新建任务' }).click()
    const dialog = page.getByRole('dialog', { name: '新建任务' })
    await dialog.getByLabel('任务标题').fill(title)
    await dialog.getByTestId('project-task-assignee').click()
    await page.getByRole('option', { name: '林岚' }).click()
    await dialog.getByRole('button', { name: '保存' }).click()
    await expect(dialog).toBeHidden()

    const row = page.getByTestId('project-task-row').filter({ hasText: title })
    await row.getByRole('button', { name: '完成' }).click()
    const completion = page.getByRole('dialog', { name: `完成任务“${title}”` })
    await completion.getByLabel('完成说明').fill('已按计划完成')
    await completion.getByRole('button', { name: '确认完成' }).click()
    await expect(completion).toBeHidden()

    // 档案员整理经 Run/Attempt → Runtime Adapter 执行；用服务端状态等待，而不是固定延时。
    await expect.poll(async () => {
      const response = await page.request.get(`/api/workbench/v1/workspaces/${seed.workspaceId}/project-archive`)
      if (!response.ok()) return false
      const current = (await response.json()).data.current as { items?: string[] } | null
      return current?.items?.includes(archivedItem) ?? false
    }, { timeout: 30_000 }).toBe(true)

    await page.getByRole('tab', { name: /^档案/ }).click()
    await expect(page).toHaveURL(/tab=archive/)
    await expect(page.getByTestId('project-archive-item').filter({ hasText: archivedItem })).toHaveCount(1)
  })
})
