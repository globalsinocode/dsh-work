import { expect, test } from '@playwright/test'

// P2-28：每个 P0 用例从同一份内存夹具开始，避免可变状态跨用例泄漏。
test.beforeEach(async ({ page }) => {
  await page.request.post('/api/testing/p0/reset')
})

/**
 * AG-AUTO-00：定时任务入口与配置反馈（P0 浏览器冒烟）。
 * 只证明导航、页面渲染、可访问名称与空/错误反馈；不证明 PostgreSQL、
 * DSH 或真实权限——那些由 P1 集成与 P2 验收覆盖。
 */
test('employee can open the automations page and inspect the empty state', async ({ page }) => {
  await page.goto('/workbench')

  await page.getByRole('button', { name: '定时任务' }).click()
  await expect(page).toHaveURL(/\/automations$/)
  await expect(page).toHaveTitle(/定时任务 · dsh-work/)
  await expect(page.getByRole('heading', { name: '我的定时任务' })).toBeVisible()

  // 原型模式：定时任务 API 读侧返回空集合 → 空态；写侧 503。
  // postgres 开发库：可能已有任务或同样为空——两者都属合法首屏。
  const emptyState = page.getByText('还没有定时任务', { exact: true })
  const errorAlert = page.getByText(/定时任务加载失败/)
  const listRegion = page.locator('.automation-list')
  await expect(emptyState.or(errorAlert).or(listRegion)).toBeVisible()
})

test('AI colleague routine results live in their own tab', async ({ page }) => {
  await page.goto('/automations')

  // 主动任务结果在独立页签，原型模式为空集合。
  await page.getByRole('tab', { name: /AI 同事主动任务结果/ }).click()
  await expect(page.getByText('暂无可查看的主动任务结果', { exact: true })).toBeVisible()
})

test('employee can open the create dialog, pick weekdays and see the next-run preview', async ({ page }) => {
  await page.goto('/automations')

  await page.getByRole('button', { name: '新建定时任务' }).first().click()
  const dialog = page.getByRole('dialog', { name: '新建定时任务' })
  await expect(dialog).toBeVisible()
  for (const group of ['做什么', '什么时候', '结果放在哪']) {
    await expect(dialog.getByRole('heading', { name: group, exact: true })).toBeVisible()
  }
  await expect(dialog.getByText('任务名称', { exact: true })).toBeVisible()
  await expect(dialog.getByText('执行的 AI 同事', { exact: true })).toBeVisible()
  await expect(dialog.getByText('结果归属空间', { exact: true })).toBeVisible()
  await expect(dialog.getByText('执行规则', { exact: true })).toBeVisible()
  await expect(dialog.getByText('任务内容', { exact: true })).toBeVisible()

  // 下次运行时间由服务端规则预览给出（与调度共用日历）。
  await expect(dialog.getByRole('status')).toContainText('启用后接下来将在')

  await dialog.getByText('每周', { exact: true }).click()
  const monday = dialog.getByRole('button', { name: '周一', exact: true })
  await expect(monday).toHaveAttribute('aria-pressed', 'true')
  await monday.click()
  await expect(monday).toHaveAttribute('aria-pressed', 'false')
  await expect(dialog.getByRole('status')).toHaveText('请至少选择一天')
  await dialog.getByRole('button', { name: '周三', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('启用后接下来将在')

  await dialog.getByText('仅手动', { exact: true }).click()
  await expect(dialog.getByText('不会自动执行，需要时在列表中点“立即运行”。')).toBeVisible()

  // 未填必填项时创建按钮禁用，说明门禁在表单层可见。
  await expect(dialog.getByRole('button', { name: '创建' })).toBeDisabled()

  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toBeHidden()
})
