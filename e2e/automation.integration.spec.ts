import { randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

type FixtureIds = { workspaceId: string; agentId: string; agentVersionId: string; synthetic: boolean }
type AutomationRow = { id: string; name: string; agentVersionId: string; agentVersion: string; status: string }
type ExecutionRow = {
  id: string
  runId: string | null
  runStatus: string | null
  resultOutcome: string | null
  admissionStatus: string
  reasonCode: string | null
  executionConfig?: { agentVersionId?: string }
}

async function data<T>(response: import('@playwright/test').APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBeTruthy()
  return (await response.json()).data as T
}

async function fixtures(request: APIRequestContext): Promise<FixtureIds> {
  const result = await data<FixtureIds>(await request.get('/api/workbench/v1/test/automation/fixtures'))
  expect(result.synthetic).toBe(true)
  return result
}

async function createAutomation(request: APIRequestContext, name: string, prompt: string): Promise<AutomationRow> {
  const seed = await fixtures(request)
  return data<AutomationRow>(await request.post('/api/workbench/v1/automations', {
    data: {
      name,
      agentId: seed.agentId,
      workspaceId: seed.workspaceId,
      schedule: { kind: 'manual', timezone: 'Asia/Shanghai' },
      inputTemplate: { prompt },
    },
  }))
}

function taskCard(page: Page, name: string) {
  return page.getByRole('region', { name: `自动任务：${name}`, exact: true })
}

async function enableFromPage(page: Page, name: string) {
  await page.goto('/automations')
  const card = taskCard(page, name)
  await card.getByRole('button', { name: '启用', exact: true }).click()
  await page.getByRole('button', { name: '启用', exact: true }).last().click()
  await expect(card).toContainText('已启用')
}

async function runNowFromPage(page: Page, name: string) {
  await taskCard(page, name).getByRole('button', { name: '立即运行', exact: true }).click()
  await expect(page.getByText('立即运行成功，已受理', { exact: true })).toBeVisible()
}

async function executions(request: APIRequestContext, automationId: string): Promise<ExecutionRow[]> {
  return data<ExecutionRow[]>(await request.get(`/api/workbench/v1/automations/${automationId}/executions`))
}

async function openExecutions(page: Page, name: string) {
  await page.goto('/automations')
  await taskCard(page, name).getByRole('button', { name: '执行记录', exact: true }).click()
  return page.getByRole('dialog', { name: `执行记录 · ${name}` })
}

test('AG-AUTO-20: duplicate trigger has one Run and interrupted preparation is visible', async ({ page }) => {
  const name = `P1-原子受理-${randomUUID().slice(0, 8)}`
  const task = await createAutomation(page.request, name, 'P1-普通完成')
  await enableFromPage(page, name)

  const idempotencyKey = `same-${randomUUID()}`
  const [first, replay] = await Promise.all([
    page.request.post(`/api/workbench/v1/automations/${task.id}/run-now`, { data: { idempotencyKey } }),
    page.request.post(`/api/workbench/v1/automations/${task.id}/run-now`, { data: { idempotencyKey } }),
  ])
  const firstExecution = await data<ExecutionRow>(first)
  const replayExecution = await data<ExecutionRow>(replay)
  expect(replayExecution.id).toBe(firstExecution.id)
  expect(replayExecution.runId).toBe(firstExecution.runId)
  await expect.poll(async () => (await executions(page.request, task.id)).length).toBe(1)

  await data(await page.request.post(`/api/workbench/v1/test/automations/${task.id}/interrupted`))
  const drawer = await openExecutions(page, name)
  await expect(drawer.getByText('已中断', { exact: true })).toBeVisible()
  await expect(drawer.getByText('受理后派发中断', { exact: true })).toBeVisible()
  await expect(drawer.getByText('成功', { exact: true })).toBeVisible()
})

test('AG-AUTO-21: missed slots are recorded and failed Runs only retry explicitly', async ({ page }) => {
  const name = `P1-失败不重试-${randomUUID().slice(0, 8)}`
  const task = await createAutomation(page.request, name, 'P1-执行失败')
  await enableFromPage(page, name)
  await runNowFromPage(page, name)

  await expect.poll(async () => (await executions(page.request, task.id))[0]?.runStatus).toBe('failed')
  await expect.poll(async () => (await executions(page.request, task.id)).length).toBe(1)
  await data(await page.request.post(`/api/workbench/v1/test/automations/${task.id}/missed`))

  let drawer = await openExecutions(page, name)
  await expect(drawer.getByText('目标未达成', { exact: true })).toBeVisible()
  await expect(drawer.getByText('停机补记', { exact: true })).toBeVisible()
  await expect(drawer.getByText('计划槽位已过期', { exact: true })).toBeVisible()

  await page.keyboard.press('Escape')
  await runNowFromPage(page, name)
  await expect.poll(async () => (await executions(page.request, task.id)).length).toBe(3)
  drawer = await openExecutions(page, name)
  await expect(drawer.getByText('失败', { exact: true })).toHaveCount(2)
})

test('AG-AUTO-22: current account state blocks admission and another employee cannot read the task', async ({ page, browser }) => {
  const name = `P1-当前授权-${randomUUID().slice(0, 8)}`
  const task = await createAutomation(page.request, name, 'P1-普通完成')
  await enableFromPage(page, name)

  await data(await page.request.post('/api/workbench/v1/test/automation/revoke-owner'))
  try {
    await taskCard(page, name).getByRole('button', { name: '立即运行', exact: true }).click()
    await expect(page.getByText('立即运行未受理：账号状态不可用', { exact: true })).toBeVisible()
    const drawer = await openExecutions(page, name)
    await expect(drawer.getByText('账号状态不可用', { exact: true })).toBeVisible()
    await expect(drawer.getByRole('button', { name: '查看会话', exact: true })).toHaveCount(0)

    const other = await browser.newContext({ extraHTTPHeaders: { 'x-test-user-id': 'U00008' } })
    const forbidden = await other.request.get(`/api/workbench/v1/automations/${task.id}/executions`)
    expect(forbidden.status()).toBe(404)
    await other.close()
  } finally {
    await data(await page.request.post('/api/workbench/v1/test/automation/restore-owner'))
  }
})

test('AG-AUTO-23: task stays pinned to v1 after v2 is published and pause stops new normal triggers', async ({ page }) => {
  const name = `P1-固定版本-${randomUUID().slice(0, 8)}`
  const task = await createAutomation(page.request, name, 'P1-普通完成')
  await enableFromPage(page, name)
  const published = await data<{ pinnedVersionId: string; activeVersionId: string }>(
    await page.request.post(`/api/workbench/v1/test/automations/${task.id}/publish-agent-v2`),
  )

  await page.reload()
  const card = taskCard(page, name)
  await expect(card).toContainText(`v${task.agentVersion}`)
  await runNowFromPage(page, name)
  await expect.poll(async () => (await executions(page.request, task.id))[0]?.runStatus).toBe('succeeded')

  const evidence = await data<{
    pinnedVersionId: string
    activeVersionId: string
    executions: ExecutionRow[]
  }>(await page.request.get(`/api/workbench/v1/test/automations/${task.id}/evidence`))
  expect(evidence.pinnedVersionId).toBe(published.pinnedVersionId)
  expect(evidence.activeVersionId).toBe(published.activeVersionId)
  expect(evidence.executions[0]?.executionConfig?.agentVersionId).toBe(published.pinnedVersionId)

  await card.getByRole('button', { name: '暂停', exact: true }).click()
  await expect(card).toContainText('已暂停')
  await expect(card.getByRole('button', { name: '立即运行', exact: true })).toHaveCount(0)
  await expect(card.getByRole('button', { name: '试运行', exact: true })).toBeVisible()
})

test('AG-AUTO-24: a full automation lane does not block an interactive Run', async ({ page }) => {
  const firstName = `P1-占用车道-${randomUUID().slice(0, 8)}`
  const secondName = `P1-排队任务-${randomUUID().slice(0, 8)}`
  const first = await createAutomation(page.request, firstName, 'P1-保持运行')
  const second = await createAutomation(page.request, secondName, 'P1-普通完成')
  await enableFromPage(page, firstName)
  await enableFromPage(page, secondName)
  await runNowFromPage(page, firstName)
  await expect.poll(async () => (await executions(page.request, first.id))[0]?.runStatus).toBe('running')
  await runNowFromPage(page, secondName)
  await expect.poll(async () => (await executions(page.request, second.id))[0]?.runStatus).toBe('queued')

  await page.goto('/workbench')
  await page.getByLabel('对话输入').fill(`P1-交互保留容量-${randomUUID().slice(0, 8)}`)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByText(/受控测试运行已完成/).first()).toBeVisible()

  const drawer = await openExecutions(page, firstName)
  await drawer.getByRole('button', { name: '取消', exact: true }).click()
  await expect.poll(async () => (await executions(page.request, first.id))[0]?.runStatus).toBe('cancelled')
  await expect.poll(async () => (await executions(page.request, second.id))[0]?.runStatus).toBe('succeeded')

  const secondDrawer = await openExecutions(page, secondName)
  await expect(secondDrawer.getByText('成功', { exact: true })).toBeVisible()
  await expect(secondDrawer.getByText('结果待核验', { exact: true })).toBeVisible()
})
