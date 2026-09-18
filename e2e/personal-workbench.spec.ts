import { expect, test } from '@playwright/test'

test('P0: personal Workspace is implicit, navigation exposes work entries', async ({ page }) => {
  await page.goto('/workbench')
  const navigation = page.getByRole('navigation', { name: '员工工作台主导航' })
  // D12 收敛的四个工作入口 + AG-03 既有「自动任务」（已决定保留为第五入口）。
  await expect(navigation.getByRole('button')).toHaveText(['新对话', '历史对话', '我的文件', '团队空间', '自动任务'])
  await expect(page.getByLabel('选择工作空间')).toHaveCount(0)
  await expect(page.getByLabel('当前工作空间')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '选择 Skill', exact: true })).toBeVisible()
  await navigation.getByRole('button', { name: '团队空间', exact: true }).click()
  await expect(page.getByRole('heading', { name: '团队空间', exact: true })).toBeVisible()
  await expect(page.getByRole('button').filter({ hasText: '我的空间' })).toHaveCount(0)
  await navigation.getByRole('button', { name: '新对话', exact: true }).click()
  await expect(page.getByLabel('选择工作空间')).toHaveCount(0)
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
