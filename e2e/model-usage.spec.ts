import { expect, test, type Page } from '@playwright/test'

// ADMIN-E2E-06（e2e/catalog/admin-platform.md）：模型用量按时间范围、维度与下钻查看。
// P0 冒烟数据为确定性内存数据（server/src/testing/p0-smoke/model-usage-service.ts），不代表真实计量。
const adminUrl = `http://localhost:${process.env.DSH_WORK_ADMIN_PORT ?? 4180}`

async function openModelUsage(page: Page) {
  await page.goto(`${adminUrl}/overview`)
  await page.getByRole('navigation', { name: '管理后台主导航' }).getByRole('button', { name: '模型用量' }).click()
  await expect(page).toHaveURL(`${adminUrl}/model-usage`)
  await expect(page.getByRole('region', { name: '用量概况' }).getByText('Token 合计')).toBeVisible()
}

test('administrator reviews model usage by range, dimension and drill-down', async ({ page }) => {
  await openModelUsage(page)
  const overview = page.getByRole('region', { name: '用量概况' })
  await expect(overview.getByText('缓存命中率')).toBeVisible()
  await expect(overview.getByText('模型请求')).toBeVisible()
  await expect(page.getByRole('heading', { name: /Token 趋势（按天/ })).toBeVisible()
  await expect(page.getByText(/估算数据/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /导出/ })).toHaveCount(0)

  // 近 30 天包含模型网关上线前的估算数据
  await page.getByRole('radio', { name: '近 30 天' }).check({ force: true })
  await expect(page.getByText(/当前范围含 [\d.]+% 估算数据/)).toBeVisible()
  await expect(page.getByText('含估算').first()).toBeVisible()

  // 今天按小时
  await page.getByRole('radio', { name: '今天' }).check({ force: true })
  await expect(page.getByRole('heading', { name: /Token 趋势（按小时/ })).toBeVisible()
  await page.getByRole('radio', { name: '近 30 天' }).check({ force: true })

  // 按来源：定时任务与系统运行都计入
  const tabs = page.getByRole('tablist', { name: '统计维度' })
  await tabs.getByRole('tab', { name: '按来源' }).click()
  const table = page.getByRole('region', { name: '统计' })
  await expect(table.getByRole('button', { name: '定时任务' })).toBeVisible()
  await expect(table.getByRole('button', { name: '系统' })).toBeVisible()

  // 按员工下钻到执行明细
  await tabs.getByRole('tab', { name: '按员工' }).click()
  await table.getByRole('button', { name: '林岚' }).click()
  await expect(tabs.getByRole('tab', { name: /执行明细/ })).toHaveAttribute('aria-selected', 'true')
  const drill = page.getByTestId('usage-drill')
  await expect(drill).toHaveText('员工：林岚')
  await expect(table.getByRole('cell', { name: /赵宁/ })).toHaveCount(0)
  await expect(table.getByRole('cell', { name: /林岚/ }).first()).toBeVisible()

  // 详情
  await table.getByRole('button', { name: /的用量详情$/ }).first().click()
  const drawer = page.getByRole('dialog', { name: '执行用量详情' })
  await expect(drawer.getByText('其中缓存读取')).toBeVisible()
  await expect(drawer.getByText('缓存写入')).toBeVisible()
  await expect(drawer.getByText(/网关计量|估算/).first()).toBeVisible()
  await drawer.getByRole('button', { name: /Close|关闭/ }).click()

  // 清除下钻条件
  await drill.getByRole('button').click()
  await expect(drill).toHaveCount(0)
  await expect(table.getByRole('cell', { name: /赵宁/ }).first()).toBeVisible()
})
