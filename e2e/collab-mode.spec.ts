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

async function switchToCollab(page: Page) {
  await page.goto('/workbench')
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

  await page.keyboard.press('Escape')
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
  await switchToCollab(page)
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
    ['/workspaces/ws-supply/tasks/ptask-1', /\/c\/chats\/group\/ws-supply\?tab=tasks&task=ptask-1$/],
    ['/conversations/run-1', /\/c\/chats\?conversation=run-1$/],
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
