import { expect, test } from '@playwright/test'

const agentId = 'operations-analyst'
const kinds = ['success', 'invalid_input', 'permission_denied', 'prompt_injection', 'capability_failure']
const candidate = {
  id: 'submission-review-smoke', agentId, agentVersionId: 'agent-version-operations-040',
  version: '0.4.0', revision: 1, sealedRevision: 1, status: 'draft', source: 'config',
  bindingRefs: [], packageRefs: { skills: [], tools: [] }, missingDeps: { skills: [], tools: [] },
  checks: [{ id: 'definition', label: '定义检查', status: 'passed', detail: '通过' }], plan: [],
  cases: kinds.map(kind => ({
    id: `case-${kind}`, evaluationApiVersion: 'dsh-work.ai/evaluation/v1',
    name: kind, kind, input: kind,
    automatedAssertions: ['run_attempt_recorded', 'execution_succeeded', 'output_non_empty'],
    manualReview: { required: true, rubric: '符合预期' },
  })),
}
const trialRuns = [{
  id: 'trial-review-smoke', submissionRevision: 1, status: 'passed',
  startedAt: '2026-09-23T00:00:00.000Z',
  steps: [{ id: 'dsh', label: 'DSH 执行评估案例', status: 'passed', caseRuns: kinds.map(kind => ({
    caseId: `case-${kind}`, name: kind, kind, evaluationApiVersion: 'dsh-work.ai/evaluation/v1',
    automatedAssertions: [
      { assertion: 'run_attempt_recorded', passed: true, detail: 'Run/Attempt 已记录' },
      { assertion: 'execution_succeeded', passed: true, detail: '执行成功' },
      { assertion: 'output_non_empty', passed: true, detail: '输出非空' },
    ],
    manualReview: { required: true, rubric: '符合预期' },
    runId: `run-${kind}`, attemptId: `attempt-${kind}`, status: 'succeeded',
    outputExcerpt: '符合预期的结果', verdict: 'passed',
  })) }],
}]

test('已通过试运行的 Agent 一次确认即完成审核发布', async ({ page }) => {
  let publishRequests = 0
  await page.route('**/api/admin/v1/agent-release-submissions', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: { items: [] } }),
  }))
  await page.route(`**/api/admin/v1/agents/${agentId}/release/candidate`, route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: {
      candidate, trialRuns, evidence: {}, packageWarnings: [],
    } }),
  }))
  await page.route(`**/api/admin/v1/agents/${agentId}/release/publish`, async route => {
    publishRequests += 1
    expect(route.request().postDataJSON()).toEqual({ note: '已复核案例与权限' })
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: {
      trialRuns, evidence: {}, packageWarnings: [],
    } }) })
  })

  const adminUrl = `http://localhost:${process.env.DSH_WORK_ADMIN_PORT ?? 4180}`
  await page.goto(`${adminUrl}/agents/${agentId}/release/review`)
  await expect(page.getByText('发布确认摘要')).toBeVisible()
  await expect(page.locator('[data-action="submit-agent-release"]')).toHaveCount(0)
  await page.getByPlaceholder('审核意见（业务效果确认、注意事项）').fill('已复核案例与权限')
  await page.getByRole('button', { name: '审核通过并发布' }).click()
  await page.getByRole('button', { name: '审核通过并发布' }).last().click()
  await expect(page.getByText('发布完成')).toBeVisible()
  expect(publishRequests).toBe(1)
})
