import { expect, test } from '@playwright/test'

const adminUrl = `http://localhost:${process.env.DSH_WORK_ADMIN_PORT ?? 4180}`

test('Agent editor keeps AGENTS.md and MCP scope while hiding per-Agent DSH tools', async ({ page }) => {
  const name = `能力范围浏览器验证 ${Date.now()}`
  const procedures = '先核对任务目标与已授权资料，再选择必要的工具；完成后列出可验证的结果和未解决事项。'
  await page.goto(`${adminUrl}/agents`)
  await page.getByRole('button', { name: '创建 Agent' }).click()
  const create = page.getByRole('dialog', { name: '创建 Agent' })
  await create.getByRole('textbox', { name: 'Agent 名称' }).fill(name)
  await create.getByRole('textbox', { name: 'Agent 说明' }).fill('用于验证 Agent 定义、工作规程和外部 MCP 使用范围的页面流程。')
  await create.getByRole('textbox', { name: /SOUL\.md/ }).fill('你是独立的测试 AI 员工。只处理明确授权的输入，核对来源后回答，并说明无法确认的事项。')
  await create.getByRole('textbox', { name: /AGENTS\.md/ }).fill(procedures)
  await create.getByRole('button', { name: '下一步' }).click()

  await expect(create.getByRole('radio', { name: '全部可用 MCP（默认）' })).toBeChecked()
  await expect(create.getByText('工具允许列表（选填）')).toHaveCount(0)
  await create.getByRole('radio', { name: '仅使用选定 MCP' }).press('Space')
  await expect(create.getByText('仅选定模式必须选择至少一个 Connector。')).toBeVisible()
  await create.getByRole('button', { name: '下一步' }).click()
  await expect(create.getByRole('heading', { name: '选择 Skill 与 MCP' })).toBeVisible()

  const connectorChoice = create.getByRole('combobox', { name: '选择 MCP Connector' })
  await connectorChoice.press('Enter')
  await expect(page.getByRole('option', { name: /企业知识 MCP/ })).toBeVisible()
  await connectorChoice.press('ArrowDown')
  await connectorChoice.press('Enter')
  await expect(create.getByText('企业知识 MCP', { exact: true })).toBeVisible()
  await create.getByRole('button', { name: '查看工具' }).press('Enter')
  const tools = page.getByRole('dialog', { name: '工具清单 · 企业知识 MCP' })
  await expect(tools).toContainText('搜索当前身份可访问的企业知识')
  await tools.getByText('输入 Schema').press('Enter')
  await expect(tools.getByText('"type"')).toBeVisible()
  await tools.getByRole('button', { name: 'Close this dialog' }).press('Enter')

  await create.getByRole('button', { name: '下一步' }).click()
  await expect(create.getByText('MCP：1 个选定')).toBeVisible()
  await expect(create.getByText('已填写 AGENTS.md')).toBeVisible()
  await create.getByRole('button', { name: '完成创建' }).click()
  await expect(page.getByRole('dialog', { name: 'Agent 草稿已保存' })).toContainText('MCP：仅选定')
  await page.getByRole('dialog', { name: 'Agent 草稿已保存' }).getByRole('button', { name: '关闭' }).click()

  const row = page.getByRole('row', { name: new RegExp(name) })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: '编辑' }).click()
  const edit = page.getByRole('dialog', { name: `编辑 Agent：${name}` })
  await expect(edit.getByRole('textbox', { name: /AGENTS\.md/ })).toHaveValue(procedures)
  await edit.getByRole('button', { name: '下一步' }).click()
  await expect(edit.getByRole('radio', { name: '仅使用选定 MCP' })).toBeChecked()
  await expect(edit.getByText('企业知识 MCP', { exact: true })).toBeVisible()
  await edit.getByRole('radio', { name: '不使用 MCP' }).press('Space')
  await expect(edit.getByRole('combobox', { name: '选择 MCP Connector' })).toHaveCount(0)
  await edit.getByRole('radio', { name: '仅使用选定 MCP' }).press('Space')
  await expect(edit.getByText('仅选定模式必须选择至少一个 Connector。')).toBeVisible()
  await edit.getByRole('button', { name: '下一步' }).click()
  await expect(edit.getByRole('heading', { name: '选择 Skill 与 MCP' })).toBeVisible()
})
