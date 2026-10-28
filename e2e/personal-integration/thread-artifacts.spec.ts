import { expect, test, type Page } from '@playwright/test'

// EX-ARTIFACT-02（P1）：多轮个人对话中各轮成果留在各自的回复下。真实 PostgreSQL 与 HTTP 接口，
// 合成 Runtime（不调用模型）；`P1-成果达成` 由启动脚本钩子登记文本成果，正文含该轮 prompt。

function reply(page: Page, prompt: string) {
  // 每条消息是一个 article；助手回复紧跟在对应的员工消息之后。
  return page.getByRole('article').filter({ has: page.getByText(prompt, { exact: true }) })
    .locator('xpath=following-sibling::article[1]')
}

async function send(page: Page, prompt: string) {
  await page.getByLabel('对话输入').fill(prompt)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(reply(page, prompt).getByText(/成果已登记/)).toBeVisible()
}

async function expectRoundsAfterReload(page: Page, first: string, second: string) {
  await page.reload()
  const earlier = reply(page, first)
  const latest = reply(page, second)
  await expect(earlier.getByRole('button', { name: '下载成果 P1-登记成果.txt' })).toBeVisible()
  await expect(latest.getByRole('button', { name: '下载成果 P1-登记成果.txt' })).toBeVisible()
  // 「继续修改」只在最新一轮的成果上。
  await expect(earlier.getByRole('button', { name: '继续修改' })).toHaveCount(0)
  await expect(latest.getByRole('button', { name: '继续修改' })).toBeVisible()
  return { earlier, latest }
}

test('P1: each round keeps its artifact under its own reply and previews it in the side panel', async ({ page }) => {
  const tag = crypto.randomUUID().slice(0, 8)
  const first = `P1-成果达成-第一轮-${tag}`
  const second = `P1-成果达成-第二轮-${tag}`
  await page.goto('/workbench')
  await page.getByLabel('对话输入').fill(first)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page).toHaveURL(/\/conversations\/run-/)
  await expect(reply(page, first).getByText(/成果已登记/)).toBeVisible()
  await send(page, second)

  const { earlier, latest } = await expectRoundsAfterReload(page, first, second)

  // 较早一轮的正文对应该轮输入，在右栏显示，可关闭。
  await earlier.getByRole('button', { name: '预览成果 P1-登记成果.txt' }).click()
  const panel = page.getByRole('complementary', { name: '成果预览：P1-登记成果.txt' })
  await expect(panel.getByText(`P1 registered artifact, not a real DSH output: ${first}`)).toBeVisible()
  await expect(earlier.getByRole('button', { name: '预览成果 P1-登记成果.txt' })).toHaveAttribute('aria-pressed', 'true')
  await panel.getByRole('button', { name: '关闭成果预览' }).click()
  await expect(panel).toHaveCount(0)

  // 读取失败时在右栏提示；重试后显示该轮正文。
  let failNext = true
  await page.route('**/artifacts/*/versions/*/download', route => {
    if (!failNext) return route.continue()
    failNext = false
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: '暂不可用' } }) })
  })
  await latest.getByRole('button', { name: '预览成果 P1-登记成果.txt' }).click()
  await expect(panel.getByText('成果内容加载失败')).toBeVisible()
  await panel.getByRole('button', { name: '重试' }).click()
  await expect(panel.getByText(`P1 registered artifact, not a real DSH output: ${second}`)).toBeVisible()
  await expect(panel.getByText('成果内容加载失败')).toHaveCount(0)

  // 同一对话中追问（地址换到新 Run）时右栏保留；换到别的对话时关闭。
  await send(page, `P1-成果达成-第三轮-${tag}`)
  await expect(panel.getByText(`P1 registered artifact, not a real DSH output: ${second}`)).toBeVisible()
  const conversationUrl = page.url()
  // 侧栏“最近对话”中另一条对话（行名以日期时间结尾）。
  await page.getByRole('button', { name: /\d{2}\/\d{2} \d{2}:\d{2}$/ }).filter({ hasNotText: tag }).first().click()
  await expect.poll(() => page.url()).not.toBe(conversationUrl)
  await expect(panel).toHaveCount(0)
})

test('P1: the collaboration-mode chat shows the same per-round artifacts', async ({ page }) => {
  await page.request.put('/api/workbench/v1/me/preferences', { data: { uiMode: 'collab' } })
  try {
    const agents = (await (await page.request.get('/api/workbench/v1/agents')).json()).data as Array<{ id: string; name: string }>
    await page.goto(`/c/chats/agent/${agents[0]!.id}`)
    await expect(page.getByRole('heading', { name: agents[0]!.name, level: 1 })).toBeVisible()
    const tag = crypto.randomUUID().slice(0, 8)
    const first = `P1-成果达成-单聊甲-${tag}`
    const second = `P1-成果达成-单聊乙-${tag}`
    await send(page, first)
    await send(page, second)
    const { earlier } = await expectRoundsAfterReload(page, first, second)
    await earlier.getByRole('button', { name: '预览成果 P1-登记成果.txt' }).click()
    await expect(page.getByRole('complementary', { name: '成果预览：P1-登记成果.txt' })
      .getByText(`P1 registered artifact, not a real DSH output: ${first}`)).toBeVisible()
  } finally {
    await page.request.put('/api/workbench/v1/me/preferences', { data: { uiMode: 'work' } })
  }
})
