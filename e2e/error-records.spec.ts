import { expect, test } from '@playwright/test'

// OBS-E2E-01、OBS-E2E-02（e2e/catalog/admin-platform.md）：错误记录页按问题归并、详情、运行问题与编号查询。
// P0 冒烟数据为确定性内存数据（server/src/testing/p0-smoke/error-records-service.ts），不代表真实统计口径。
const adminUrl = `http://localhost:${process.env.DSH_WORK_ADMIN_PORT ?? 4180}`
const workbenchUrl = `http://localhost:${process.env.DSH_WORK_WORKBENCH_PORT ?? 4174}`
const traceId = 'trace-http-7c1e9d20-0f3b-4a8e-9b61-5d2c88e4b42a'

test('administrator reviews grouped problems, details and run problems', async ({ page }) => {
  await page.goto(`${adminUrl}/overview`)
  await page.getByRole('navigation', { name: '管理后台主导航' }).getByRole('button', { name: '错误记录' }).click()
  await expect(page).toHaveURL(`${adminUrl}/error-records`)

  const table = page.getByRole('region', { name: '错误记录' })
  await expect(table.getByRole('button', { name: /查看问题详情：TypeError: Cannot read properties/ })).toBeVisible()
  await expect(table.getByText('员工端 · 渲染')).toBeVisible()
  await expect(table.getByText('未登录')).toBeVisible()
  // 默认不显示“提示”类。
  await expect(table.getByText('失败提示 打开项目（forbidden）')).toHaveCount(0)

  await table.getByRole('radio', { name: '服务端' }).check({ force: true })
  await expect(table.getByRole('button', { name: /查看问题详情：500 operation_failed/ })).toBeVisible()
  await expect(table.getByRole('button', { name: /查看问题详情：TypeError/ })).toHaveCount(0)
  await table.getByRole('radio', { name: '全部' }).check({ force: true })
  await table.getByText('显示“提示”类（员工看到的失败提示）').click()
  await expect(table.getByText('失败提示 打开项目（forbidden）')).toBeVisible()

  await table.getByRole('button', { name: /查看问题详情：500 operation_failed/ }).click()
  const drawer = page.getByRole('dialog', { name: '问题详情' })
  await expect(drawer.getByRole('region', { name: '最近样本' }).getByText(traceId, { exact: false })).toBeVisible()
  await expect(drawer.getByRole('link', { name: '前往 Session 列表查看该运行' })).toBeVisible()
  await drawer.getByRole('button', { name: /Close|关闭/ }).click()
  await expect(drawer).toBeHidden()

  await table.getByRole('button', { name: /查看问题详情：TypeError/ }).click()
  await expect(drawer.getByText('已按源码映射还原')).toBeVisible()
  await expect(drawer.getByText(/ArtifactList\.vue:48:22/)).toBeVisible()
  await drawer.getByRole('button', { name: /Close|关闭/ }).click()

  await table.getByRole('tab', { name: '运行问题' }).click()
  const cards = page.getByRole('region', { name: '运行问题概况' })
  await expect(cards.getByText('成功但没有回答')).toBeVisible()
  await expect(page.getByRole('region', { name: '按原因' }).getByText('RUN_TIMEOUT')).toBeVisible()
  await expect(page.getByRole('region', { name: '工具调用失败或被拒绝' }).getByText('web_fetch')).toBeVisible()
})

test('administrator looks up a trace id and a run id', async ({ page }) => {
  await page.goto(`${adminUrl}/error-records`)
  const lookup = page.getByRole('region', { name: '编号查询' })
  await lookup.getByLabel('编号查询').fill(traceId)
  await lookup.getByRole('button', { name: '查询' }).click()
  const result = lookup.getByRole('region', { name: '查询结果' })
  await expect(result.getByRole('region', { name: '服务端失败' }).getByText('500 operation_failed：会话事件读取失败')).toBeVisible()
  await expect(result.getByRole('region', { name: '浏览器上报' }).getByText('失败提示 打开项目（forbidden）')).toBeVisible()
  await expect(result.getByRole('region', { name: '关联运行' }).getByText('run-smoke-err-001')).toBeVisible()
  await expect(result.getByRole('region', { name: '关联运行' }).getByText(/RUN_TIMEOUT/)).toBeVisible()

  await lookup.getByLabel('编号查询').fill('run-smoke-err-001')
  await lookup.getByRole('button', { name: '查询' }).click()
  await expect(result.getByRole('region', { name: '浏览器上报' }).getByText('无')).toBeVisible()
  await expect(result.getByRole('region', { name: '关联运行' }).getByText('run-smoke-err-001')).toBeVisible()

  await lookup.getByLabel('编号查询').fill('trace-http-00000000-0000-0000-0000-000000000000')
  await lookup.getByRole('button', { name: '查询' }).click()
  await expect(result.getByText(/没有找到与.*相关的记录/)).toBeVisible()
})

test('workbench reports an uncaught script error to the platform', async ({ page }) => {
  const bodies: string[] = []
  await page.route('**/auth/workbench/client-errors', async route => {
    bodies.push(route.request().postDataBuffer()?.toString('utf8') ?? '')
    await route.continue()
  })
  await page.goto(`${workbenchUrl}/workbench`)
  await expect(page.getByRole('navigation').first()).toBeVisible()
  await page.evaluate(() => { setTimeout(() => { throw new Error('e2e-probe') }, 0) })
  await expect.poll(() => bodies.some(body => body.includes('e2e-probe')), { timeout: 15_000 }).toBe(true)
  const body = JSON.parse(bodies.find(item => item.includes('e2e-probe'))!) as { app: string; reports: Array<{ kind: string; message: string }> }
  expect(body.app).toBe('workbench')
  expect(body.reports).toContainEqual(expect.objectContaining({ kind: 'script', message: expect.stringContaining('e2e-probe') }))
})
