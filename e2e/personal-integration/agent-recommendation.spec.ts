import { expect, test, type Page } from '@playwright/test'

// REC-01（P1）：推荐卡片“去聊天”进入该 AI 同事的新对话，问题预填不发送。真实 PostgreSQL 与 HTTP 接口，
// 合成 Runtime（不调用模型）；`P1-推荐同事` 由启动脚本钩子经推荐服务登记推荐（真实 DSH 中由模型调用
// recommend_agents）。夹具有一位员工可用的“合同审查（P1）”和一位只对管理员可见的“财务内控（P1）”。

const colleague = '合同审查（P1）'

function reply(page: Page, prompt: string) {
  return page.getByRole('article').filter({ has: page.getByText(prompt, { exact: true }) })
    .locator('xpath=following-sibling::article[1]')
}

function card(scope: ReturnType<typeof reply>) {
  return scope.getByRole('article', { name: `推荐的 AI 同事：${colleague}` })
}

test.afterEach(async ({ page }) => {
  await page.request.put('/api/workbench/v1/me/preferences', { data: { uiMode: 'work' } })
})

test('P1: A mode opens the recommended colleague with the question prefilled once, never in the URL', async ({ page }) => {
  const prompt = `这份采购合同的违约金合理吗？P1-推荐同事-${crypto.randomUUID().slice(0, 8)}`
  await page.goto('/workbench')
  await page.getByLabel('对话输入').fill(prompt)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page).toHaveURL(/\/conversations\/run-/)
  const answer = reply(page, prompt)
  await expect(card(answer)).toBeVisible()
  await expect(card(answer)).toContainText('推荐理由：掌握公司的合同审查规则')
  await expect(answer.getByText('财务内控（P1）')).toHaveCount(0)
  const conversationUrl = page.url()

  await card(answer).getByRole('button', { name: `去和${colleague}聊天` }).click()
  await expect(page).toHaveURL(/\/workbench\?agent=agent-p1-contract$/)
  expect(page.url()).not.toContain(encodeURIComponent('违约金'))
  await expect(page.getByLabel('对话输入')).toHaveValue(prompt)
  await expect(page.getByTestId('recommendation-prefill-notice')).toContainText('确认后再发送')

  // 只预填一次：刷新后回到该同事的示例问题，不再带入原问题。
  await page.reload()
  await expect(page.getByLabel('对话输入')).not.toHaveValue(prompt)
  await expect(page.getByTestId('recommendation-prefill-notice')).toHaveCount(0)

  // 原对话中的卡片仍在。
  await page.goto(conversationUrl)
  await expect(card(reply(page, prompt))).toBeVisible()
})

test('P1: collab mode single chat opens the colleague’s chat directly with the same prefill', async ({ page }) => {
  await page.request.put('/api/workbench/v1/me/preferences', { data: { uiMode: 'collab' } })
  const prompt = `协作模式下的合同问题 P1-推荐同事-${crypto.randomUUID().slice(0, 8)}`
  await page.goto('/c/chats/agent/agent-dsh-work-assistant')
  await expect(page.getByRole('heading', { name: 'dsh-work 助手', level: 1 })).toBeVisible()
  await page.getByLabel('对话输入').fill(prompt)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  const answer = reply(page, prompt)
  await expect(card(answer)).toBeVisible()

  await card(answer).getByRole('button', { name: `去和${colleague}聊天` }).click()
  await expect(page).toHaveURL(/\/c\/chats\/agent\/agent-p1-contract$/)
  await expect(page.getByRole('heading', { name: colleague, level: 1 })).toBeVisible()
  await expect(page.getByLabel('对话输入')).toHaveValue(prompt)
  await expect(page.getByTestId('recommendation-prefill-notice')).toBeVisible()
})

test('P1: a colleague disabled after the recommendation is explained on the card instead of opening', async ({ page }) => {
  const prompt = `停用前的推荐 P1-推荐同事-${crypto.randomUUID().slice(0, 8)}`
  await page.goto('/workbench')
  await page.getByLabel('对话输入').fill(prompt)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(card(reply(page, prompt))).toBeVisible()

  // 只作用于本可丢弃夹具：停用该同事（对应管理员在管理端停用）。
  await page.request.post('/api/workbench/v1/test/agents/agent-p1-contract/disable')
  await page.reload()
  const recommendation = card(reply(page, prompt))
  await recommendation.getByRole('button', { name: `去和${colleague}聊天` }).click()
  await expect(recommendation.getByRole('status')).toContainText('该 AI 同事暂不可用')
  await expect(page).toHaveURL(/\/conversations\/run-/)
})
