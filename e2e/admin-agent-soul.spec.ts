import { expect, test } from '@playwright/test'

// P2-28：每个 P0 用例从同一份内存夹具开始，避免可变状态跨用例泄漏。
test.beforeEach(async ({ page }) => {
  await page.request.post('/api/testing/p0/reset')
})

const adminUrl = `http://localhost:${process.env.DSH_WORK_ADMIN_PORT ?? 4180}`

test('administrator can create a Soul-only Agent draft with default platform capabilities', async ({ page }) => {
  const name = `Soul 文本助手 ${Date.now()}`
  await page.goto(`${adminUrl}/agents`)
  await page.getByRole('button', { name: '创建 Agent' }).click()

  const dialog = page.getByRole('dialog', { name: '创建 Agent' })
  await dialog.getByRole('textbox', { name: 'Agent 名称' }).fill(name)
  await dialog.getByRole('textbox', { name: 'Agent 说明' }).fill('根据用户直接提供的文本整理摘要和待确认信息。')
  await dialog.getByRole('textbox', { name: /SOUL\.md/ }).fill(
    '你是独立的文本整理 AI 员工。只处理用户当前提供的文字，明确列出摘要、依据和待确认事项；不猜测缺失信息。',
  )
  // 创建只要求基础定义；可见角色、数据范围、Skill 与 MCP 在草稿编辑流程中按步骤配置。
  await expect(dialog.getByRole('combobox')).toHaveCount(0)
  await expect(dialog.getByRole('radiogroup')).toHaveCount(0)
  await dialog.getByRole('button', { name: '创建并继续配置' }).click()

  await expect(page).toHaveURL(/\/agents\/agent-[0-9a-f]+\/draft\?step=profile$/)
  await expect(page.getByRole('heading', { name })).toBeVisible()
  const steps = page.getByRole('navigation', { name: '编辑步骤' })
  await expect(steps.getByRole('button')).toHaveText([/职责与人格/, /能力/, /角色与权限/, /验证与发布/])
  await expect(steps.getByRole('button', { name: /职责与人格/ })).toHaveAttribute('aria-current', 'step')
  await expect(steps.getByRole('button', { name: /角色与权限/ })).toHaveAccessibleName('3. 角色与权限，待设置')
  await expect(page.getByTestId('draft-save-status')).toHaveText('草稿与服务端一致')

  await page.getByRole('button', { name: '下一步：能力' }).click()
  await expect(page).toHaveURL(/step=capabilities$/)
  const capabilities = page.getByRole('region', { name: '能力' })
  await expect(capabilities.getByRole('combobox', { name: '引用 Skill（选填）' })).toBeVisible()
  await expect(capabilities.getByRole('radio', { name: '不使用 MCP（默认）' })).toBeChecked()
  await expect(capabilities.getByText('工具允许列表（选填）')).toHaveCount(0)
})
