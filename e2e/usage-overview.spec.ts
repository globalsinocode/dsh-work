import { expect, test, type Page } from '@playwright/test'

// OBS-E2E-04（e2e/catalog/admin-platform.md）：运营概览的使用情况——周期与部门筛选、排行与分布、按人明细与未使用名单。
// P0 冒烟数据为确定性内存数据（server/src/testing/p0-smoke/usage-analytics-service.ts），不代表真实统计口径。
const adminUrl = `http://localhost:${process.env.DSH_WORK_ADMIN_PORT ?? 4180}`
const workbenchUrl = `http://localhost:${process.env.DSH_WORK_WORKBENCH_PORT ?? 4174}`

async function pickDepartment(page: Page, name: string) {
  await page.getByRole('combobox', { name: '筛选部门' }).press('Enter')
  await page.getByRole('option', { name }).click()
}

test('administrator reviews usage by period, department and person', async ({ page }) => {
  await page.goto(`${adminUrl}/overview`)
  const metrics = page.getByRole('region', { name: '核心指标' })
  await expect(metrics.getByText('活跃员工')).toBeVisible()
  await expect(metrics.getByText('共 105 个账号，覆盖 76%')).toBeVisible()
  await expect(metrics.getByText(/^成功率 /)).toBeVisible()
  await expect(page.getByRole('img', { name: '每日活跃员工与运行数，共 30 天' })).toBeVisible()

  await page.getByRole('radio', { name: '近 7 天' }).check({ force: true })
  await expect(page.getByRole('img', { name: '每日活跃员工与运行数，共 7 天' })).toBeVisible()
  await page.getByRole('radio', { name: '近 90 天' }).check({ force: true })
  await expect(page.getByRole('img', { name: '每日活跃员工与运行数，共 90 天' })).toBeVisible()
  await page.getByRole('radio', { name: '近 30 天' }).check({ force: true })

  await expect(page.getByRole('region', { name: 'AI 同事使用排行' }).getByText('合同审阅助手')).toBeVisible()
  await expect(page.getByRole('region', { name: '页面访问排行' }).getByText('项目空间')).toBeVisible()
  const entries = page.getByRole('region', { name: '入口分布与失败原因' })
  await expect(entries.getByText('定时任务')).toBeVisible()
  await expect(entries.getByText('钉钉内访问')).toBeVisible()
  await expect(entries.getByText('运行超时')).toBeVisible()

  await pickDepartment(page, '财务部')
  await expect(metrics.getByText('共 18 个账号，覆盖 50%')).toBeVisible()
  const people = page.getByRole('region', { name: '员工明细' })
  await expect(people.getByRole('button', { name: '查看 周航 的使用详情' })).toBeVisible()
  await expect(people.getByRole('button', { name: '查看 林岚 的使用详情' })).toHaveCount(0)
  await pickDepartment(page, '华东销售部')
  await expect(people.getByRole('button', { name: '查看 林岚 的使用详情' })).toBeVisible()

  await people.getByRole('textbox', { name: '按姓名搜索员工' }).fill('马')
  await expect(people.getByRole('button', { name: '查看 林岚 的使用详情' })).toHaveCount(0)
  await people.getByRole('button', { name: '查看 马骏 的使用详情' }).click()
  const drawer = page.getByRole('dialog', { name: '员工使用详情' })
  await expect(drawer.getByText('华东销售部 · 最近活跃')).toBeVisible()
  await expect(drawer.getByRole('region', { name: '功能分布' }).getByText('个人对话')).toBeVisible()
  await expect(drawer.getByRole('img', { name: '每日运行，共 30 天' })).toBeVisible()
  await drawer.getByRole('button', { name: /Close|关闭/ }).click()
  await expect(drawer).toBeHidden()

  await people.getByRole('textbox', { name: '按姓名搜索员工' }).fill('')
  await pickDepartment(page, '财务部')
  await people.getByRole('tab', { name: /期间内未使用/ }).click()
  await expect(people.getByRole('cell', { name: '吴婷' })).toBeVisible()
  await expect(people.getByRole('cell', { name: '从未使用' })).toBeVisible()

  await page.getByRole('link', { name: '在错误记录中查看运行问题 →' }).click()
  await expect(page).toHaveURL(`${adminUrl}/error-records`)
})

test('workbench records page views by route name only', async ({ page }) => {
  const bodies: string[] = []
  await page.route('**/auth/workbench/page-views', async route => {
    bodies.push(route.request().postDataBuffer()?.toString('utf8') ?? '')
    await route.continue()
  })
  await page.goto(`${workbenchUrl}/workbench`)
  await expect(page.getByRole('navigation').first()).toBeVisible()
  await expect.poll(() => bodies.length, { timeout: 15_000 }).toBeGreaterThan(0)
  const body = JSON.parse(bodies[0]!) as { app: string; views: Array<{ page: string; inDingtalk: boolean }> }
  expect(body.app).toBe('workbench')
  expect(body.views).toContainEqual({ page: 'workbench', inDingtalk: false })
  expect(bodies[0]).not.toContain('http')
})
