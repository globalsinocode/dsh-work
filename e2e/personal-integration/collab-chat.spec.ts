import { expect, test, type Page } from '@playwright/test'

// MODE-E2E-07（P1）：协作模式单聊的续写与自动开启会话。真实 PostgreSQL 与 HTTP 接口，
// 合成 Runtime（不调用模型）；发送经既有 createSession / startRun 与 Run/Attempt 链路。
// 偏好按账号持久化，用例结束时切回工作模式，不影响同一夹具上的其他旅程。

test.afterEach(async ({ page }) => {
  await page.request.put('/api/workbench/v1/me/preferences', { data: { uiMode: 'work' } })
})

async function openAgentChat(page: Page) {
  await page.request.put('/api/workbench/v1/me/preferences', { data: { uiMode: 'collab' } })
  const agents = (await (await page.request.get('/api/workbench/v1/agents')).json()).data as Array<{ id: string; name: string }>
  const agent = agents[0]!
  await page.goto(`/c/chats/agent/${agent.id}`)
  await expect(page.getByRole('heading', { name: agent.name, level: 1 })).toBeVisible()
  return agent
}

async function send(page: Page, prompt: string) {
  await page.getByLabel('对话输入').fill(prompt)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
}

function segments(page: Page) {
  return page.getByRole('region', { name: /^与 .* 的对话$/ }).locator('.collab-segment')
}

test('P1: a message continues the latest session, and a stale Agent version opens a new one', async ({ page }) => {
  const agent = await openAgentChat(page)
  const marker = crypto.randomUUID().slice(0, 8)

  // 第一条消息：没有可续写的会话时平台开启新会话，有则续写；之后的消息必须续写同一段。
  await send(page, `P1-单聊首条-${marker}`)
  await expect(segments(page).last().locator('.user-message', { hasText: `P1-单聊首条-${marker}` })).toBeVisible()
  await expect(segments(page).last().getByText(/受控测试运行已完成/).last()).toBeVisible()
  const continued = await segments(page).count()
  const continuedTitle = await segments(page).last().locator('.collab-segment__divider').innerText()

  await send(page, `P1-单聊续写-${marker}`)
  const lastSegment = segments(page).last()
  await expect(lastSegment.locator('.user-message', { hasText: `P1-单聊续写-${marker}` })).toBeVisible()
  await expect(lastSegment.locator('.user-message', { hasText: `P1-单聊首条-${marker}` })).toBeVisible()
  await expect(lastSegment.locator('.assistant-answer', { hasText: /受控测试运行已完成/ })).toHaveCount(await lastSegment.locator('.user-message').count())
  expect(await segments(page).count()).toBe(continued)
  await expect(lastSegment.locator('.collab-segment__divider')).toHaveText(continuedTitle)

  // 最近一段改为固定在旧版本：提示将开始新的对话，发送后出现以该消息为话题的新分段。
  const stale = await page.request.post(`/api/workbench/v1/test/collab/agents/${agent.id}/stale-latest-session`)
  expect(stale.ok()).toBeTruthy()
  await page.reload()
  await expect(page.getByTestId('new-session-notice')).toBeVisible()
  await send(page, `P1-单聊新会话-${marker}`)
  await expect(segments(page).last().locator('.collab-segment__divider')).toContainText(`P1-单聊新会话-${marker}`)
  await expect(segments(page).last().getByText(/受控测试运行已完成/).last()).toBeVisible()
  expect(await segments(page).count()).toBe(continued + 1)
  await expect(page.getByTestId('new-session-notice')).toHaveCount(0)

  // 列表：该 AI 同事只有一行，预览为最新的回复。
  const row = page.getByRole('list', { name: '对话' }).getByRole('button', { name: new RegExp(`^${agent.name}`) })
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('受控测试运行已完成')

  // 工作模式中同一会话仍是独立的对话详情：链接按模式映射，不改数据。
  await page.getByRole('button', { name: '切换模式' }).click()
  await page.getByRole('menuitem', { name: /工作模式/ }).click()
  await expect(page).toHaveURL(/\/workbench\?agent=/)
})
