import { expect, test, type Page } from '@playwright/test'

// DLP-01（e2e/catalog/workbench.md）：真实 PostgreSQL 和合成 Runtime，默认路由为外部厂商。
// 样本拆开写，避开敏感凭据扫描。
const secretPrompt = () => `帮我看看这个 key：s${'k-'}e2eQ7w2e9r4t6y8u1i3o5p0a${crypto.randomUUID().slice(0, 4)}`
const blockedText = '这条消息包含 密钥，按公司数据防护策略未发送给模型。请删除后重新发送。'

async function send(page: Page, prompt: string) {
  await page.getByLabel('对话输入').fill(prompt)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
}

test('P1: a message with a secret in an existing conversation is kept and marked, and the draft stays editable', async ({ page }) => {
  await page.goto('/workbench')
  await send(page, `数据防护第一条 ${crypto.randomUUID().slice(0, 8)}`)
  await expect(page).toHaveURL(/\/conversations\/run-/)
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible({ timeout: 30_000 })
  const runUrl = page.url()

  const prompt = secretPrompt()
  await send(page, prompt)
  const note = page.getByTestId('message-not-sent')
  await expect(note).toContainText(blockedText)
  await expect(page).toHaveURL(runUrl)
  // 输入框不清空，员工删掉密钥后可直接重发。
  await expect(page.getByLabel('对话输入')).toHaveValue(prompt)

  await page.reload()
  await expect(page.getByTestId('message-not-sent')).toContainText('未发送给模型')
})

test('P1: a secret in the first message leaves no conversation behind', async ({ page }) => {
  const prompt = secretPrompt()
  const sessionsBody = async () => (await page.request.get('/api/workbench/v1/sessions?limit=50')).text()
  await page.goto('/workbench')
  await send(page, prompt)
  await expect(page.getByText(blockedText).first()).toBeVisible()
  await expect(page).toHaveURL(/\/workbench/)
  await expect(page.getByLabel('对话输入')).toHaveValue(prompt)

  // 后端拦截时把标题改成“未发送的对话”，随后由前端删除；删除失败时列表里会留下这个标题。
  await expect.poll(sessionsBody).not.toContain('未发送的对话')
  expect(await sessionsBody()).not.toContain(prompt.slice(0, 12))
})
