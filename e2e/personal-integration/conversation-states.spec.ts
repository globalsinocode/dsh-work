import { expect, test, type Page } from '@playwright/test'

// EX-STATE-01（P1）：个人对话中停止、失败的轮次留有记录；执行中显示真实 AI 同事名称；
// 本轮失败说明完整可见。真实 PostgreSQL 与 HTTP 接口，合成 Runtime（不调用模型）：
// `P1-保持运行` 保持运行直到停止，`P1-执行失败` 确定性失败。夹具的个人对话由 dsh-work 助手回答。
const agentName = 'dsh-work 助手'

async function send(page: Page, prompt: string) {
  await page.getByLabel('对话输入').fill(prompt)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
}

test('P1: stopped and failed rounds keep a note after later rounds, and the failure is not hidden', async ({ page }) => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const first = `第一轮-${suffix}`
  const stopped = `P1-保持运行-${suffix}`
  const failed = `P1-执行失败-${suffix}`
  const last = `P1-执行失败-再试-${suffix}`

  await page.goto('/workbench')
  await send(page, first)
  await expect(page).toHaveURL(/\/conversations\/run-/)
  const firstReply = page.getByRole('article').filter({ hasText: /受控测试运行已完成/ })
  await expect(firstReply).toContainText(agentName)

  // 执行中的名称与完成后回复的名称一致。
  await send(page, stopped)
  const working = page.getByTestId('run-progress-card')
  await expect(working).toContainText(agentName)
  await page.getByRole('button', { name: '停止本轮执行' }).click()
  await page.getByRole('dialog', { name: '停止本轮执行？' }).getByRole('button', { name: '停止本轮执行' }).click()
  await expect(page.getByTestId('run-stopped-by')).toBeVisible()

  // 较早一轮被停止且没有回复：在其问题下留有说明，不随新一轮消失。
  await send(page, failed)
  await expect(page.getByTestId('run-error-notice')).toBeVisible()
  await expect(page.getByTestId('past-run-note')).toHaveText([/^已停止（.+），没有生成回复$/])

  await send(page, last)
  await expect(page.getByTestId('past-run-note')).toHaveText([
    /^已停止（.+），没有生成回复$/,
    '这一轮没有完成，没有生成回复',
  ])
  // 失败说明在状态变化之后才到达时也跟随到底部，不被输入框遮挡。
  await expect(page.getByTestId('run-error-notice').getByRole('button', { name: '重新执行本轮' })).toBeInViewport()

  await page.reload()
  await expect(page.getByTestId('past-run-note')).toHaveText([
    /^已停止（.+），没有生成回复$/,
    '这一轮没有完成，没有生成回复',
  ])
})
