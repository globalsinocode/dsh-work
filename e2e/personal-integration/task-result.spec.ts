import { expect, test } from '@playwright/test'

// I-06 任务结果外层：执行终态与业务结果分列；真实 PostgreSQL + 显式合成 Runtime/身份。
// `P1-成果缺口` 由 PersonalBrowserRuntime 夹具识别：自述已生成成果但终态声明数多于平台登记数。
// `P1-成果达成` 由启动脚本钩子识别：run.completed 前登记真实成果（含 source_attempt_id）。
async function sendTask(page: import('@playwright/test').Page, prompt: string) {
  await page.goto('/workbench')
  await page.getByLabel('对话输入').fill(prompt)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page).toHaveURL(/\/conversations\/run-/)
  return new URL(page.url()).pathname.split('/').pop()!
}

async function runResult(page: import('@playwright/test').Page, runId: string) {
  const response = await page.request.get(`/api/workbench/v1/runs/${runId}/result`)
  expect(response.ok()).toBeTruthy()
  const result = (await response.json()).data
  expect(result.version).toBe('task-result/v1')
  expect(result.runId).toBe(runId)
  return result
}

test('P1: verified result separates business outcome from execution state', async ({ page }) => {
  const runId = await sendTask(page, `P1-成果达成-${crypto.randomUUID().slice(0, 8)}`)
  await expect(page.getByText(/受控测试运行已完成/).first()).toBeVisible()
  // 业务核验状态独立于执行状态呈现：当前 Attempt 已登记成果 → 目标已达成
  await expect(page.getByText('目标已达成', { exact: true }).first()).toBeVisible()

  const result = await runResult(page, runId)
  expect(result.execution).toBe('succeeded')
  expect(result.outcome).toBe('achieved')
  expect(result.receipts).toContainEqual(expect.objectContaining({ kind: 'answer', status: 'completed' }))
  expect(result.receipts).toContainEqual(expect.objectContaining({ kind: 'artifact', status: 'completed' }))

  // 对话详情抽屉：结果核验区展示回执与证据
  await page.getByRole('button', { name: '对话详情', exact: true }).click()
  const drawer = page.getByRole('dialog')
  await expect(drawer.getByRole('heading', { name: '结果核验' })).toBeVisible()
  await expect(drawer.getByText('回答已提交并完成持久化登记')).toBeVisible()
})

test('P1: a committed answer alone stays unverified without verifiable deliverables', async ({ page }) => {
  // P1 回归：回答落库 ≠ 目标达成；核验状态保留在接口中，但消息流不显示待核验警示。
  const runId = await sendTask(page, `P1-仅回答-${crypto.randomUUID().slice(0, 8)}`)
  await expect(page.getByText(/受控测试运行已完成/).first()).toBeVisible()
  await expect(page.getByTestId('run-result-unverified')).toHaveCount(0)
  await expect(page.getByText('目标已达成', { exact: true })).toHaveCount(0)

  const result = await runResult(page, runId)
  expect(result.execution).toBe('succeeded')
  expect(result.outcome).toBe('unverified')
  expect(result.receipts).toContainEqual(expect.objectContaining({ kind: 'answer', status: 'completed' }))
  expect(result.pendingItems).toContainEqual(expect.objectContaining({ kind: 'no_verified_deliverable' }))
})

test('P1: artifact registration gap shows unverified instead of achieved', async ({ page }) => {
  const runId = await sendTask(page, 'P1-成果缺口 生成两份报告')
  await expect(page.getByText(/成果登记缺口夹具/).first()).toBeVisible()
  // 执行成功但证据缺口：消息流不显示待核验警示，也绝不误报「目标已达成」。
  await expect(page.getByTestId('run-result-unverified')).toHaveCount(0)
  await expect(page.getByText(/业务结果未验证/)).toHaveCount(0)
  await expect(page.getByText('目标已达成', { exact: true })).toHaveCount(0)

  const result = await runResult(page, runId)
  expect(result.execution).toBe('succeeded')
  expect(result.outcome).toBe('unverified')
  expect(result.receipts).toContainEqual(expect.objectContaining({ kind: 'artifact', status: 'missing' }))
  expect(result.pendingItems).toContainEqual(expect.objectContaining({ kind: 'artifact_registration_gap' }))

  await page.getByRole('button', { name: '对话详情', exact: true }).click()
  const drawer = page.getByRole('dialog')
  await expect(drawer.getByText('登记缺失')).toBeVisible()
  await expect(drawer.getByText('执行声明 2 个成果，实际仅登记 0 个')).toBeVisible()
})
