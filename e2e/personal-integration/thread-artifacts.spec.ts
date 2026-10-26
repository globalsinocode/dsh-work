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

test('P1: each round keeps its artifact under its own reply and shows the body in place', async ({ page }) => {
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

  // 较早一轮的正文对应该轮输入，可收起。
  await earlier.getByRole('button', { name: '展开 P1-登记成果.txt 正文' }).click()
  await expect(earlier.getByText(`P1 registered artifact, not a real DSH output: ${first}`)).toBeVisible()
  const collapse = earlier.getByRole('button', { name: '收起 P1-登记成果.txt 正文' })
  await expect(collapse).toHaveAttribute('aria-expanded', 'true')
  await collapse.click()
  await expect(earlier.getByText(`P1 registered artifact, not a real DSH output: ${first}`)).toHaveCount(0)

  // 读取失败时原处提示；再次展开重新读取。
  let failNext = true
  await page.route('**/artifacts/*/versions/*/download', route => {
    if (!failNext) return route.continue()
    failNext = false
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: '暂不可用' } }) })
  })
  const expand = latest.getByRole('button', { name: '展开 P1-登记成果.txt 正文' })
  await expand.click()
  await expect(latest.getByText('预览加载失败')).toBeVisible()
  await latest.getByRole('button', { name: '收起 P1-登记成果.txt 正文' }).click()
  await expand.click()
  await expect(latest.getByText(`P1 registered artifact, not a real DSH output: ${second}`)).toBeVisible()
  await expect(latest.getByText('预览加载失败')).toHaveCount(0)
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
    await earlier.getByRole('button', { name: '展开 P1-登记成果.txt 正文' }).click()
    await expect(earlier.getByText(`P1 registered artifact, not a real DSH output: ${first}`)).toBeVisible()
  } finally {
    await page.request.put('/api/workbench/v1/me/preferences', { data: { uiMode: 'work' } })
  }
})
