import { expect, test, type Page } from '@playwright/test'

// P2-28：每个 P0 用例从同一份内存夹具开始，避免可变状态跨用例泄漏。
test.beforeEach(async ({ page }) => {
  await page.request.post('/api/testing/p0/reset')
})

/** SKC-04：冒烟数据中的 Skill 创建专家默认停用，经管理端接口启用（冒烟服务只有一个测试身份）。 */
async function enableSkillCreator(page: Page) {
  const enabled = await page.request.patch('/api/admin/v1/agents/skill-creator/status', { data: { status: 'published' } })
  expect(enabled.ok()).toBeTruthy()
}

test('P0: personal Workspace is implicit, navigation exposes work entries', async ({ page }) => {
  await page.goto('/workbench')
  const navigation = page.getByRole('navigation', { name: '员工工作台主导航' })
  // 历史对话与我的文件保留上下文入口和直达路由，不进入员工主导航。
  await expect(navigation.getByRole('button')).toHaveText(['新对话', 'Skill 广场', 'AI 同事', '项目空间', '知识库', '定时任务'])
  await expect(page.getByLabel('选择工作空间')).toHaveCount(0)
  await expect(page.getByLabel('当前工作空间')).toHaveCount(0)
  await page.getByRole('button', { name: '添加内容' }).click()
  await expect(page.getByRole('menuitem', { name: '我的文件' })).toBeVisible()
  await navigation.getByRole('button', { name: 'Skill 广场', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Skill 分类筛选' })).toBeVisible()
  const useSkill = page.getByRole('button', { name: /^使用 Skill：/ }).first()
  await expect(useSkill).toBeVisible()
  await useSkill.click()
  await expect(page).toHaveURL(/\/workbench\?skill=/)
  await expect(page.getByText('本次对话使用 Skill').or(page.getByText(/^@/))).toBeVisible()
  await navigation.getByRole('button', { name: 'AI 同事', exact: true }).click()
  await expect(page.getByLabel('AI 同事列表')).toBeVisible()
  const useAgent = page.getByRole('button', { name: /^与 AI 同事开始对话：/ }).first()
  await expect(useAgent).toBeVisible()
  await useAgent.click()
  await expect(page).toHaveURL(/\/workbench\?agent=/)
  await expect(page.getByLabel('已选择 AI 同事', { exact: true })).toBeVisible()
  await navigation.getByRole('button', { name: '项目空间', exact: true }).click()
  await expect(page.getByRole('heading', { name: '项目空间', exact: true })).toBeVisible()
  await expect(page.getByRole('button').filter({ hasText: '我的空间' })).toHaveCount(0)
  await navigation.getByRole('button', { name: '新对话', exact: true }).click()
  await expect(page.getByLabel('选择工作空间')).toHaveCount(0)
})

test('NC-03: the sidebar bell above the avatar opens notifications and jumps to the project', async ({ page }) => {
  await page.goto('/workbench')
  // 通知入口不进入主导航（仍是五个入口），位于侧栏底部头像上方。
  await expect(page.getByRole('navigation', { name: '员工工作台主导航' }).getByRole('button')).toHaveCount(6)
  const bell = page.getByRole('button', { name: '通知，2 条未读' })
  const avatar = page.getByRole('button', { name: '打开用户中心' })
  await expect(bell).toBeVisible()
  const [bellBox, avatarBox] = [await bell.boundingBox(), await avatar.boundingBox()]
  expect((bellBox?.y ?? 0) + (bellBox?.height ?? 0)).toBeLessThanOrEqual(avatarBox?.y ?? 0)

  await bell.click()
  const panel = page.getByRole('dialog', { name: '通知' })
  await expect(panel).toBeVisible()
  const list = panel.getByRole('list', { name: '通知列表' })
  // 按时间倒序：最新的 @ 我在最前，已不可见的最早一条在最后。
  const items = list.getByRole('button')
  await expect(items).toHaveCount(4)
  await expect(items.nth(0)).toHaveAccessibleName(/^未读：周敏 在 「供应链经营分析」 中 @ 了你，/)
  await expect(items.nth(1)).toHaveAccessibleName(/^未读：周敏 把你加入了项目/)
  await expect(items.nth(2)).toHaveAccessibleName(/^周敏 把任务 「核对华东安全库存」 指派给你/)
  await expect(items.nth(3)).toHaveAccessibleName(/^一条通知（该内容已不可见）/)
  await panel.getByRole('tab', { name: '未读 2' }).click()
  await expect(list.getByRole('button')).toHaveCount(2)
  await panel.getByRole('tab', { name: '全部' }).click()

  // 已不可见的通知点了不跳转，就地提示。
  await list.getByRole('button', { name: '一条通知（该内容已不可见）' }).click()
  await expect(page.getByText('该内容已不可见', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/\/workbench$/)

  await list.getByRole('button', { name: /把你加入了项目/ }).click()
  await expect(panel).toBeHidden()
  await expect(page).toHaveURL(/\/workspaces\/ws-supply/)
  await expect(page.getByRole('button', { name: '通知，1 条未读' })).toBeVisible()

  await page.getByRole('button', { name: '通知，1 条未读' }).click()
  await panel.getByRole('button', { name: '全部标为已读' }).click()
  await expect(page.getByRole('button', { name: '通知', exact: true })).toBeVisible()
  await panel.getByRole('tab', { name: '未读' }).click()
  await expect(panel.getByText('暂时没有未读通知')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
})

test('NC-03: on narrow screens the bell stays in the side menu and the panel is full screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 760 })
  await page.goto('/workbench')
  await expect(page.getByTestId('mobile-menu-notification-dot')).toBeVisible()
  await page.getByRole('button', { name: '打开导航' }).click()
  await page.getByRole('button', { name: '通知，2 条未读' }).click()
  const panel = page.getByRole('dialog', { name: '通知' })
  await expect(panel).toBeVisible()
  const box = await panel.boundingBox()
  expect(box?.x ?? -1).toBe(0)
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(370)
  await panel.getByRole('button', { name: /把你加入了项目/ }).click()
  await expect(page).toHaveURL(/\/workspaces\/ws-supply/)
  // 跳转后侧栏收起（移出视口），回到页面。
  await expect(page.getByRole('navigation', { name: '员工工作台主导航' })).not.toBeInViewport()
  await expect(page.getByTestId('mobile-menu-notification-dot')).toBeVisible()

  // 读完全部后，菜单按钮上的未读圆点消失。
  await page.getByRole('button', { name: '打开导航' }).click()
  await page.getByRole('button', { name: '通知，1 条未读' }).click()
  await panel.getByRole('button', { name: '全部标为已读' }).click()
  await panel.getByRole('button', { name: '关闭通知' }).click()
  await expect(page.getByTestId('mobile-menu-notification-dot')).toHaveCount(0)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
})

test('SKC-04: Skill plaza opens a new chat with the Skill creator, nothing prefilled', async ({ page }) => {
  await enableSkillCreator(page)
  await page.goto('/skills')
  await expect(page.getByRole('navigation', { name: 'Skill 分类筛选' })).toBeVisible()
  await page.getByRole('button', { name: '创建 Skill' }).click()
  await expect(page).toHaveURL(/\/workbench\?agent=skill-creator$/)
  await expect(page.getByLabel('已选择 AI 同事', { exact: true })).toContainText('Skill 创建专家')
  await expect(page.getByText('你好，我可以帮你把常用的工作方法做成 Skill', { exact: false })).toBeVisible()
  await expect(page.getByLabel('对话输入')).toHaveValue('')
})

test('P0: legacy personal links redirect after the server authorizes the workspace', async ({ page }) => {
  const spaces = await page.request.get('/api/workbench/v1/workspaces')
  const personal = (await spaces.json()).data.find((row: { type: string }) => row.type === 'personal')
  expect(personal).toBeTruthy()
  await page.goto(`/workspaces/${personal.id}?tab=files`)
  await expect(page).toHaveURL(/\/files\?source=material$/)
  await expect(page.getByRole('heading', { name: '我的文件', exact: true })).toBeVisible()
  // P0 has no persistence; a clear capability error is intentional, never a fake successful file list.
  await expect(page.getByRole('alert').filter({ hasText: '不可用' })).toBeVisible()
  await page.goto('/workspaces/ws-personal-nonexistent')
  await expect(page.getByText('工作空间不存在或你没有访问权限', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/ws-personal-nonexistent$/)
})
