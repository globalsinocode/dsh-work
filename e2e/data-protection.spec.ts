import { expect, test, type Page } from '@playwright/test'

// DLP-ADM-01（e2e/catalog/admin-platform.md）。P0 冒烟为确定性内存数据，不代表 PostgreSQL 或真实网关。
const adminUrl = `http://localhost:${process.env.DSH_WORK_ADMIN_PORT ?? 4180}`

async function open(page: Page) {
  await page.goto(`${adminUrl}/overview`)
  await page.getByRole('navigation', { name: '管理后台主导航' }).getByRole('button', { name: '数据防护' }).click()
  await expect(page).toHaveURL(`${adminUrl}/data-protection`)
  await expect(page.getByRole('region', { name: '命中概况' }).getByText('外部厂商请求')).toBeVisible()
}

const tab = (page: Page, name: string) => page.getByRole('tab', { name }).click()

test('administrator reviews hit records and detail without seeing original values', async ({ page }) => {
  await open(page)
  const records = page.getByRole('region', { name: '命中明细' })
  await expect(records.getByRole('cell', { name: '张三' })).toBeVisible()
  await expect(records.getByText('已拦截')).toBeVisible()

  await page.getByRole('textbox', { name: '员工' }).fill('李四')
  await page.getByRole('textbox', { name: '员工' }).press('Enter')
  await expect(records.getByRole('cell', { name: '张三' })).toHaveCount(0)
  await records.getByRole('button', { name: '详情' }).click()
  await expect(records.getByText('run-9f20')).toBeVisible()
  await expect(records.getByRole('button', { name: '收起' })).toBeVisible()

  await tab(page, '识别规则')
  const rules = page.getByRole('region', { name: '识别规则' })
  await expect(rules.getByRole('row', { name: /密钥.*拦截.*遮盖/ })).toBeVisible()
  await expect(rules.getByRole('row', { name: /保密词表.*遮盖.*遮盖/ })).toBeVisible()
})

test('administrator maintains the confidential term list and allowlist', async ({ page }) => {
  await open(page)
  await tab(page, '保密词表')
  const terms = page.getByRole('region', { name: '保密词表' })
  await expect(terms.getByRole('cell', { name: '星河项目', exact: true })).toBeVisible()

  const term = `E2E词条${Date.now()}`
  await terms.getByRole('textbox', { name: '词条' }).fill(term)
  await terms.getByRole('button', { name: '添加' }).click()
  await expect(terms.getByRole('cell', { name: term, exact: true })).toBeVisible()

  await terms.getByRole('textbox', { name: '词条' }).fill(term)
  await terms.getByRole('button', { name: '添加' }).click()
  await expect(page.getByText('词条已存在，没有重复添加')).toBeVisible()

  await terms.getByLabel('选择 CSV 文件').setInputFiles({ name: 't.csv', mimeType: 'text/csv', buffer: Buffer.from(`词条\n${term}\n${term}导入\n`) })
  await expect(page.getByText('CSV 导入完成：新增 1 条，跳过 1 条重复')).toBeVisible()

  await terms.getByRole('button', { name: `删除词条 ${term}`, exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '删除' }).click()
  await expect(terms.getByRole('cell', { name: term, exact: true })).toHaveCount(0)

  await tab(page, '白名单')
  const allow = page.getByRole('region', { name: '白名单' })
  const value = `e2e${Date.now()}@example.cn`
  await allow.getByRole('textbox', { name: '放行的值' }).fill(value)
  await allow.getByRole('button', { name: '添加' }).click()
  await expect(allow.getByRole('cell', { name: value, exact: true })).toBeVisible()
})

test('administrator previews how a text would be handled', async ({ page }) => {
  await open(page)
  await tab(page, '检测试用')
  const preview = page.getByRole('region', { name: '检测试用' })
  await preview.getByRole('textbox').fill('华星科技的测试环境密码为 Abc#2026x')
  await preview.getByRole('button', { name: '检测' }).click()
  await expect(preview.getByText(/员工作为消息发送时会被拦截/)).toBeVisible()
  await expect(preview.getByText('保密词表：1 处')).toBeVisible()
  const masked = preview.getByTestId('data-protection-masked')
  await expect(masked).not.toContainText('华星科技')
  await expect(masked).not.toContainText('Abc#2026x')
})
