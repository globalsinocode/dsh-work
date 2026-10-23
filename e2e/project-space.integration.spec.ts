import { expect, test } from '@playwright/test'

// P1 项目空间用户旅程（e2e/TEST-CATALOG.md PS-E2E-03/04/06/07）。
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
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog).toBeHidden()

    const row = page.getByTestId('project-task-row').filter({ hasText: title })
    await expect(row).toHaveCount(1)
    await row.getByRole('button', { name: '立即执行' }).click()

    // 启动后停留在任务详情的任务对话（S3：页签行隐藏，面包屑到任务名）；无须 @ 承接 Agent。
    await expect(page).toHaveURL(new RegExp(`/workspaces/${seed.workspaceId}/tasks/[^/]+/thread/session-`))
    await expect(page.getByTestId('workspace-crumb-task')).toHaveText(title)
    await expect(page.getByTestId('project-task-detail')).toContainText(title)
    await expect(page.getByTestId('task-send-agent')).toContainText('项目空间助手')
    await expect(page.getByText(/受控测试运行已完成/).first()).toBeVisible({ timeout: 20_000 })

    const listResponse = await page.request.get(`/api/workbench/v1/workspaces/${seed.workspaceId}/project-tasks`)
    expect(listResponse.ok()).toBeTruthy()
    const tasks = (await listResponse.json()).data.items as Array<{ title: string; status: string; sessionId: string | null }>
    const startedTask = tasks.find(item => item.title === title)
    expect(startedTask?.sessionId).toBeTruthy()

    // 续接：回复默认交给承接 Agent，产生同一线程的第二次运行。
    await page.getByPlaceholder('继续交代，交给 项目空间助手 处理…').fill('继续整理进展')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page.getByText('继续整理进展')).toBeVisible()
    await expect.poll(async () => {
      const threadResponse = await page.request.get(`/api/workbench/v1/sessions/${startedTask!.sessionId}`)
      if (!threadResponse.ok()) return 0
      const thread = (await threadResponse.json()).data as { runs: Array<{ status: string }> }
      return thread.runs.length
    }, { timeout: 20_000 }).toBeGreaterThanOrEqual(2)

    const finalList = await page.request.get(`/api/workbench/v1/workspaces/${seed.workspaceId}/project-tasks`)
    const finalTask = ((await finalList.json()).data.items as Array<{ title: string; status: string; latestRunStatus: string | null }>)
      .find(item => item.title === title)
    // S4：执行成功不改任务状态，任务保持进行中，等成员标记完成。
    expect(finalTask?.status).toBe('in_progress')
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
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
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

// S3 统一任务与任务对话：员工与 Agent 任务都在任务详情的任务对话中推进。
test.describe('PS-E2E-07 任务对话（项目空间 S3）', () => {
  test.use({ extraHTTPHeaders: { 'x-test-user-id': 'U00002' } })

  async function createTask(page: import('@playwright/test').Page, workspaceId: string, title: string, assignee: RegExp | string) {
    await page.goto(`/workspaces/${workspaceId}?tab=tasks`)
    await page.getByRole('button', { name: '新建任务' }).click()
    const dialog = page.getByRole('dialog', { name: '新建任务' })
    await dialog.getByLabel('任务标题').fill(title)
    await dialog.getByTestId('project-task-assignee').click()
    await page.getByRole('option', { name: assignee }).click()
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog).toBeHidden()
    await page.getByTestId('project-task-row').filter({ hasText: title }).getByTestId('project-task-open').click()
    await expect(page).toHaveURL(new RegExp(`/workspaces/${workspaceId}/tasks/[^/]+/thread/session-`))
    await expect(page.getByTestId('workspace-crumb-task')).toHaveText(title)
  }

  async function runCount(page: import('@playwright/test').Page, workspaceId: string, title: string) {
    const list = await page.request.get(`/api/workbench/v1/workspaces/${workspaceId}/project-tasks`)
    const task = ((await list.json()).data.items as Array<{ title: string; sessionId: string | null }>)
      .find(item => item.title === title)
    expect(task?.sessionId).toBeTruthy()
    const thread = await page.request.get(`/api/workbench/v1/sessions/${task!.sessionId}`)
    return ((await thread.json()).data as { runs: unknown[] }).runs.length
  }

  test('负责人在任务对话中更新进度并标记完成，不触发 Agent', async ({ page }) => {
    const seed = await loadSeed(page)
    const title = uniqueTitle('PS-E2E-07 员工任务')
    await createTask(page, seed.workspaceId, title, '周衡')

    await expect(page.getByTestId('project-task-detail-status')).toHaveText('待办')
    await expect(page.getByTestId('task-send-agent')).toHaveCount(0)
    await expect(page.getByTestId('task-send-hint')).toHaveText('发言对空间成员可见，不会触发 Agent')

    // 负责人首次发言：带“负责人”标记，任务自动进入“进行中”并留下系统记录。
    await page.getByPlaceholder('更新进度或写评论…').fill('已完成数据收集')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page.getByTestId('task-conversation-message').filter({ hasText: '已完成数据收集' })
      .getByTestId('task-conversation-tag')).toHaveText('负责人')
    await expect(page.getByTestId('task-conversation-event').filter({ hasText: '周衡 更新了进度，任务进入进行中' })).toHaveCount(1)
    await expect(page.getByTestId('project-task-detail-status')).toHaveText('进行中')

    // 输入框旁“标记完成”：完成说明作为完成记录出现在对话中。
    await page.getByTestId('task-complete-from-conversation').click()
    const completion = page.getByRole('dialog', { name: `完成任务“${title}”` })
    await completion.getByLabel('完成说明').fill('报表已交付')
    await completion.getByRole('button', { name: '确认完成' }).click()
    await expect(completion).toBeHidden()
    const completed = page.getByTestId('task-conversation-event').filter({ hasText: '周衡 标记完成' })
    await expect(completed).toHaveCount(1)
    await expect(completed).toContainText('报表已交付')
    await expect(page.getByTestId('project-task-detail-status')).toHaveText('已完成')

    expect(await runCount(page, seed.workspaceId, title)).toBe(0)
  })

  test('Agent 任务先评论不执行，再交给 Agent 开始，执行详情只能返回任务对话', async ({ page }) => {
    const seed = await loadSeed(page)
    const title = uniqueTitle('PS-E2E-07 Agent 任务')
    await createTask(page, seed.workspaceId, title, /项目空间助手/)

    await expect(page.getByTestId('task-conversation-start')).toBeVisible()

    // 仅评论：标注“评论”，不产生 Run，任务仍未开始。
    await page.getByTestId('task-send-comment').click()
    await page.getByPlaceholder('写评论…').fill('先看下简报再开始')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page.getByTestId('task-conversation-message').filter({ hasText: '先看下简报再开始' })
      .getByTestId('task-conversation-tag')).toHaveText('评论')
    await expect(page.getByTestId('task-conversation-start')).toBeVisible()
    expect(await runCount(page, seed.workspaceId, title)).toBe(0)

    // 交给 Agent：未执行过时带补充要求开始执行，执行记录出现在对话中。
    await page.getByTestId('task-send-agent').click()
    await page.getByPlaceholder('补充要求，交给 项目空间助手 开始执行…').fill('重点关注交付风险')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page.getByTestId('task-conversation-message').filter({ hasText: '重点关注交付风险' }).first()).toBeVisible()
    const runRecord = page.getByTestId('task-conversation-run').filter({ hasText: '周衡 交给 项目空间助手 执行 · 执行完成' })
    await expect(runRecord).toHaveCount(1, { timeout: 20_000 })
    await expect(page.getByTestId('task-conversation-start')).toHaveCount(0)
    // S4：执行成功只体现在“最近执行”，任务保持进行中。
    await expect(page.getByTestId('project-task-detail-status')).toHaveText('进行中')
    await expect(page.getByTestId('project-task-latest-run')).toContainText('成功')
    expect(await runCount(page, seed.workspaceId, title)).toBe(1)

    // 执行详情不提供输入框，只能回到任务对话发言。
    await runRecord.click()
    await expect(page.getByTestId('run-view-task-return')).toBeVisible()
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toHaveCount(0)
    await page.getByTestId('run-view-back-to-task').click()
    await expect(page.getByTestId('task-conversation-modes')).toBeVisible()
    await expect(page.getByTestId('task-conversation-run')).toHaveCount(1)

    // S4：Agent 任务同样由人标记完成；完成后只能评论。
    await page.getByTestId('task-complete-from-conversation').click()
    const completion = page.getByRole('dialog', { name: `完成任务“${title}”` })
    await completion.getByLabel('完成说明').fill('首轮分析已交付')
    await completion.getByRole('button', { name: '确认完成' }).click()
    await expect(completion).toBeHidden()
    await expect(page.getByTestId('project-task-detail-status')).toHaveText('已完成')
    await expect(page.getByTestId('task-send-agent')).toBeDisabled()
  })
})

// S4 执行规则：新建时选择规则并“保存并立即执行”；到点的定时执行以“定时执行”记录出现在任务对话中。
test.describe('PS-E2E-08 执行规则（项目空间 S4）', () => {
  test.use({ extraHTTPHeaders: { 'x-test-user-id': 'U00002' } })

  test('新建工作日规则并立即执行，修改规则，到点的定时执行出现在任务对话中', async ({ page }) => {
    const seed = await loadSeed(page)
    await page.goto(`/workspaces/${seed.workspaceId}?tab=tasks`)
    const title = uniqueTitle('PS-E2E-08 定时任务')
    await page.getByRole('button', { name: '新建任务' }).click()
    const dialog = page.getByRole('dialog', { name: '新建任务' })
    await dialog.getByLabel('任务标题').fill(title)
    await dialog.getByTestId('project-task-assignee').click()
    await page.getByRole('option', { name: /项目空间助手/ }).click()
    const rule = dialog.getByTestId('project-task-schedule-editor')
    await expect(rule.getByRole('radio', { name: '每天' })).toBeChecked()
    await rule.getByText('工作日', { exact: true }).click()
    await dialog.getByRole('button', { name: '保存并立即执行' }).click()
    await expect(dialog).toBeHidden()

    // 保存后直接进入任务对话并开始第一次执行。
    await expect(page).toHaveURL(new RegExp(`/workspaces/${seed.workspaceId}/tasks/[^/]+/thread/session-`))
    await expect(page.getByTestId('project-task-schedule')).toContainText('工作日 09:00')
    await expect(page.getByTestId('task-conversation-run').filter({ hasText: '周衡 交给 项目空间助手 执行 · 执行完成' }))
      .toHaveCount(1, { timeout: 20_000 })
    await expect(page.getByTestId('project-task-detail-status')).toHaveText('进行中')

    // 修改规则：对话中出现系统记录。
    await page.getByTestId('project-task-schedule-edit').click()
    const editor = page.getByRole('dialog', { name: '编辑任务' })
    await editor.getByTestId('project-task-schedule-editor').getByText('手动', { exact: true }).click()
    await editor.getByRole('button', { name: '保存', exact: true }).click()
    await expect(editor).toBeHidden()
    await expect(page.getByTestId('project-task-schedule')).toContainText('手动')
    await expect(page.getByTestId('task-conversation-event').filter({ hasText: '将执行规则改为手动' })).toHaveCount(1)

    // 到点（测试钩子拨动时间点）：以“定时执行”记录出现，不显示固定提示。
    const taskId = page.url().match(/tasks\/([^/]+)/)![1]!
    const fired = await page.request.post(`/api/workbench/v1/test/project-tasks/${taskId}/fire-schedule`)
    expect(fired.ok()).toBeTruthy()
    await page.reload()
    await expect(page.getByTestId('task-conversation-run').filter({ hasText: /定时执行 · 执行完成/ }))
      .toHaveCount(1, { timeout: 20_000 })
    await expect(page.getByText('按任务说明执行本期工作')).toHaveCount(0)
  })

})

test.describe('MODE-E2E-09/10 协作模式群聊（S5d）', () => {
  test.use({ extraHTTPHeaders: { 'x-test-user-id': 'U00002' } })

  test.beforeEach(async ({ page }) => {
    await page.request.put('/api/workbench/v1/me/preferences', { data: { uiMode: 'collab' } })
  })
  test.afterEach(async ({ page }) => {
    await page.request.put('/api/workbench/v1/me/preferences', { data: { uiMode: 'work' } })
  })

  test('群聊中讨论不触发执行，@Agent 才执行；任务卡片进入群组内的任务详情', async ({ page }) => {
    const seed = await loadSeed(page)
    await page.goto(`/c/chats/group/${seed.workspaceId}`)
    const chat = page.getByRole('region', { name: '群聊' })
    await expect(page.getByRole('tab', { name: '对话' })).toHaveAttribute('aria-selected', 'true')

    // 只有一个可发起的 Agent 时预选它；改为讨论后发送不产生执行。
    const discussion = uniqueTitle('MODE-09 讨论')
    const preset = page.getByRole('button', { name: '改为讨论' })
    if (await preset.isVisible()) await preset.click()
    await page.getByLabel('对话输入').fill(discussion)
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(chat.locator('.user-message', { hasText: discussion })).toBeVisible()
    await expect(chat.getByTestId('group-run-record').filter({ hasText: discussion })).toHaveCount(0)

    // @Agent：出现执行记录，Agent 回复进入时间线；续写最近一段讨论（不新增话题）。
    const dividers = await chat.locator('.collab-group-timeline__divider').count()
    const ask = uniqueTitle('MODE-09 执行')
    await page.getByRole('button', { name: /^交给 @/ }).click()
    await page.getByLabel('对话输入').fill(ask)
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(chat.getByTestId('group-run-record').last()).toBeVisible()
    await expect(chat.getByText(/受控测试运行已完成/).last()).toBeVisible({ timeout: 20_000 })
    expect(await chat.locator('.collab-group-timeline__divider').count()).toBe(dividers)

    // 执行记录进入群组内的执行详情（与工作模式同一页面）。
    await chat.getByTestId('group-run-record').last().click()
    await expect(page).toHaveURL(new RegExp(`/c/chats/group/${seed.workspaceId}/conversations/run-`))
    await page.getByRole('tab', { name: '对话' }).click()

    // 在“任务”页签新建任务（与工作模式同一组件），回到对话出现任务卡片，点卡片进入任务详情。
    const title = uniqueTitle('MODE-10 任务')
    await page.getByRole('tab', { name: /^任务/ }).click()
    await expect(page).toHaveURL(new RegExp(`/c/chats/group/${seed.workspaceId}\\?tab=tasks`))
    await page.getByRole('button', { name: '新建任务' }).click()
    const dialog = page.getByRole('dialog', { name: '新建任务' })
    await dialog.getByLabel('任务标题').fill(title)
    await dialog.getByTestId('project-task-assignee').click()
    await page.getByRole('option', { name: /项目空间助手/ }).click()
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog).toBeHidden()
    await page.getByRole('tab', { name: '对话' }).click()
    await page.getByRole('button', { name: `打开任务：${title}` }).click()
    await expect(page).toHaveURL(new RegExp(`/c/chats/group/${seed.workspaceId}/tasks/[^/]+`))
    await expect(page.getByTestId('workspace-crumb-task')).toHaveText(title)
    await expect(page.getByTestId('project-task-detail')).toContainText(title)

    // 群信息展开 A 的右栏（简报、成员与 Agent）。
    await page.getByRole('button', { name: '群信息', exact: true }).click()
    await expect(page).toHaveURL(/info=1/)
    await expect(page.getByText('群信息', { exact: true }).or(page.getByText('任务信息', { exact: true })).first()).toBeVisible()
  })
})

test.describe('MODE-E2E-09 协作模式归档群组（S5d）', () => {
  // 归档夹具空间的成员是负责人 U00001（与 PS-E2E-04 归档用例同一身份）。
  test.use({ extraHTTPHeaders: { 'x-test-user-id': 'U00001' } })

  test.afterEach(async ({ page }) => {
    await page.request.put('/api/workbench/v1/me/preferences', { data: { uiMode: 'work' } })
  })

  test('归档群组可读但不显示输入区', async ({ page }) => {
    await page.request.put('/api/workbench/v1/me/preferences', { data: { uiMode: 'collab' } })
    const seed = await loadSeed(page)
    await page.goto(`/c/chats/group/${seed.archivedWorkspaceId}`)
    await expect(page.getByRole('region', { name: '群聊' })).toBeVisible()
    await expect(page.getByTestId('group-archived-notice')).toBeVisible()
    await expect(page.getByLabel('对话输入')).toHaveCount(0)
  })
})
