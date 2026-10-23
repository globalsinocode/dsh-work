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
  await expect(page.getByRole('menuitem', { name: /新建群组/ })).toHaveAttribute('aria-disabled', 'true')
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
  await page.goto('/conversations/run-does-not-exist')
  await expect(page).toHaveURL(/\/c\/chats$/)
  await expect(page.getByText('对话不存在或你没有访问权限')).toBeVisible()
})
