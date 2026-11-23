import { expect, test } from '@playwright/test'

// P1 项目空间用户旅程（验收目录 e2e/catalog/project-space.md 与 collab-mode.md 中的 P1 条目）。
// 专用可丢弃 PostgreSQL + 真实 HTTP API；Runtime 为确定性合成实现，
// 不证明真实 DSH、模型质量或生产权限。
type Seed = {
  workspaceId: string
  scopedWorkspaceId: string
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

type Page = import('@playwright/test').Page

/** 以指定测试身份打开一个独立的 browser context（多角色旅程不共享页面状态）。 */
async function openAs(
  browser: import('@playwright/test').Browser, baseURL: string | undefined, userId: string,
) {
  const context = await browser.newContext({ baseURL, extraHTTPHeaders: { 'x-test-user-id': userId } })
  return { context, page: await context.newPage() }
}

/** 团队会话 ID：对话视图地址可能是会话本身，也可能是其中一次执行。 */
async function sessionIdFromUrl(page: Page): Promise<string> {
  const target = page.url().match(/conversations\/([^/?#]+)/)?.[1] ?? ''
  if (target.startsWith('session-')) return target
  const response = await page.request.get(`/api/workbench/v1/runs/${target}`)
  expect(response.ok()).toBeTruthy()
  return (await response.json()).data.sessionId as string
}

async function sessionThread(page: Page, sessionId: string) {
  const response = await page.request.get(`/api/workbench/v1/sessions/${sessionId}`)
  expect(response.ok()).toBeTruthy()
  return (await response.json()).data as {
    runs: unknown[]
    messages: Array<{ content: string; runId: string | null; senderName?: string }>
  }
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

test.describe('PS-E2E-03 引用文件、成果标注与他人续接', () => {
  test.use({ extraHTTPHeaders: { 'x-test-user-id': 'U00002' } })

  test('成员引用共享文件启动任务；成果标注所属任务与发起人；负责人在自己的会话中续接', async ({ page, browser, baseURL }) => {
    const seed = await loadSeed(page)
    // 标题带 `P1-成果达成`：合成 Runtime 为这次执行登记一个成果（测试夹具，非真实 DSH 产出）。
    const title = uniqueTitle('PS-E2E-03 P1-成果达成')
    await page.goto(`/workspaces/${seed.workspaceId}?tab=tasks`)
    await page.getByRole('button', { name: '新建任务' }).click()
    const dialog = page.getByRole('dialog', { name: '新建任务' })
    await dialog.getByLabel('任务标题').fill(title)
    await dialog.getByTestId('project-task-assignee').click()
    await page.getByRole('option', { name: /项目空间助手/ }).click()
    // 下拉框的占位文字覆盖在输入框上，点它展开（与用户操作一致）。
    await dialog.getByText('选择已解析成功的共享文件').click()
    await page.getByRole('option', { name: 'P1-共享文件.txt（V1）' }).click()
    await dialog.getByTestId('project-task-schedule-editor').getByText('手动', { exact: true }).click()
    await dialog.getByRole('button', { name: '保存并立即执行' }).click()
    await expect(dialog).toBeHidden()

    // 第 1 步：任务详情内的任务对话；任务信息与启动消息都带着引用文件。
    await expect(page).toHaveURL(new RegExp(`/workspaces/${seed.workspaceId}/tasks/[^/]+/thread/session-`))
    const taskUrl = page.url()
    await expect(page.getByTestId('project-task-info')).toContainText('P1-共享文件.txt（V1）')
    await expect(page.getByLabel('附带文件').filter({ hasText: 'P1-共享文件.txt' }).first()).toBeVisible()
    await expect(page.getByTestId('task-conversation-run').filter({ hasText: '周衡 交给 项目空间助手 执行 · 执行完成' }))
      .toHaveCount(1, { timeout: 20_000 })
    await expect(page.getByTestId('project-task-detail-status')).toHaveText('进行中')

    const owner = await openAs(browser, baseURL, 'U00001')
    try {
      // 第 3 步：负责人在自己的会话中打开同一任务对话，直接回复即交给同一 Agent。
      await owner.page.goto(taskUrl)
      await expect(owner.page.getByTestId('workspace-crumb-task')).toHaveText(title)
      // 回复也带 `P1-成果达成`：合成 Runtime 只为带该标记的输入登记成果。
      await owner.page.getByPlaceholder('继续交代，交给 项目空间助手 处理…').fill('补充华南区域的数据 P1-成果达成')
      await owner.page.getByRole('button', { name: '发送消息', exact: true }).click()
      await expect(owner.page.getByTestId('task-conversation-run').filter({ hasText: '林岚 交给 项目空间助手 执行 · 执行完成' }))
        .toHaveCount(1, { timeout: 20_000 })
      await expect(owner.page.getByTestId('task-conversation-run')).toHaveCount(2)

      // 第 2 步：成果页签按任务与发起人标注两次执行各自的成果。
      await owner.page.goto(`/workspaces/${seed.workspaceId}?tab=artifacts`)
      const origins = owner.page.getByTestId('artifact-card-origin').filter({ hasText: `任务「${title}」` })
      await expect(origins).toHaveCount(2)
      await expect(origins.filter({ hasText: /项目空间助手 \S+ · 周衡 发起$/ })).toHaveCount(1)
      await expect(origins.filter({ hasText: /项目空间助手 \S+ · 林岚 发起$/ })).toHaveCount(1)
    } finally {
      await owner.context.close()
    }
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
    const entriesBefore = await chat.getByTestId('group-run-entry').count()
    const preset = page.getByRole('button', { name: '改为讨论' })
    if (await preset.isVisible()) await preset.click()
    await page.getByLabel('对话输入').fill(discussion)
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(chat.locator('.user-message', { hasText: discussion })).toBeVisible()
    await expect(chat.getByTestId('group-run-entry')).toHaveCount(entriesBefore)

    // @Agent：回复进入时间线并标注发起人，问题与回复之间不再单独显示执行记录（D36）；续写最近一段讨论（不新增话题）。
    const dividers = await chat.locator('.collab-group-timeline__divider').count()
    const ask = uniqueTitle('MODE-09 执行')
    await page.getByRole('button', { name: /^交给 @/ }).click()
    await page.getByLabel('对话输入').fill(ask)
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(chat.getByText(/受控测试运行已完成/).last()).toBeVisible({ timeout: 20_000 })
    await expect(chat.getByTestId('group-run-entry')).toHaveCount(entriesBefore)
    expect(await chat.locator('.collab-group-timeline__divider').count()).toBe(dividers)

    // 回复下的“查看执行详情”进入群组内的执行详情（与工作模式同一页面）。
    const reply = chat.locator('.conversation-message--assistant:not([data-testid="group-run-entry"])', { hasText: '受控测试运行已完成' }).last()
    await expect(reply).toContainText('发起')
    await reply.getByRole('button', { name: '查看执行详情' }).click()
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
    await expect(page.getByTestId('project-task-detail')).toContainText(title)

    // D37：右栏默认显示任务信息，与任务对话并列；头部“群信息”切到群信息（A 的右栏：简报、成员与 Agent）。
    await expect(page.getByRole('tab', { name: '任务信息' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('task-info-pane').getByTestId('project-task-info')).toBeVisible()
    await page.getByRole('button', { name: '群信息', exact: true }).click()
    await expect(page).toHaveURL(/info=1/)
    await expect(page.getByRole('tab', { name: '群信息' })).toHaveAttribute('aria-selected', 'true')
  })
})

test.describe('MODE-E2E-16 协作模式群组任务详情（D37）', () => {
  test.use({ extraHTTPHeaders: { 'x-test-user-id': 'U00002' } })

  test.beforeEach(async ({ page }) => {
    await page.request.put('/api/workbench/v1/me/preferences', { data: { uiMode: 'collab' } })
  })
  test.afterEach(async ({ page }) => {
    await page.request.put('/api/workbench/v1/me/preferences', { data: { uiMode: 'work' } })
  })

  test('任务对话与任务信息并列；回复下有成果与执行步骤，继续修改带着引用交给 Agent', async ({ page }) => {
    const seed = await loadSeed(page)
    // 标题带 `P1-成果达成`：合成 Runtime 为这次执行登记一个成果（测试夹具，非真实 DSH 产出）。
    const title = uniqueTitle('MODE-16 P1-成果达成')
    const created = await page.request.post(`/api/workbench/v1/workspaces/${seed.workspaceId}/project-tasks`, {
      data: { title, description: 'MODE-16 任务说明', assignee: { type: 'agent', id: seed.agentMemberId } },
    })
    expect(created.ok()).toBeTruthy()
    const taskId = (await created.json()).data.id as string
    const started = await page.request.post(`/api/workbench/v1/workspaces/${seed.workspaceId}/project-tasks/${taskId}/start`, {
      data: { idempotencyKey: `mode-16-${taskId}` },
    })
    expect(started.ok()).toBeTruthy()

    await page.goto(`/c/chats/group/${seed.workspaceId}/tasks/${taskId}`)
    await expect(page).toHaveURL(new RegExp(`/c/chats/group/${seed.workspaceId}/tasks/${taskId}/thread/session-`))
    const thread = page.getByRole('main', { name: '对话内容' })
    const reply = thread.locator('.conversation-message--assistant', { hasText: '成果已登记' })
    await expect(reply).toBeVisible({ timeout: 20_000 })

    // 任务信息与任务对话同时可见；不再有面包屑与“执行详情”按钮。
    const info = page.getByTestId('task-info-pane').getByTestId('project-task-info')
    await expect(info).toBeVisible()
    await expect(info.getByTestId('project-task-description')).toContainText('MODE-16 任务说明')
    await expect(page.getByTestId('workspace-crumb-task')).toHaveCount(0)
    await expect(page.getByTestId('project-task-run-detail')).toHaveCount(0)
    await page.getByRole('button', { name: '更多任务操作' }).click()
    await expect(page.getByRole('menuitem', { name: '编辑任务' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: '标记完成' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('task-complete-from-conversation')).toHaveCount(0)

    // 回复下：这次执行登记的成果与可展开的执行步骤。
    const preview = reply.getByRole('button', { name: /^预览成果 P1-任务成果-/ })
    await expect(preview).toBeVisible()
    await preview.click()
    const closePreview = page.getByRole('button', { name: '关闭成果预览' })
    await expect(closePreview).toBeVisible()
    await expect(preview).toHaveAttribute('aria-pressed', 'true')
    await closePreview.click()
    await expect(closePreview).toBeHidden()
    const steps = reply.getByTestId('run-steps-disclosure').locator('summary')
    await steps.click()
    await expect(steps).toHaveText(/已完成 \d+ 个步骤|这次执行没有记录步骤/)

    // 继续修改：成果作为引用随下一条交给 Agent 的消息发送。
    await reply.getByRole('button', { name: '继续修改' }).click()
    await expect(page.getByTestId('referenced-artifacts')).toContainText('P1-任务成果-')
    const runRequest = page.waitForRequest(request => request.method() === 'POST' && /\/sessions\/[^/]+\/runs$/.test(request.url()))
    // “对话”页签的群聊输入框隐藏但仍在页面里：限定在任务详情的任务对话内。
    const taskThread = page.locator('.project-task-detail__thread')
    await taskThread.getByLabel('对话输入').fill('MODE-16 补充华南')
    await taskThread.getByRole('button', { name: '发送消息', exact: true }).click()
    expect(((await runRequest).postDataJSON() as { fileIds: string[] }).fileIds).toHaveLength(1)
    await expect(page.getByTestId('referenced-artifacts')).toHaveCount(0)

    // “最近执行”进入该次执行详情。
    await expect(info.getByTestId('project-task-latest-run-link')).toBeVisible({ timeout: 20_000 })
    await info.getByTestId('project-task-latest-run-link').click()
    await expect(page).toHaveURL(new RegExp(`/c/chats/group/${seed.workspaceId}/tasks/${taskId}/thread/run-`))
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

test.describe('MODE-E2E-13 协作模式未读（S5e）', () => {
  // 只读成员 U00003 是读者，成员 U00002 在另一个独立的 browser context 中发言。
  test.use({ extraHTTPHeaders: { 'x-test-user-id': 'U00003' } })

  test.beforeEach(async ({ page }) => {
    await page.request.put('/api/workbench/v1/me/preferences', { data: { uiMode: 'collab' } })
  })
  test.afterEach(async ({ page }) => {
    await page.request.put('/api/workbench/v1/me/preferences', { data: { uiMode: 'work' } })
  })

  test('他人在群里发言后出现未读，打开群组即已读并保存在服务端', async ({ page, browser, baseURL }) => {
    const seed = await loadSeed(page)
    const read = await page.request.post(`/api/workbench/v1/me/conversation-targets/group/${seed.workspaceId}/read`, { data: {} })
    expect(read.ok()).toBeTruthy()
    await page.goto('/c/chats')
    const row = () => page.getByRole('list', { name: '对话' }).getByRole('button', { name: /P1 项目空间/ })
    await expect(row()).toBeVisible()
    await expect(row().getByTestId('conversation-unread')).toHaveCount(0)

    const member = await browser.newContext({ baseURL, extraHTTPHeaders: { 'x-test-user-id': 'U00002' } })
    try {
      const memberPage = await member.newPage()
      await memberPage.request.put('/api/workbench/v1/me/preferences', { data: { uiMode: 'collab' } })
      await memberPage.goto(`/c/chats/group/${seed.workspaceId}`)
      const message = uniqueTitle('MODE-13 新进展')
      // 等输入区就绪后再取消单 Agent 预选：这条应是讨论，不触发执行。
      // 夹具群组只有一个 Agent：预选条与“交给 @”二者必出现其一。
      const preset = memberPage.getByRole('button', { name: '改为讨论' })
      const handOver = memberPage.getByRole('button', { name: /^交给 @/ })
      await expect(preset.or(handOver)).toBeVisible()
      if (await preset.isVisible()) await preset.click()
      await expect(handOver).toBeVisible()
      await memberPage.getByLabel('对话输入').fill(message)
      await memberPage.getByRole('button', { name: '发送消息', exact: true }).click()
      await expect(memberPage.getByRole('region', { name: '群聊' }).locator('.user-message', { hasText: message })).toBeVisible()
      // 发言者本人：正打开该群组，自己的发言不产生未读。
      await expect(memberPage.getByRole('list', { name: '对话' }).getByRole('button', { name: /P1 项目空间/ }).getByTestId('conversation-unread')).toHaveCount(0)
      await memberPage.request.put('/api/workbench/v1/me/preferences', { data: { uiMode: 'work' } })
    } finally {
      await member.close()
    }

    // 读者回到对话页（重新加载列表）后出现未读；预览为他人的新发言。
    await page.reload()
    await expect(row()).toContainText('周衡：MODE-13 新进展')
    await expect(row()).toHaveAccessibleName(/，1 条未读$/)

    await row().click()
    await expect(page).toHaveURL(new RegExp(`/c/chats/group/${seed.workspaceId}$`))
    await expect(row().getByTestId('conversation-unread')).toHaveCount(0)
    await page.reload()
    await expect(row()).toBeVisible()
    await expect(row().getByTestId('conversation-unread')).toHaveCount(0)
  })
})

test.describe('TW-E2E-10 团队共享讨论与 @Agent 触发（工作模式）', () => {
  test.use({ extraHTTPHeaders: { 'x-test-user-id': 'U00002' } })

  test('首条消息交给预选 Agent，会话内讨论不执行；负责人回帖，只读成员与归档空间没有写入口', async ({ page, browser, baseURL }) => {
    const seed = await loadSeed(page)
    await page.goto(`/workspaces/${seed.workspaceId}?tab=conversations`)

    // 第 1 步：唯一可发起的 Agent 自动预选，首条消息创建会话并执行。
    await expect(page.getByText('本次对话使用 Agent 成员：')).toContainText('项目空间助手')
    const first = uniqueTitle('TW-10 首条')
    await page.getByLabel('对话输入').fill(first)
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/workspaces/${seed.workspaceId}/conversations/`))
    await expect(page.getByText(/受控测试运行已完成/).first()).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('由 周衡 发起').first()).toBeVisible()
    const sessionId = await sessionIdFromUrl(page)

    // 第 2 步：不 @ 的消息是讨论，不产生新执行。
    const discussion = uniqueTitle('TW-10 讨论')
    await page.getByLabel('对话输入').fill(discussion)
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page.getByText('讨论消息已发送，如需 Agent 处理请 @ 对应成员')).toBeVisible()
    await expect.poll(async () => (await sessionThread(page, sessionId)).messages
      .some(message => message.content === discussion && message.runId === null)).toBe(true)
    expect((await sessionThread(page, sessionId)).runs).toHaveLength(1)

    // 第 3 步：负责人在“历史对话”打开同一会话，读到双方内容并回帖。
    const owner = await openAs(browser, baseURL, 'U00001')
    try {
      await owner.page.goto(`/workspaces/${seed.workspaceId}?tab=conversations&view=history`)
      await owner.page.getByTestId('session-history-row').filter({ hasText: first }).click()
      await expect(owner.page).toHaveURL(new RegExp(`/workspaces/${seed.workspaceId}/conversations/`))
      // 历史行打开的是该会话最近一次执行；确认属于同一会话，再进入会话视图看完整讨论。
      await expect(owner.page.getByRole('main', { name: '对话内容' }).getByText(first)).toBeVisible()
      expect(await sessionIdFromUrl(owner.page)).toBe(sessionId)
      await owner.page.goto(`/workspaces/${seed.workspaceId}/conversations/${sessionId}`)
      const thread = owner.page.getByRole('main', { name: '对话内容' })
      await expect(thread.getByText(first)).toBeVisible()
      await expect(thread.getByText(discussion)).toBeVisible()
      await expect(thread.getByText('由 周衡 发起').first()).toBeVisible()
      const reply = uniqueTitle('TW-10 负责人回帖')
      await owner.page.getByLabel('对话输入').fill(reply)
      await owner.page.getByRole('button', { name: '发送消息', exact: true }).click()
      // 会话视图发讨论不弹提示，消息直接进入消息流。
      await expect(thread.getByText(reply)).toBeVisible()
      await expect.poll(async () => (await sessionThread(owner.page, sessionId)).messages
        .find(message => message.content === reply)?.senderName).toBe('林岚')
      expect((await sessionThread(owner.page, sessionId)).runs).toHaveLength(1)
    } finally {
      await owner.context.close()
    }

    // 第 4、5 步：只读成员可读不可写；归档空间没有发起新对话的输入框。
    const viewer = await openAs(browser, baseURL, 'U00003')
    try {
      await viewer.page.goto(`/workspaces/${seed.workspaceId}/conversations/${sessionId}`)
      await expect(viewer.page.getByRole('main', { name: '对话内容' }).getByText(discussion)).toBeVisible()
      await expect(viewer.page.getByText('当前角色为只读成员，仅可查看讨论内容。')).toBeVisible()
      await expect(viewer.page.getByLabel('对话输入')).toHaveCount(0)

      await viewer.page.goto(`/workspaces/${seed.archivedWorkspaceId}?tab=conversations`)
      await expect(viewer.page.getByTestId('workspace-archived-alert')).toBeVisible()
      await expect(viewer.page.getByLabel('对话输入')).toHaveCount(0)
    } finally {
      await viewer.context.close()
    }
  })
})

test.describe('TW-E2E-11 空间内对话视图', () => {
  test.use({ extraHTTPHeaders: { 'x-test-user-id': 'U00002' } })

  test('空间内发起、返回、从历史打开与旧链接都留在空间；个人会话不跳转', async ({ page }) => {
    const seed = await loadSeed(page)
    const inSpace = new RegExp(`/workspaces/${seed.workspaceId}/conversations/`)
    await page.goto(`/workspaces/${seed.workspaceId}?tab=conversations`)
    const first = uniqueTitle('TW-11 空间对话')
    await page.getByLabel('对话输入').fill(first)
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page).toHaveURL(inSpace)
    await expect(page.getByRole('tab', { name: /^任务/ })).toBeVisible()
    await expect(page.getByText('工作空间信息')).toBeVisible()
    await expect(page.getByText(/受控测试运行已完成/).first()).toBeVisible({ timeout: 20_000 })
    const sessionId = await sessionIdFromUrl(page)

    // 返回：回到所属空间的“对话 › 历史对话”，刚才的会话在列表中。
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/workspaces/${seed.workspaceId}\\?tab=conversations&view=history$`))
    await expect(page.getByRole('tab', { name: /^对话/ })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('tab', { name: '历史对话' })).toHaveAttribute('aria-selected', 'true')

    // 历史对话打开：同样在空间内。
    await page.getByTestId('session-history-row').filter({ hasText: first }).click()
    await expect(page).toHaveURL(inSpace)

    // 空间外的旧链接归位到空间 URL，空间外壳完整。
    await page.goto(`/conversations/${sessionId}`)
    await expect(page).toHaveURL(new RegExp(`/workspaces/${seed.workspaceId}/conversations/${sessionId}`))
    await expect(page.getByRole('tab', { name: /^任务/ })).toBeVisible()

    // 个人空间会话停留在独立页。
    await page.goto('/workbench')
    await page.getByLabel('对话输入').fill(uniqueTitle('TW-11 个人对话'))
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page).toHaveURL(/\/conversations\/run-/)
    await expect(page.getByText(/受控测试运行已完成/).first()).toBeVisible({ timeout: 20_000 })
    expect(new URL(page.url()).pathname).toMatch(/^\/conversations\//)
  })
})

test.describe('PS-E2E-00 Agent 可交付数据范围随成员收紧与恢复', () => {
  test.use({ extraHTTPHeaders: { 'x-test-user-id': 'U00001' } })

  /** 名册在加入/移除成员后于后台刷新：用会重试的断言等它收敛。 */
  async function expectDeliverableScopes(page: Page, scopes: string) {
    await page.getByRole('button', { name: '管理 Agent' }).first().click()
    const dialog = page.getByRole('dialog', { name: '管理 Agent' })
    await expect(dialog.getByTestId('agent-member-row').filter({ hasText: '区域数据助手' })
      .getByTestId('agent-deliverable-scopes')).toHaveText(`本空间可交付数据范围：${scopes}`)
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(dialog).toBeHidden()
  }

  async function openMemberSearch(page: Page) {
    await page.getByRole('button', { name: '管理成员' }).first().click()
    const dialog = page.getByRole('dialog', { name: '管理成员' })
    await dialog.getByTestId('member-add-employee').click()
    await dialog.getByRole('textbox', { name: '输入姓名搜索企业员工' }).fill('顾远')
    return dialog
  }

  test('加入范围更小的员工前提示收紧，加入后名册收窄，移除后恢复', async ({ page }) => {
    const seed = await loadSeed(page)
    // 防御：上一次中断的运行可能留下顾远。
    await page.request.delete(`/api/workbench/v1/workspaces/${seed.scopedWorkspaceId}/members/U00004`)
    try {
      await page.goto(`/workspaces/${seed.scopedWorkspaceId}`)
      await expectDeliverableScopes(page, '华东区域、华南区域')

      // 取消：不加入，范围不变。
      let dialog = await openMemberSearch(page)
      await dialog.getByTestId('member-candidate-row').filter({ hasText: '顾远' }).getByRole('button', { name: '加入' }).click()
      const warning = page.getByRole('dialog', { name: '加入后 Agent 的可用数据范围会缩小' })
      await expect(warning).toContainText('“区域数据助手”将不能再使用：华南区域')
      await warning.getByRole('button', { name: '取消' }).click()
      await expect(warning).toBeHidden()
      await expect(dialog.getByTestId('member-candidate-row').filter({ hasText: '顾远' })).toHaveCount(1)
      const membersAfterCancel = await page.request.get(`/api/workbench/v1/workspaces/${seed.scopedWorkspaceId}/members`)
      expect(JSON.stringify((await membersAfterCancel.json()).data)).not.toContain('U00004')
      await dialog.getByTestId('member-dialog-close').click()
      await expect(dialog).toBeHidden()
      await expectDeliverableScopes(page, '华东区域、华南区域')
      dialog = await openMemberSearch(page)

      // 仍然添加：顾远成为成员，可交付范围只剩华东区域。
      await dialog.getByTestId('member-candidate-row').filter({ hasText: '顾远' }).getByRole('button', { name: '加入' }).click()
      await warning.getByRole('button', { name: '仍然添加' }).click()
      await expect(dialog.getByTestId('member-row').filter({ hasText: '顾远' })).toHaveCount(1)
      await dialog.getByTestId('member-dialog-close').click()
      await expect(dialog).toBeHidden()
      await expectDeliverableScopes(page, '华东区域')

      // 移除后恢复。
      await page.getByRole('button', { name: '管理成员' }).first().click()
      dialog = page.getByRole('dialog', { name: '管理成员' })
      await dialog.getByTestId('member-row').filter({ hasText: '顾远' }).getByTestId('member-remove').click()
      await page.getByRole('dialog', { name: '移除成员“顾远”？' }).getByRole('button', { name: '移除成员' }).click()
      await expect(dialog.getByTestId('member-row').filter({ hasText: '顾远' })).toHaveCount(0)
      await dialog.getByTestId('member-dialog-close').click()
      await expectDeliverableScopes(page, '华东区域、华南区域')
    } finally {
      await page.request.delete(`/api/workbench/v1/workspaces/${seed.scopedWorkspaceId}/members/U00004`)
    }
  })
})

test.describe('MODE-E2E-17 @ 同事站内提醒（P1）', () => {
  // 发言人周衡（U00002）；接收人陈默（U00005）由负责人临时加入“P1 项目空间”，用例结束时移除。
  test.use({ extraHTTPHeaders: { 'x-test-user-id': 'U00002' } })

  test.afterEach(async ({ page }) => {
    await page.request.put('/api/workbench/v1/me/preferences', { data: { uiMode: 'work' } })
  })

  async function mention(page: Page, name: string) {
    await page.getByLabel('对话输入').pressSequentially('@')
    await page.getByRole('listbox', { name: '提及 Agent 或同事' }).getByRole('option', { name: new RegExp(`^${name}`) }).click()
  }

  test('他人 @ 产生提醒，两种模式都显示并在打开后清除；同时 @Agent 与同事；移出后不再显示', async ({ page, browser, baseURL }) => {
    const seed = await loadSeed(page)
    const owner = await openAs(browser, baseURL, 'U00001')
    // 接收人每种模式用一个新的 context：员工端会缓存上次的界面模式，接口改偏好后旧页面仍按缓存渲染。
    let receiver = await openAs(browser, baseURL, 'U00005')
    const members = `/api/workbench/v1/workspaces/${seed.workspaceId}/members`
    try {
      const joined = await owner.page.request.post(members, { data: { userId: 'U00005', role: 'member' } })
      expect(joined.ok()).toBeTruthy()
      // 提醒按现任成员在读取时复核：同一夹具上重跑时，上一轮移出前未读的提醒会随重新加入再次出现，先清空。
      const cleared = await receiver.page.request.post('/api/workbench/v1/me/mentions/read', { data: { workspaceId: seed.workspaceId } })
      expect(cleared.ok()).toBeTruthy()

      // 第 2 步：同一条消息同时 @ 同事与 Agent：交给 Agent 执行，同时提醒同事。
      await page.request.put('/api/workbench/v1/me/preferences', { data: { uiMode: 'collab' } })
      await page.goto(`/c/chats/group/${seed.workspaceId}`)
      const chat = page.getByRole('region', { name: '群聊' })
      await expect(page.getByLabel('对话输入')).toBeVisible()
      // 群聊里已有其他用例留下的同文案回复：按回复条数加 1 判断这次确实执行了。
      const replies = chat.locator('.conversation-message--assistant', { hasText: '受控测试运行已完成' })
      const repliesBefore = await replies.count()
      await mention(page, '陈默')
      await mention(page, '项目空间助手')
      const ask = uniqueTitle('MODE-17 请一起看')
      await page.getByLabel('对话输入').pressSequentially(ask)
      await page.getByRole('button', { name: '发送消息', exact: true }).click()
      await expect(replies).toHaveCount(repliesBefore + 1, { timeout: 20_000 })
      await expect(replies.last()).toContainText('由 周衡 发起')

      await expect.poll(async () => {
        const response = await receiver.page.request.get('/api/workbench/v1/me/mentions')
        return ((await response.json()).data.items as unknown[]).length
      }, { message: '陈默应收到一条 @ 提醒' }).toBe(1)

      // 第 3 步：接收人在协作模式看到“[有人@我]”。
      await receiver.page.request.put('/api/workbench/v1/me/preferences', { data: { uiMode: 'collab' } })
      await receiver.page.goto('/c/chats')
      const groupRow = receiver.page.getByRole('list', { name: '对话' }).getByRole('button', { name: /P1 项目空间/ })
      await expect(groupRow.getByTestId('conversation-mention')).toHaveText('[有人@我]')

      // 第 4 步：工作模式的空间卡片“有人@我”、讨论历史“@我”；打开讨论后清除。
      await receiver.page.request.put('/api/workbench/v1/me/preferences', { data: { uiMode: 'work' } })
      await receiver.context.close()
      receiver = await openAs(browser, baseURL, 'U00005')
      await receiver.page.goto('/workspaces')
      await expect(receiver.page.getByRole('button', { name: /P1 项目空间/ }).getByTestId('workspace-card-mention')).toHaveText('有人@我')
      await receiver.page.goto(`/workspaces/${seed.workspaceId}?tab=conversations&view=history`)
      const mentionedRow = receiver.page.getByTestId('session-history-row').filter({ has: receiver.page.getByTestId('session-history-mention') })
      await expect(mentionedRow).toHaveCount(1)
      await mentionedRow.click()
      await expect(receiver.page).toHaveURL(new RegExp(`/workspaces/${seed.workspaceId}/conversations/`))
      await expect.poll(async () => {
        const response = await receiver.page.request.get('/api/workbench/v1/me/mentions')
        return ((await response.json()).data.items as unknown[]).length
      }).toBe(0)
      await receiver.page.goto('/workspaces')
      await expect(receiver.page.getByRole('button', { name: /P1 项目空间/ })).toBeVisible()
      await expect(receiver.page.getByRole('button', { name: /P1 项目空间/ }).getByTestId('workspace-card-mention')).toHaveCount(0)

      // 第 5 步：再被 @ 一次后移出空间，提醒不再显示。
      const preset = page.getByRole('button', { name: '改为讨论' })
      const handOver = page.getByRole('button', { name: /^交给 @/ })
      await expect(preset.or(handOver)).toBeVisible()
      if (await preset.isVisible()) await preset.click()
      await expect(handOver).toBeVisible()
      await mention(page, '陈默')
      const again = uniqueTitle('MODE-17 再提醒')
      await page.getByLabel('对话输入').pressSequentially(again)
      await page.getByRole('button', { name: '发送消息', exact: true }).click()
      await expect(chat.locator('.user-message', { hasText: again })).toBeVisible()
      await expect.poll(async () => {
        const response = await receiver.page.request.get('/api/workbench/v1/me/mentions')
        return ((await response.json()).data.items as unknown[]).length
      }).toBe(1)

      const removed = await owner.page.request.delete(`${members}/U00005`)
      expect(removed.ok()).toBeTruthy()
      const after = await receiver.page.request.get('/api/workbench/v1/me/mentions')
      expect((await after.json()).data.items).toHaveLength(0)
      await receiver.page.goto('/workspaces')
      // 陈默没有其他空间：等列表加载完成（计数为 0）再断言已不在“P1 项目空间”。
      await expect(receiver.page.getByText('0 个可访问工作空间')).toBeVisible()
      await expect(receiver.page.getByRole('button', { name: /P1 项目空间/ })).toHaveCount(0)
    } finally {
      await owner.page.request.delete(`${members}/U00005`)
      await owner.context.close()
      await receiver.context.close()
    }
  })
})
