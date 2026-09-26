import { expect, test } from '@playwright/test'

test('AE-05 administrator approves and pauses an Agent-owned routine, preserving its execution record', async ({ page }) => {
  const agentId = 'agent-dsh-work-assistant'
  const fixtureResponse = await page.request.get('/api/admin/v1/test/agent-routine/fixture')
  expect(fixtureResponse.ok()).toBeTruthy()
  const fixture = (await fixtureResponse.json()).data as { workspaceId: string; recipientUserId: string }
  expect(fixture.workspaceId).toBeTruthy()
  const created = await page.request.post(`/api/admin/v1/agents/${agentId}/routines`, { data: {
    name: 'P1 主动巡检', agentVersionId: 'agent-version-dsh-work-assistant-1',
    workspaceId: fixture.workspaceId, recipientUserId: fixture.recipientUserId,
    schedule: { kind: 'manual', timezone: 'Asia/Shanghai' },
    inputTemplate: { prompt: '核对测试事项', budget: { maxToolCalls: 2 } },
  } })
  expect(created.ok(), await created.text()).toBeTruthy()

  await page.goto('/agents')
  await page.getByRole('row').filter({ hasText: 'dsh-work' }).first().click()
  const drawer = page.locator('.el-drawer').filter({ hasText: 'Agent 治理详情' })
  await drawer.getByRole('tab', { name: '主动任务' }).click()
  const row = drawer.getByRole('row').filter({ hasText: 'P1 主动巡检' })
  await expect(row).toContainText('草稿')
  await row.getByRole('button', { name: '确认并启用' }).click()
  const approval = page.getByRole('dialog', { name: '确认 Agent 主动任务授权上限' })
  await expect(approval).toBeVisible()
  await approval.getByRole('button', { name: '确认并启用' }).click()
  await expect(row).toContainText('已启用')
  await row.getByRole('button', { name: '立即运行' }).click()
  const executions = page.getByRole('dialog', { name: 'P1 主动巡检 · 执行记录' })
  await expect(executions).toContainText('accepted')
  await executions.getByRole('button', { name: '关闭' }).click()
  await row.getByRole('button', { name: '暂停' }).click()
  await page.getByRole('button', { name: '确认', exact: true }).click()
  await expect(row).toContainText('已暂停')
  await row.getByRole('button', { name: '执行记录' }).click()
  await expect(page.getByRole('dialog', { name: 'P1 主动巡检 · 执行记录' })).toContainText('accepted')
})
