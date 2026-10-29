import { expect, test, type Page } from '@playwright/test'

/**
 * SHELL-HEADER-01：有标题的列表页共用固定顶部区域（P0 浏览器冒烟）。
 * 只证明结构与吸顶表现；页面数据在原型模式下可能为空或不可用，不影响页头。
 */

test.beforeEach(async ({ page }) => {
  await page.request.post('/api/testing/p0/reset')
})

const pages: Array<[path: string, title: string]> = [
  ['/automations', '我的定时任务'],
  ['/workspaces', '项目空间'],
  ['/history', '历史对话'],
  ['/files', '我的文件'],
  ['/settings', '用户中心'],
]

function pageBanner(page: Page, title: string) {
  return page.locator('header', { has: page.getByRole('heading', { name: title, level: 1, exact: true }) })
}

/** 撑高页头所在的内容区（模拟长列表）后滚动，返回滚动后页头的顶部位置。 */
async function scrollAndMeasure(page: Page, title: string) {
  await pageBanner(page, title).evaluate((banner) => {
    if (banner.parentElement) banner.parentElement.style.minHeight = '3000px'
  })
  await page.evaluate(() => window.scrollTo(0, 800))
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
  return (await pageBanner(page, title).boundingBox())?.y
}

for (const [path, title] of pages) {
  test(`SHELL-HEADER-01: ${title} uses the compact sticky page header`, async ({ page }) => {
    await page.goto(path)

    const banner = pageBanner(page, title)
    await expect(banner).toBeVisible()
    await expect(banner.locator('p')).toHaveCount(0)

    // 占满内容区宽度，不进入左侧导航；高度保持紧凑。
    const navigation = await page.getByRole('navigation', { name: '员工工作台主导航' }).boundingBox()
    const box = await banner.boundingBox()
    expect(box && navigation && box.x >= navigation.x + navigation.width - 1).toBe(true)
    expect(box && box.x + box.width).toBeGreaterThanOrEqual((page.viewportSize()?.width ?? 0) - 1)
    expect(box?.height ?? 999).toBeLessThanOrEqual(64)

    expect(await scrollAndMeasure(page, title)).toBeCloseTo(0, 0)
  })
}

test('SHELL-HEADER-01: on narrow screens the header clears the menu button and the collaboration top bar', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 760 })

  // 工作模式：左上角浮动菜单按钮不压住标题。
  await page.goto('/automations')
  const heading = page.getByRole('heading', { name: '我的定时任务', level: 1 })
  const menu = await page.getByRole('button', { name: '打开导航' }).boundingBox()
  const headingBox = await heading.boundingBox()
  expect(menu && headingBox && headingBox.x >= menu.x + menu.width).toBe(true)

  // 协作模式：页头吸在 52px 固定顶栏之下。
  await page.getByRole('button', { name: '打开导航' }).click()
  await page.getByRole('button', { name: '切换模式' }).click()
  await page.getByRole('menuitem', { name: /协作模式/ }).click()
  // 定时任务是两种模式的共用页，切换后停留在原地。
  await expect(page.getByRole('navigation', { name: '协作模式主导航' })).toBeVisible()
  await expect(page).toHaveURL(/\/automations$/)
  await expect(pageBanner(page, '我的定时任务')).toBeVisible()
  expect(await scrollAndMeasure(page, '我的定时任务')).toBeCloseTo(52, 0)
})
