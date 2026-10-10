import { expect, test } from '@playwright/test'

const adminUrl = `http://localhost:${process.env.DSH_WORK_ADMIN_PORT ?? 4180}`

test('administrator can create a Soul-only Agent draft with default platform capabilities', async ({ page }) => {
  await page.goto(`${adminUrl}/agents`)
  await page.getByRole('button', { name: '创建 Agent' }).click()

  const dialog = page.getByRole('dialog', { name: '创建 Agent' })
  await dialog.getByRole('textbox', { name: 'Agent 名称' }).fill('Soul 文本助手')
  await dialog.getByRole('textbox', { name: 'Agent 说明' }).fill('根据用户直接提供的文本整理摘要和待确认信息。')
  await expect(dialog.getByRole('textbox', { name: /SOUL\.md/ })).toBeVisible()
  await dialog.getByRole('textbox', { name: /SOUL\.md/ }).fill(
    '你是独立的文本整理 AI 员工。只处理用户当前提供的文字，明确列出摘要、依据和待确认事项；不猜测缺失信息。',
  )
  await dialog.getByRole('button', { name: '下一步' }).click()
  await expect(dialog.getByRole('combobox', { name: '引用 Skill（选填）' })).toBeVisible()
  await expect(dialog.getByRole('radiogroup', { name: 'MCP 使用范围' })).toBeVisible()
  await expect(dialog.getByText('工具允许列表（选填）')).toHaveCount(0)
  // 新建 Agent 的执行授权必须显式给出（默认拒绝，不从可见角色继承）。
  await dialog.getByRole('button', { name: '权限与运行限制' }).click()
  await dialog.getByRole('button', { name: '与可见范围相同' }).click()
  await dialog.getByRole('button', { name: '下一步' }).click()

  await expect(dialog.getByText('0 个 Skill')).toBeVisible()
  await expect(dialog.getByText('MCP：全部可用')).toBeVisible()
  await dialog.getByRole('button', { name: '完成创建' }).click()

  await expect(page.getByRole('dialog', { name: 'Agent 草稿已保存' })).toContainText('0 个 Skill · MCP：全部可用')
})
