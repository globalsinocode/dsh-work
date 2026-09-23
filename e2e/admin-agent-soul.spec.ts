import { expect, test } from '@playwright/test'

const adminUrl = `http://localhost:${process.env.DSH_WORK_ADMIN_PORT ?? 4180}`

test('administrator can create a Soul-only Agent draft without Skill or tool', async ({ page }) => {
  await page.goto(`${adminUrl}/agents`)
  await page.getByRole('button', { name: '创建 Agent' }).click()

  const dialog = page.getByRole('dialog', { name: '创建 Agent' })
  await dialog.getByRole('textbox', { name: 'Agent 名称' }).fill('Soul 文本助手')
  await dialog.getByRole('textbox', { name: 'Agent 说明' }).fill('根据用户直接提供的文本整理摘要和待确认信息。')
  await dialog.getByRole('button', { name: '下一步' }).click()

  await expect(dialog.getByRole('textbox', { name: /SOUL\.md/ })).toBeVisible()
  await dialog.getByRole('textbox', { name: /SOUL\.md/ }).fill(
    '你是独立的文本整理 AI 员工。只处理用户当前提供的文字，明确列出摘要、依据和待确认事项；不猜测缺失信息。',
  )
  await expect(dialog.getByRole('combobox', { name: '引用 Skill（选填）' })).toBeVisible()
  await expect(dialog.getByRole('combobox', { name: '工具允许列表（选填）' })).toBeVisible()
  await dialog.getByRole('button', { name: '下一步' }).click()

  await expect(dialog.getByText('0 个 Skill')).toBeVisible()
  await expect(dialog.getByText('0 个工具')).toBeVisible()
  await dialog.getByRole('button', { name: '完成创建' }).click()

  await expect(page.getByRole('dialog', { name: 'Agent 草稿已保存' })).toContainText('0 个 Skill · 0 个工具')
})
