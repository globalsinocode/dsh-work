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
  await page.locator('[data-action="publish-agent"]').click()
  await page.getByRole('button', { name: '确认发布', exact: true }).last().click()
  await expect(page.getByText('发布完成')).toBeVisible()
  expect(publishRequests).toBe(1)
})

test('五类案例在页签中逐项运行与确认，不能一次派发全部案例', async ({ page }) => {
  const actions: string[] = []
  let legacyBulkRequests = 0
  const editedCandidate = { ...candidate, revision: 2, sealedRevision: undefined, checks: [] }
  const firstRun = { ...trialRuns[0]!.steps[0]!.caseRuns[0]!, verdict: undefined }
  const partialTrial = {
    ...trialRuns[0], id: 'trial-progressive-smoke', submissionRevision: 2, status: 'asserting',
    steps: [{ id: 'dsh', label: 'DSH 执行评估案例', status: 'passed', caseRuns: [firstRun] }],
  }
  const checkedCandidate = { ...editedCandidate, checks: candidate.checks, cases: [
    { ...candidate.cases[0]!, input: '检查本月数据' }, ...candidate.cases.slice(1),
  ] }
  await page.route(`**/api/admin/v1/agents/${agentId}/release/candidate`, route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: {
      candidate, trialRuns: [], evidence: {}, packageWarnings: [],
    } }),
  }))
  await page.route(`**/api/admin/v1/agents/${agentId}/release/cases`, async route => {
    actions.push('cases')
    const cases = route.request().postDataJSON().cases as typeof candidate.cases
    expect(cases[0]?.input).toBe('检查本月数据')
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: {
      candidate: { ...editedCandidate, cases }, trialRuns: [], evidence: {}, packageWarnings: [],
    } }) })
  })
  await page.route(`**/api/admin/v1/agents/${agentId}/release/case-trials`, async route => {
    actions.push('trial')
    expect(route.request().postDataJSON()).toEqual({ caseId: 'case-success' })
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: {
      candidate: checkedCandidate, trialRuns: [partialTrial], evidence: {}, packageWarnings: [],
    } }) })
  })
  await page.route(`**/api/admin/v1/agents/${agentId}/release/trials`, async route => {
    legacyBulkRequests += 1
    await route.abort()
  })
  await page.route(`**/api/admin/v1/agents/${agentId}/release/trials/trial-progressive-smoke/confirm`, async route => {
    actions.push('confirm')
    expect(route.request().postDataJSON()).toEqual({ verdicts: [{ caseId: 'case-success', verdict: 'passed' }] })
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: {
      candidate: checkedCandidate,
      trialRuns: [{ ...partialTrial, steps: [{ ...partialTrial.steps[0], caseRuns: [{ ...firstRun, verdict: 'passed' }] }] }],
      evidence: {}, packageWarnings: [],
    } }) })
  })
  await page.route(`**/api/admin/v1/agents/${agentId}/release/trials/trial-progressive-smoke/cases`, async route => {
    actions.push('next')
    expect(route.request().postDataJSON()).toEqual({
      caseId: 'case-invalid_input', input: ' 订单号缺失 ', rubric: ' 先询问订单号 ',
    })
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: {
      candidate: { ...checkedCandidate, cases: checkedCandidate.cases.map(item => item.kind === 'invalid_input'
        ? { ...item, input: '订单号缺失', manualReview: { required: true, rubric: '先询问订单号' } } : item) },
      trialRuns: [{ ...partialTrial, steps: [{ ...partialTrial.steps[0], caseRuns: [
        { ...firstRun, verdict: 'passed' }, { ...trialRuns[0]!.steps[0]!.caseRuns[1], verdict: undefined },
      ] }] }], evidence: {}, packageWarnings: [],
    } }) })
  })

  const adminUrl = `http://localhost:${process.env.DSH_WORK_ADMIN_PORT ?? 4180}`
  for (const operation of ['inspect', 'import']) {
    const response = await page.request.post(`${adminUrl}/api/admin/v1/agent-packages/${operation}`, {
      headers: { 'Content-Type': 'application/zip', 'X-File-Name': 'agent.zip' },
      data: Buffer.from('removed'),
    })
    expect(response.status()).toBe(404)
  }
  await page.goto(`${adminUrl}/agents/${agentId}/release/trial`)
  await expect(page.getByRole('heading', { name: '验证案例' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Agent 候选发布流程' })).toHaveCount(0)
  await expect(page.getByText('查看配置摘要')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '编辑配置' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '试运行进度' })).toHaveCount(0)
  await expect(page.getByText('检查与案例')).toHaveCount(0)
  await page.getByRole('textbox', { name: 'success测试输入' }).fill('检查本月数据')
  await expect(page.getByRole('textbox', { name: 'invalid_input测试输入' })).toHaveCount(0)
  await page.getByRole('button', { name: '运行本项' }).click()
  await expect.poll(() => actions).toEqual(['cases', 'trial'])
  expect(legacyBulkRequests).toBe(0)
  await expect(page.getByRole('region', { name: 'success的实际输出' })).toBeVisible()
  const currentCase = page.getByRole('tabpanel', { name: /正常任务/ })
  await expect(currentCase.getByText('Run/Attempt 已记录')).toBeHidden()
  await currentCase.getByText('查看运行与自动检查').click()
  await expect(currentCase.getByText('Run/Attempt 已记录')).toBeVisible()
  await expect(page.getByRole('button', { name: '取消本轮验证' })).toBeVisible()
  await page.getByRole('tabpanel', { name: /正常任务/ }).getByText('符合预期', { exact: true }).click()
  await page.getByRole('button', { name: '确认本项结论' }).click()
  await expect.poll(() => actions).toEqual(['cases', 'trial', 'confirm'])
  await expect(page.getByRole('textbox', { name: 'invalid_input测试输入' })).toBeVisible()
  await page.getByRole('textbox', { name: 'invalid_input测试输入' }).fill(' 订单号缺失 ')
  await page.getByRole('textbox', { name: 'invalid_input人工判定标准' }).fill(' 先询问订单号 ')
  await page.getByRole('button', { name: '运行本项' }).click()
  await expect.poll(() => actions).toEqual(['cases', 'trial', 'confirm', 'next'])
  await expect(page.getByRole('textbox', { name: 'invalid_input测试输入' })).toHaveValue('订单号缺失')
  await expect(page.getByRole('textbox', { name: 'invalid_input人工判定标准' })).toHaveValue('先询问订单号')
  expect(legacyBulkRequests).toBe(0)
})

test('最后一项经服务端修剪空白后仍可确认并进入发布页', async ({ page }) => {
  const lastCase = candidate.cases[4]!
  const firstFourRuns = trialRuns[0]!.steps[0]!.caseRuns.slice(0, 4)
  const pendingTrial = {
    ...trialRuns[0], status: 'asserting',
    steps: [{ ...trialRuns[0]!.steps[0], caseRuns: firstFourRuns }],
  }
  const lastRun = { ...trialRuns[0]!.steps[0]!.caseRuns[4], verdict: undefined }
  const executedTrial = {
    ...pendingTrial,
    steps: [{ ...pendingTrial.steps[0], caseRuns: [...firstFourRuns, lastRun] }],
  }
  const normalizedCandidate = { ...candidate, cases: candidate.cases.map(item => item.id === lastCase.id
    ? { ...item, input: '依赖服务不可用', manualReview: { required: true, rubric: '应说明无法完成' } }
    : item) }
  await page.route(`**/api/admin/v1/agents/${agentId}/release/candidate`, route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: {
      candidate, trialRuns: [pendingTrial], evidence: {}, packageWarnings: [],
    } }),
  }))
  await page.route(`**/api/admin/v1/agents/${agentId}/release/trials/${pendingTrial.id}/cases`, async route => {
    expect(route.request().postDataJSON()).toEqual({
      caseId: lastCase.id, input: ' 依赖服务不可用 ', rubric: ' 应说明无法完成 ',
    })
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: {
      candidate: normalizedCandidate, trialRuns: [executedTrial], evidence: {}, packageWarnings: [],
    } }) })
  })
  await page.route(`**/api/admin/v1/agents/${agentId}/release/trials/${pendingTrial.id}/confirm`, async route => {
    expect(route.request().postDataJSON()).toEqual({ verdicts: [{ caseId: lastCase.id, verdict: 'passed' }] })
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: {
      candidate: normalizedCandidate, trialRuns: [trialRuns[0]], evidence: {}, packageWarnings: [],
    } }) })
  })

  const adminUrl = `http://localhost:${process.env.DSH_WORK_ADMIN_PORT ?? 4180}`
  await page.goto(`${adminUrl}/agents/${agentId}/release/trial`)
  await page.getByRole('textbox', { name: 'capability_failure测试输入' }).fill(' 依赖服务不可用 ')
  await page.getByRole('textbox', { name: 'capability_failure人工判定标准' }).fill(' 应说明无法完成 ')
  await page.getByRole('button', { name: '运行本项' }).click()
  await expect(page.getByRole('textbox', { name: 'capability_failure测试输入' })).toHaveValue('依赖服务不可用')
  await page.getByRole('tabpanel', { name: /能力不可用/ }).getByText('符合预期', { exact: true }).click()
  await page.getByRole('button', { name: '确认本项结论' }).click()
  await expect(page.getByRole('button', { name: '验证通过，确认发布' })).toBeVisible()
  await page.getByRole('button', { name: '验证通过，确认发布' }).click()
  await expect(page.getByRole('heading', { name: '发布确认摘要' })).toBeVisible()
})

test('试运行失败时优先展示可处理原因，技术证据按需展开', async ({ page }) => {
  const failedRun = {
    ...trialRuns[0]!.steps[0]!.caseRuns[0]!,
    runId: null, attemptId: null, status: 'failed', outputExcerpt: '',
    error: 'Agent 身份尚未获得试运行所需的角色和数据授权', verdict: undefined,
  }
  const failedTrial = {
    id: 'trial-failed-smoke', submissionRevision: 1, status: 'failed',
    startedAt: '2026-09-23T00:00:00.000Z',
    steps: [{ id: 'dsh', label: 'DSH 执行评估案例', status: 'failed',
      detail: '案例派发失败：正常任务 failed', caseRuns: [failedRun] }],
  }
  await page.route(`**/api/admin/v1/agents/${agentId}/release/candidate`, route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: {
      candidate, trialRuns: [failedTrial], evidence: {}, packageWarnings: [],
    } }),
  }))

  const adminUrl = `http://localhost:${process.env.DSH_WORK_ADMIN_PORT ?? 4180}`
  await page.goto(`${adminUrl}/agents/${agentId}/release/trial`)
  const feedback = page.locator('.case-feedback')
  await expect(feedback).toContainText('Agent 身份尚未获得试运行所需的角色和数据授权')
  await expect(feedback).not.toContainText('案例派发失败：正常任务 failed')
  await expect(page.getByRole('button', { name: '重新运行第一项' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'success的实际输出' })).toHaveCount(0)
  await expect(page.getByRole('tabpanel', { name: /正常任务/ }).getByText('查看运行与自动检查')).toBeVisible()
})
