import { expect, test } from '@playwright/test'

// KB-ADM-P0（e2e/catalog/knowledge.md）：P0 冒烟服务的内存数据，测试身份为平台管理员。加密凭据、权限与
// WeKnora 转发由 server/src/http/knowledge-admin-api.integration.test.ts 覆盖。

const adminUrl = `http://localhost:${process.env.DSH_WORK_ADMIN_PORT ?? 4180}`

test.beforeEach(async ({ page }) => {
  await page.request.post('/api/testing/p0/reset')
})

test('KB-ADM-P0: 企业知识库在独立分组中，列出全部知识库并标出需要处理的', async ({ page }) => {
  await page.goto(`${adminUrl}/overview`)
  await page.getByRole('navigation', { name: '管理后台主导航' }).getByRole('button', { name: '企业知识库' }).click()
  await expect(page).toHaveURL(`${adminUrl}/knowledge`)
  await expect(page.getByText('知识库', { exact: true }).first()).toBeVisible()
  const summary = page.getByRole('region', { name: '企业知识库概况' })
  await expect(summary).toContainText('已启用')
  await expect(summary).toContainText('需要处理')

  const rows = page.locator('.el-table__body tr')
  await expect(rows).toHaveCount(5)
  await expect(page.getByRole('row', { name: /旧版质量手册/ })).toContainText('已删除')
  await expect(page.getByRole('row', { name: /旧版质量手册/ })).toContainText('无可见部门')
  await expect(page.getByRole('row', { name: /销售话术库/ })).toContainText('需重建')
  await page.getByRole('radio', { name: '需要处理' }).click({ force: true })
  await expect(rows).toHaveCount(2)
})

test('KB-ADM-P0: 可见部门授给全公司、撤销，修改归属部门，新建与删除', async ({ page }) => {
  await page.goto(`${adminUrl}/knowledge`)
  await page.getByRole('row', { name: /计划组工作手册/ }).getByRole('button', { name: '可见部门' }).click()
  const grants = page.getByRole('dialog', { name: /可见部门/ })
  await grants.getByLabel('添加部门').click()
  await page.getByRole('option', { name: '全公司（根部门）' }).click()
  await grants.getByRole('button', { name: '添加' }).click()
  await expect(grants.getByText('全公司', { exact: true })).toBeVisible()
  await grants.getByRole('button', { name: '撤销计划组（含下级）' }).click()
  await expect(grants.getByText('计划组（含下级）')).toHaveCount(0)
  await grants.getByRole('button', { name: '完成' }).click()
  await expect(page.getByRole('row', { name: /计划组工作手册/ })).toContainText('全公司')

  await page.getByRole('row', { name: /旧版质量手册/ }).getByRole('button', { name: '归属部门' }).click()
  const owner = page.getByRole('dialog', { name: '修改归属部门' })
  await owner.getByLabel('归属部门').click()
  await page.getByRole('option', { name: '综合管理部' }).click()
  await owner.getByRole('button', { name: '保存' }).click()
  await expect(page.getByRole('row', { name: /旧版质量手册/ })).not.toContainText('已删除')

  await page.getByRole('button', { name: '新建知识库' }).click()
  const create = page.getByRole('dialog', { name: '新建知识库' })
  await create.getByLabel('名称').fill('全员安全制度')
  await create.getByLabel('归属部门').click()
  await page.getByRole('option', { name: '综合管理部' }).click()
  await expect(create.getByText(/嵌入模型使用当前配置（bge-m3）/)).toBeVisible()
  await create.getByRole('button', { name: '创建' }).click()
  await expect(page.getByRole('row', { name: /全员安全制度/ })).toContainText('综合管理部（含下级）')

  await page.getByRole('row', { name: /全员安全制度/ }).getByRole('button', { name: '删除' }).click()
  const confirm = page.getByRole('dialog', { name: '删除“全员安全制度”' })
  await confirm.getByRole('textbox').fill('全员安全制度')
  await confirm.getByRole('button', { name: '删除' }).click()
  await expect(page.getByRole('row', { name: /全员安全制度/ })).toHaveCount(0)
})

test('KB-ADM-P0: 连接配置只显示 Key 末四位，修改嵌入模型与停用时给出提示', async ({ page }) => {
  await page.goto(`${adminUrl}/knowledge`)
  await page.getByRole('tab', { name: '连接配置' }).click()
  await expect(page.getByText('•••• 7f3a')).toBeVisible()
  await expect(page.getByLabel('新的 API Key')).toHaveCount(0)
  // 改了地址：已保存的 Key 不会发往新地址，自动要求重新填写。
  await page.getByLabel('WeKnora 地址').fill('https://weknora-new.internal.example.com')
  await expect(page.getByText('更换地址须重新填写 API Key：已保存的 Key 不会发往新地址。')).toBeVisible()
  await expect(page.getByLabel('新的 API Key')).toBeVisible()
  await page.getByLabel('WeKnora 地址').fill('https://weknora.internal.example.com')

  await page.getByLabel('统一嵌入模型 ID').fill('bge-m3-v2')
  await expect(page.getByText(/现有 5 个知识库仍按原模型检索/)).toBeVisible()
  // Element Plus 隐藏原生复选框，点击可见的标签文字。
  await page.getByText('启用企业知识库', { exact: true }).click()
  await expect(page.getByText(/停用后：员工端不显示/)).toBeVisible()

  await page.getByRole('button', { name: '测试连接' }).click()
  await expect(page.getByText('连接正常：地址与 API Key 可用。')).toBeVisible()
  const health = page.getByRole('complementary', { name: '健康状态' })
  await expect(health).toContainText('128 次')
})
