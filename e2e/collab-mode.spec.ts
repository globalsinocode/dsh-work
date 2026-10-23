import { expect, test, type Page } from '@playwright/test'

/**
 * 员工端双模式 S5a（e2e/TEST-CATALOG.md MODE-E2E-01～04，P0 浏览器冒烟）。
 * 冒烟服务的偏好存放在内存里，每个用例前重置，测试身份从缺省的工作模式开始。
 */

test.beforeEach(async ({ page }) => {
  await page.request.post('/api/testing/p0/reset')
})

async function chooseMode(page: Page, label: '工作模式' | '协作模式') {
  await page.getByRole('button', { name: '切换模式' }).click()
  await page.getByRole('menuitem', { name: new RegExp(label) }).click()
}

async function switchToCollab(page: Page, options: { narrow?: boolean } = {}) {
  await page.goto('/workbench')
  // 窄屏下工作模式的侧栏（含 logo）收起在“打开导航”之后，这是 A 的现有交互。
  if (options.narrow) await page.getByRole('button', { name: '打开导航' }).click()
  await chooseMode(page, '协作模式')
  await expect(page).toHaveURL(/\/c\/chats$/)
}

test('MODE-E2E-01: never-switched employees land in work mode and see the logo mode menu', async ({ page }) => {
  await page.goto('/workbench')
  const navigation = page.getByRole('navigation', { name: '员工工作台主导航' })
  await expect(navigation.getByRole('button')).toHaveText(['新对话', 'Skill 广场', 'AI 同事', '项目空间', '定时任务'])

  await page.getByRole('button', { name: '切换模式' }).click()
  await expect(page.getByRole('menuitem', { name: /工作模式.*当前模式/ })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /协作模式/ })).not.toContainText('当前模式')
  await expect(page.getByText('按账号记住选择；两种模式数据相同')).toBeVisible()

  // 点击菜单外关闭（键盘打开时焦点在菜单内，Esc 同样关闭）。
  await page.getByRole('heading', { level: 1 }).first().click()
  await expect(page.getByRole('menuitem', { name: /协作模式/ })).toBeHidden()
  await expect(page).toHaveURL(/\/workbench$/)
})

test('MODE-E2E-02: switching to collaboration mode is remembered per account', async ({ page, browser }) => {
  await switchToCollab(page)
  await expect(page.getByRole('navigation', { name: '协作模式主导航' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: '员工工作台主导航' })).toHaveCount(0)

  await page.reload()
  await expect(page).toHaveURL(/\/c\/chats$/)
  await expect(page.getByRole('navigation', { name: '协作模式主导航' })).toBeVisible()

  // 另一台设备：没有本地缓存，以服务端偏好为准。
  const otherDevice = await browser.newContext()
  try {
    const otherPage = await otherDevice.newPage()
    await otherPage.goto('/workbench')
    await expect(otherPage).toHaveURL(/\/c\/chats$/)
    await expect(otherPage.getByRole('navigation', { name: '协作模式主导航' })).toBeVisible()
  } finally {
    await otherDevice.close()
  }

  await chooseMode(page, '工作模式')
  await expect(page).toHaveURL(/\/workbench$/)
  await expect(page.getByRole('navigation', { name: '员工工作台主导航' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('navigation', { name: '员工工作台主导航' })).toBeVisible()
})

test('MODE-E2E-02: a failed save keeps the current mode', async ({ page }) => {
  await page.route('**/api/workbench/v1/me/preferences', route =>
    route.request().method() === 'PUT'
      ? route.fulfill({ status: 503, json: { error: { code: 'dependency_unavailable', message: '偏好服务暂不可用' } } })
      : route.fallback())
  await page.goto('/workbench')
  await chooseMode(page, '协作模式')
  await expect(page.getByText(/切换模式失败|偏好服务暂不可用/).first()).toBeVisible()
  await expect(page).toHaveURL(/\/workbench$/)
  await expect(page.getByRole('navigation', { name: '员工工作台主导航' })).toBeVisible()
})

test('MODE-E2E-03: collaboration shell has four entries and an avatar menu for shared pages', async ({ page }) => {
  await switchToCollab(page)
  const navigation = page.getByRole('navigation', { name: '协作模式主导航' })
  await expect(navigation.getByRole('button')).toHaveText(['对话', 'AI 同事', '群组', '定时任务'])
  await expect(navigation.getByRole('button', { name: '对话' })).toHaveAttribute('aria-current', 'page')

  await navigation.getByRole('button', { name: 'AI 同事' }).click()
  await expect(page).toHaveURL(/\/c\/agents$/)
  await expect(page.getByRole('heading', { name: 'AI 同事', exact: true })).toBeVisible()
  await navigation.getByRole('button', { name: '群组' }).click()
  await expect(page).toHaveURL(/\/c\/groups$/)
  await expect(page.getByRole('heading', { name: '群组', exact: true })).toBeVisible()
  await expect(navigation.getByRole('button', { name: '群组' })).toHaveAttribute('aria-current', 'page')
  await navigation.getByRole('button', { name: '定时任务' }).click()
  await expect(page).toHaveURL(/\/automations$/)
  await expect(page).toHaveTitle(/定时任务 · dsh-work/)
  await expect(page.getByRole('heading', { name: '我的定时任务' })).toBeVisible()
  await expect(navigation).toBeVisible()

  for (const [item, path, heading] of [
    ['用户中心', /\/settings$/, '用户中心'],
    ['Skill 广场', /\/skills$/, undefined],
    ['我的文件', /\/files/, '我的文件'],
    ['历史对话', /\/history/, '历史对话'],
  ] as const) {
    await page.getByRole('button', { name: '打开用户菜单' }).click()
    await page.getByRole('menuitem', { name: item }).click()
    await expect(page).toHaveURL(path)
    if (heading) await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
    await expect(navigation).toBeVisible()
  }
})

test('MODE-E2E-03: collaboration shell uses a bottom tab bar on narrow screens', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 760 })
  await switchToCollab(page, { narrow: true })
  const navigation = page.getByRole('navigation', { name: '协作模式主导航' })
  await expect(navigation.getByRole('button')).toHaveText(['对话', 'AI 同事', '群组', '定时任务'])
  const box = await navigation.boundingBox()
  expect(box?.y ?? 0).toBeGreaterThan(600)
  await navigation.getByRole('button', { name: '群组' }).click()
  await expect(page).toHaveURL(/\/c\/groups$/)
  await expect(page.getByRole('button', { name: '打开用户菜单' })).toBeVisible()
  await expect(page.getByRole('button', { name: '切换模式' })).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

test('MODE-E2E-04: work-mode links, bookmarks and notifications land on the collaboration counterpart', async ({ page }) => {
  await switchToCollab(page)
  for (const [from, to] of [
    ['/workbench', /\/c\/chats$/],
    ['/workspaces', /\/c\/groups$/],
    ['/agents', /\/c\/agents$/],
    ['/workspaces/ws-supply', /\/c\/chats\/group\/ws-supply$/],
    ['/workspaces/ws-supply?tab=files', /\/c\/chats\/group\/ws-supply\?tab=files$/],
    ['/workspaces/ws-supply/tasks/ptask-1', /\/c\/chats\/group\/ws-supply\/tasks\/ptask-1$/],
    // 个人对话落到所属 AI 同事的单聊并定位到该段（S5c）；项目空间对话落到群组。
    ['/conversations/run-260827-002', /\/c\/chats\/agent\/dsh-work-assistant\?session=session-0991$/],
    ['/conversations/run-260828-001', /\/c\/chats\/group\/ws-supply\?session=session-1001$/],
    ['/workbench?agent=agent-ops', /\/c\/chats\/agent\/agent-ops$/],
    ['/automations', /\/automations$/],
    ['/settings', /\/settings$/],
  ] as const) {
    await page.goto(from)
    await expect(page).toHaveURL(to)
  }
  await expect(page.getByRole('navigation', { name: '协作模式主导航' })).toBeVisible()
})

test('MODE-E2E-04: collaboration links map back in work mode and switching keeps the place', async ({ page }) => {
  for (const [from, to] of [
    ['/c/chats', /\/workbench$/],
    ['/c/groups', /\/workspaces$/],
    ['/c/agents/agent-ops', /\/agents$/],
    ['/c/chats/group/ws-supply?tab=files', /\/workspaces\/ws-supply\?tab=files$/],
    ['/c/unknown', /\/workbench$/],
  ] as const) {
    await page.goto(from)
    await expect(page).toHaveURL(to)
  }

  await page.goto('/workspaces/ws-supply?tab=files')
  await expect(page.getByRole('tab', { name: /共享文件/ })).toHaveAttribute('aria-selected', 'true')
  await chooseMode(page, '协作模式')
  await expect(page).toHaveURL(/\/c\/chats\/group\/ws-supply\?tab=files$/)
  await chooseMode(page, '工作模式')
  await expect(page).toHaveURL(/\/workspaces\/ws-supply\?tab=files$/)
  await expect(page.getByRole('tab', { name: /共享文件/ })).toHaveAttribute('aria-selected', 'true')
})

test('MODE-E2E-06: the chat list groups personal conversations by AI colleague and lists groups', async ({ page }) => {
  await switchToCollab(page)
  const list = page.getByRole('list', { name: '对话' })
  const rows = list.getByRole('button')
  await expect(rows).toHaveCount(3)
  // 同一 AI 同事的多次对话聚合为一行；群组各一行，按最近活动排序。
  await expect(list.getByRole('button', { name: /^dsh-work Assistant/ })).toHaveCount(1)
  await expect(rows.first()).toContainText('供应链经营分析')
  await expect(list.getByRole('button', { name: /^dsh-work Assistant/ })).toContainText('委外加工发料')

  await page.getByLabel('搜索对话').fill('月度')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('月度经营复盘')
  await page.getByLabel('搜索对话').fill('不存在的名称')
  await expect(page.getByText('没有匹配的对话')).toBeVisible()
  await page.getByLabel('搜索对话').fill('')
  await expect(rows).toHaveCount(3)

  await page.getByRole('button', { name: '发起对话或新建群组' }).click()
  await expect(page.getByRole('menuitem', { name: /新建群组/ })).not.toHaveAttribute('aria-disabled', 'true')
  await page.getByRole('menuitem', { name: /发起对话/ }).click()
  await page.getByRole('dialog', { name: '发起对话' }).getByRole('button', { name: '与 dsh-work Assistant 对话' }).click()
  await expect(page).toHaveURL(/\/c\/chats\/agent\/dsh-work-assistant$/)
  await expect(page.getByRole('heading', { name: 'dsh-work Assistant', level: 1 })).toBeVisible()
})

test('MODE-E2E-07: a 1:1 chat shows its sessions with topic dividers and offers to start a new one after a version change', async ({ page }) => {
  await switchToCollab(page)
  await page.getByRole('list', { name: '对话' }).getByRole('button', { name: /^dsh-work Assistant/ }).click()
  const chat = page.getByRole('region', { name: '与 dsh-work Assistant 的对话' })
  await expect(chat.getByText(/^查询委外加工发料制度 · /)).toBeVisible()
  await expect(chat.getByText('公司的委外加工业务应该如何处理发料和库存扣减？')).toBeVisible()
  await expect(chat.getByRole('button', { name: '复制回答' })).toBeVisible()
  // 夹具中这段对话固定在旧版本：发送时会开始新的对话（P1 覆盖真实续写与新会话）。
  await expect(page.getByTestId('new-session-notice')).toBeVisible()
  await expect(page.getByLabel('对话输入')).toBeVisible()
})

test('MODE-E2E-06/07: narrow screens go from the list to a chat and back', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await switchToCollab(page, { narrow: true })
  await page.getByRole('list', { name: '对话' }).getByRole('button', { name: /^dsh-work Assistant/ }).click()
  await expect(page.getByRole('list', { name: '对话' })).toBeHidden()
  await expect(page.getByRole('heading', { name: 'dsh-work Assistant', level: 1 })).toBeVisible()
  await page.getByRole('button', { name: '返回对话列表' }).click()
  await expect(page).toHaveURL(/\/c\/chats$/)
  await expect(page.getByRole('list', { name: '对话' })).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

test('MODE-E2E-08: conversation links land on the owning chat, missing ones explain why', async ({ page }) => {
  await switchToCollab(page)
  await page.goto('/conversations/run-260827-002')
  await expect(page).toHaveURL(/\/c\/chats\/agent\/dsh-work-assistant\?session=session-0991$/)
  await expect(page.getByRole('region', { name: '查询委外加工发料制度 · ', exact: false })).toBeVisible()

  await chooseMode(page, '工作模式')
  await expect(page).toHaveURL(/\/conversations\/session-0991$/)

  await chooseMode(page, '协作模式')
  // 等切换完成再跳转，否则链接仍按工作模式解析。
  await expect(page).toHaveURL(/\/c\//)
  await page.goto('/conversations/run-does-not-exist')
  await expect(page).toHaveURL(/\/c\/chats$/)
  await expect(page.getByText('对话不存在或你没有访问权限')).toBeVisible()
})

test('MODE-E2E-09/10: a group shows its chat timeline, the shared tabs and the group info', async ({ page }) => {
  await switchToCollab(page)
  await page.getByRole('list', { name: '对话' }).getByRole('button', { name: /^周林赵王供应链经营分析|供应链经营分析/ }).first().click()
  await expect(page).toHaveURL(/\/c\/chats\/group\/ws-supply$/)
  await expect(page.getByRole('heading', { name: '供应链经营分析', level: 1 })).toBeVisible()
  await expect(page.getByRole('tab')).toHaveText([/^对话/, /^任务/, /^文件/, /^成果/, /^档案/])
  await expect(page.getByRole('tab', { name: '对话' })).toHaveAttribute('aria-selected', 'true')
  const chat = page.getByRole('region', { name: '群聊' })
  await expect(chat.getByText(/^分析华东区本月订单交付风险 · /)).toBeVisible()
  await expect(chat.getByTestId('group-system-record').first()).toContainText('创建了群组')
  // 冒烟夹具的空间没有 Agent 成员：按 12.8 提示先添加 Agent。
  await expect(page.getByTestId('group-no-agent-notice')).toBeVisible()

  await chat.getByTestId('group-run-record').first().click()
  await expect(page).toHaveURL(/\/c\/chats\/group\/ws-supply\/conversations\/run-/)

  await page.getByRole('tab', { name: /^文件/ }).click()
  await expect(page).toHaveURL(/\/c\/chats\/group\/ws-supply\?tab=files$/)
  // 文件页签就是工作模式的“共享文件”页签内容（同一组件）。
  await expect(page.locator('#workspace-panel-files').getByText('八月生产计划_v3.xlsx', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: '群信息', exact: true }).click()
  await expect(page).toHaveURL(/info=1/)
  await expect(page.getByText('群信息', { exact: true }).last()).toBeVisible()
  await expect(page.getByText('项目简报').first()).toBeVisible()

  // 切回工作模式：所在页签映射回项目空间的同一页签。
  await chooseMode(page, '工作模式')
  await expect(page).toHaveURL(/\/workspaces\/ws-supply\?tab=files$/)
})

test('MODE-E2E-10: task details open inside the group and map to work mode', async ({ page }) => {
  const created = await page.request.post('/api/workbench/v1/workspaces/ws-supply/project-tasks', {
    data: { title: 'MODE-10 冒烟任务', assignee: { type: 'employee', id: 'U00001' } },
  })
  expect(created.ok()).toBeTruthy()
  const taskId = (await created.json()).data.id as string
  await switchToCollab(page)
  await page.goto('/c/chats/group/ws-supply?tab=tasks')
  await page.getByTestId('project-task-open').filter({ hasText: 'MODE-10 冒烟任务' }).click()
  await expect(page).toHaveURL(new RegExp(`/c/chats/group/ws-supply/tasks/${taskId}$`))
  await expect(page.getByTestId('workspace-crumb-task')).toHaveText('MODE-10 冒烟任务')
  await page.getByTestId('workspace-crumb-tasks').click()
  await expect(page).toHaveURL(/\/c\/chats\/group\/ws-supply\?tab=tasks$/)
  await page.goto(`/workspaces/ws-supply/tasks/${taskId}`)
  await expect(page).toHaveURL(new RegExp(`/c/chats/group/ws-supply/tasks/${taskId}$`))
})

test('MODE-E2E-11: AI colleague and group directories open the matching chats', async ({ page }) => {
  await switchToCollab(page)
  await page.getByRole('navigation', { name: '协作模式主导航' }).getByRole('button', { name: 'AI 同事' }).click()
  await expect(page.getByRole('heading', { name: 'AI 同事', level: 1 })).toBeVisible()
  await page.getByRole('button', { name: /dsh-work Assistant/ }).first().click()
  await expect(page).toHaveURL(/\/c\/agents\/dsh-work-assistant$/)
  await page.getByRole('button', { name: '发消息' }).click()
  await expect(page).toHaveURL(/\/c\/chats\/agent\/dsh-work-assistant$/)

  await page.getByRole('navigation', { name: '协作模式主导航' }).getByRole('button', { name: '群组' }).click()
  await expect(page.getByRole('heading', { name: '群组', level: 1 })).toBeVisible()
  await page.getByRole('button', { name: /供应链经营分析/ }).first().click()
  await expect(page).toHaveURL(/\/c\/groups\/ws-supply$/)
  // 原型的居中详情：名称、状态与任务信息卡片、成员。
  const detail = page.getByRole('region', { name: '详情' })
  await expect(detail.getByRole('heading', { name: '供应链经营分析', level: 2 })).toBeVisible()
  await expect(detail.getByText('状态', { exact: true })).toBeVisible()
  await expect(detail.getByRole('region', { name: '成员' })).toBeVisible()
  await expect(page.getByRole('group', { name: '群组筛选' }).getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: '管理群组' }).click()
  await expect(page).toHaveURL(/\/c\/chats\/group\/ws-supply\?info=1$/)
})

test('MODE-E2E-12: creating a group or project space requires choosing an AI colleague', async ({ page }) => {
  await switchToCollab(page)
  await page.goto('/c/groups')
  await page.getByRole('button', { name: '新建群组' }).click()
  const dialog = page.getByRole('dialog', { name: '新建群组' })
  await dialog.getByLabel('群组名称').fill('MODE-12 新群组')
  const submit = dialog.getByRole('button', { name: '创建群组' })
  // 只有一位 AI 同事时默认选中；取消选择后不能提交。
  await expect(submit).toBeEnabled()
  const agent = dialog.getByRole('checkbox', { name: /dsh-work Assistant/ })
  await expect(agent).toBeChecked()
  // Element Plus 复选框的原生 input 不可见，点击其可见标签切换。
  await dialog.getByRole('region', { name: 'AI 同事' }).getByText('dsh-work Assistant', { exact: true }).click()
  await expect(agent).not.toBeChecked()
  await expect(dialog.getByText('至少选择一位 AI 同事')).toBeVisible()
  await expect(submit).toBeDisabled()
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toBeHidden()

  await chooseMode(page, '工作模式')
  // 偏好保存成功后才切换并离开协作模式地址；先等切换完成，否则随后的跳转仍按协作模式重定向。
  await expect(page).not.toHaveURL(/\/c\//)
  await page.goto('/workspaces')
  await page.getByRole('button', { name: '创建项目空间' }).click()
  const workDialog = page.getByRole('dialog', { name: '创建项目空间' })
  await expect(workDialog.getByRole('region', { name: 'AI 同事' })).toBeVisible()
})

test('MODE-E2E-14: the new-group picker selects AI colleagues and colleagues together', async ({ page }) => {
  await switchToCollab(page)
  await page.goto('/c/groups')
  await page.getByRole('button', { name: '新建群组' }).click()
  const dialog = page.getByRole('dialog', { name: '新建群组' })
  const agents = dialog.getByRole('region', { name: 'AI 同事' })
  const people = dialog.getByRole('region', { name: '同事' })
  const selected = dialog.getByRole('complementary', { name: '已选成员' })
  await expect(agents.getByRole('checkbox', { name: /dsh-work Assistant/ })).toBeChecked()
  // 同事候选不含本人（冒烟身份林岚）。
  await expect(people.getByText('周衡', { exact: true })).toBeVisible()
  await expect(people.getByText('林岚', { exact: true })).toHaveCount(0)
  await expect(selected.getByRole('heading', { name: '已选 1' })).toBeVisible()

  // 栏标题全选当前显示的同事；“已选”逐个移除。
  // Element Plus 复选框的原生 input 不可见，点击其可见标签切换。
  await people.getByLabel('全选同事', { exact: true }).click()
  await expect(selected.getByRole('heading', { name: '已选 4' })).toBeVisible()
  await selected.getByRole('button', { name: '移除 赵宁' }).click()
  await expect(people.getByRole('checkbox', { name: /赵宁/ })).not.toBeChecked()
  await expect(selected.getByRole('heading', { name: '已选 3' })).toBeVisible()

  // 搜索同时过滤两栏，已选不受影响。
  await dialog.getByRole('textbox', { name: '搜索 AI 同事或同事' }).fill('王')
  await expect(agents.getByText('没有匹配的 AI 同事')).toBeVisible()
  await expect(people.getByText('周衡', { exact: true })).toHaveCount(0)
  await expect(people.getByText('王呈', { exact: true })).toBeVisible()
  await expect(people.getByRole('checkbox', { name: /王呈/ })).toBeChecked()
  await expect(selected.getByText('dsh-work Assistant')).toBeVisible()

  await dialog.getByLabel('群组名称').fill('MODE-14 新群组')
  await expect(dialog.getByRole('button', { name: '创建群组' })).toBeEnabled()
})

test('MODE-E2E-13: unread counts show in the chat list and clear when the conversation is opened', async ({ page }) => {
  await switchToCollab(page)
  const list = page.getByRole('list', { name: '对话' })
  const group = list.getByRole('button', { name: /供应链经营分析/ }).first()
  const agent = list.getByRole('button', { name: /^dsh-work Assistant/ })
  // 冒烟夹具：未读数为该对话对象中 AI 同事回复的条数，可访问名称含“N 条未读”。
  await expect(group).toHaveAccessibleName(/\d+ 条未读/)
  await expect(agent).toHaveAccessibleName(/\d+ 条未读/)

  await group.click()
  await expect(page).toHaveURL(/\/c\/chats\/group\/ws-supply$/)
  await expect(group.getByTestId('conversation-unread')).toHaveCount(0)
  await expect(agent.getByTestId('conversation-unread')).toHaveCount(1)

  // 已读保存在服务端：重新加载后仍为已读，未打开的对话仍有未读。
  await page.reload()
  await expect(list.getByRole('button', { name: /^dsh-work Assistant/ })).toHaveAccessibleName(/\d+ 条未读/)
  await expect(list.getByRole('button', { name: /供应链经营分析/ }).first().getByTestId('conversation-unread')).toHaveCount(0)
})
