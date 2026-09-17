import { expect, test } from '@playwright/test'

/**
 * AG-AUTO-00：自动任务入口与配置反馈（P0 浏览器冒烟）。
 * 只证明导航、页面渲染、可访问名称与空/错误反馈；不证明 PostgreSQL、
 * DSH 或真实权限——那些由 P1 集成与 P2 验收覆盖。
 */
test('employee can open the automations page and inspect the empty state', async ({ page }) => {
  await page.goto('/workbench')

  await page.getByRole('button', { name: '自动任务' }).click()
  await expect(page).toHaveURL(/\/automations$/)
  await expect(page).toHaveTitle(/自动任务 · dsh-work/)
  await expect(page.getByRole('heading', { name: '我的自动任务' })).toBeVisible()

  // 原型模式：自动任务 API 读侧返回空集合 → 空态；写侧 503。
  // postgres 开发库：可能已有任务或同样为空——两者都属合法首屏。
  const emptyState = page.getByText('还没有自动任务', { exact: true })
  const errorAlert = page.getByText(/自动任务加载失败/)
  const listRegion = page.locator('.automation-list')
  await expect(emptyState.or(errorAlert).or(listRegion)).toBeVisible()
})

test('employee can open the create dialog and see required fields', async ({ page }) => {
  await page.goto('/automations')

  await page.getByRole('button', { name: '新建自动任务' }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('任务名称')).toBeVisible()
  await expect(dialog.getByText(/执行 Agent/)).toBeVisible()
  await expect(dialog.getByText('结果归属工作空间')).toBeVisible()
  await expect(dialog.getByText('执行规则')).toBeVisible()
  await expect(dialog.getByText(/任务内容/)).toBeVisible()

  // 未填必填项时创建按钮禁用，说明门禁在表单层可见。
  await expect(dialog.getByRole('button', { name: '创建' })).toBeDisabled()

  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toBeHidden()
})
