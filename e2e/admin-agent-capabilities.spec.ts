import { expect, test } from '@playwright/test'

const adminUrl = `http://localhost:${process.env.DSH_WORK_ADMIN_PORT ?? 4180}`

test('Agent detail autosaves AGENTS.md and MCP scope while hiding per-Agent DSH tools', async ({ page }) => {
  const name = `能力范围浏览器验证 ${Date.now()}`
  const procedures = '先核对任务目标与已授权资料，再选择必要的工具；完成后列出可验证的结果和未解决事项。'
  await page.goto(`${adminUrl}/agents`)
  await page.getByRole('button', { name: '创建 Agent' }).click()
  const create = page.getByRole('dialog', { name: '创建 Agent' })
  await create.getByRole('textbox', { name: 'Agent 名称' }).fill(name)
  await create.getByRole('textbox', { name: 'Agent 说明' }).fill('用于验证 Agent 定义、工作规程和外部 MCP 使用范围的页面流程。')
  await create.getByRole('textbox', { name: /SOUL\.md/ }).fill('你是独立的测试 AI 员工。只处理明确授权的输入，核对来源后回答，并说明无法确认的事项。')
  await create.getByRole('button', { name: '创建并继续配置' }).click()
  await expect(page.getByRole('heading', { name })).toBeVisible()
  const status = page.getByTestId('draft-save-status')

  // 不合法的内容不保存，修正后自动保存。
  const profile = page.getByRole('tabpanel', { name: '职责与人格' })
  const workProcedures = profile.getByRole('textbox', { name: /AGENTS\.md/ })
  await workProcedures.fill('太短')
  await expect(status).toHaveText('内容不完整，未保存')
  await expect(profile.getByText('AGENTS.md 填写后至少需要 20 个字符')).toBeVisible()
  await workProcedures.fill(procedures)
  await profile.getByRole('textbox', { name: '员工端示例问题 1' }).fill('请核对本周的待办事项')
  await expect(status).toHaveText('已保存')

  await page.getByRole('tab', { name: '能力' }).click()
  const capabilities = page.getByRole('tabpanel', { name: '能力' })
  await expect(capabilities.getByRole('radio', { name: '不使用 MCP（默认）' })).toBeChecked()
  await expect(capabilities.getByText('工具允许列表（选填）')).toHaveCount(0)
  await capabilities.getByRole('radio', { name: '仅使用选定 MCP' }).press('Space')
  await expect(capabilities.getByText('仅选定模式必须选择至少一个 Connector。')).toBeVisible()
  await expect(status).toHaveText('内容不完整，未保存')

  const connectorChoice = capabilities.getByRole('combobox', { name: '选择 MCP Connector' })
  await connectorChoice.press('Enter')
  await expect(page.getByRole('option', { name: /企业知识 MCP/ })).toBeVisible()
  await connectorChoice.press('ArrowDown')
  await connectorChoice.press('Enter')
  await expect(capabilities.getByText('企业知识 MCP', { exact: true })).toBeVisible()
  await capabilities.getByRole('button', { name: '查看工具' }).press('Enter')
  const tools = page.getByRole('dialog', { name: '工具清单 · 企业知识 MCP' })
  await expect(tools).toContainText('搜索当前身份可访问的企业知识')
  await tools.getByText('输入 Schema').press('Enter')
  await expect(tools.getByText('"type"')).toBeVisible()
  await tools.getByRole('button', { name: 'Close this dialog' }).press('Enter')
  await expect(status).toHaveText('已保存')

  // 运行限制默认折叠。
  await expect(capabilities.getByText('运行超时（秒）', { exact: true })).toBeHidden()
  await capabilities.getByText('运行限制').click()
  await expect(capabilities.getByText('运行超时（秒）', { exact: true })).toBeVisible()

  // 回到列表再打开，保存结果回显。
  await page.getByRole('button', { name: '返回列表' }).click()
  await page.getByRole('row', { name: new RegExp(name) }).getByRole('button', { name: '查看' }).click()
  await expect(page.getByRole('tabpanel', { name: '职责与人格' }).getByRole('textbox', { name: /AGENTS\.md/ })).toHaveValue(procedures)
  await expect(page.getByRole('textbox', { name: '员工端示例问题 1' })).toHaveValue('请核对本周的待办事项')
  await page.getByRole('tab', { name: '能力' }).click()
  const reopened = page.getByRole('tabpanel', { name: '能力' })
  await expect(reopened.getByRole('radio', { name: '仅使用选定 MCP' })).toBeChecked()
  await expect(reopened.getByText('企业知识 MCP', { exact: true })).toBeVisible()
  await reopened.getByRole('radio', { name: '不使用 MCP' }).press('Space')
  await expect(reopened.getByRole('combobox', { name: '选择 MCP Connector' })).toHaveCount(0)
  await reopened.getByRole('radio', { name: '仅使用选定 MCP' }).press('Space')
  await expect(reopened.getByText('仅选定模式必须选择至少一个 Connector。')).toBeVisible()
  await expect(status).toHaveText('内容不完整，未保存')
})
