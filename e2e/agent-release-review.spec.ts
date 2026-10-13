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
    manualReview: { rubric: '符合预期', required: true },
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

test.beforeEach(async ({ page }) => {
  await page.route('**/api/admin/v1/agents/principal-role-options', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: [
      { id: 'role-employee', name: '员工', status: 'active' },
    ] }),
  }))
  await page.route(`**/api/admin/v1/agents/${agentId}/principal`, route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: {
      principalId: `principal-agent-${agentId}`, agentId, status: 'active',
      authorizationVersion: 1, roleIds: ['role-employee'],
      dataScopes: ['供应链中心', '本部门汇总数据', '当前工作空间'],
    } }),
  }))
})

test('已通过试运行的 Agent 不受 JSON 字段顺序影响，可进入确认发布', async ({ page }) => {
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
  await page.goto(`${adminUrl}/agents/${agentId}/release/trial`)
  await page.getByRole('button', { name: '验证通过，确认发布' }).click()
  await expect(page.getByText('发布确认摘要')).toBeVisible()
  await expect(page.locator('[data-action="submit-agent-release"]')).toHaveCount(0)
  const conclusions = page.getByRole('region', { name: '验证结论' })
  await expect(conclusions).toContainText('5/5 项人工确认通过')
  await expect(conclusions).toContainText('提示注入')
  await expect(page.getByRole('region', { name: '本次变化' })).toBeVisible()
  // 内部修订与运行编号收在技术详情中，默认不展示。
  await expect(page.getByText('trial-review-smoke')).toBeHidden()
  await page.getByText('技术详情').click()
  await expect(page.getByText('trial-review-smoke')).toBeVisible()
  await page.getByLabel('业务确认意见').fill('已复核案例与权限')
  await page.locator('[data-action="publish-agent"]').click()
  await page.getByRole('button', { name: '确认发布', exact: true }).last().click()
  await expect(page.getByText('发布完成')).toBeVisible()
  expect(publishRequests).toBe(1)
})

test('按稳定角色 ID 允许试运行和发布，名称变化不影响授权，撤权仍阻止运行', async ({ page }) => {
  let roleIds = ['role-employee']
  let passed = false
  await page.route('**/api/admin/v1/agents', async route => {
    const response = await route.fetch()
    const body = await response.json()
    body.data = body.data.map((agent: { id: string }) => agent.id === agentId
      ? { ...agent, tools: ['custom@1.0.0'], dataScopes: [] } : agent)
    await route.fulfill({ response, json: body })
  })
  await page.route('**/api/admin/v1/tools', route => route.fulfill({ json: { data: [{
    id: 'custom', version: '1.0.0', name: '自定义授权工具', status: 'available',
    allowedRoles: ['普通员工（已改名）'], allowedRoleIds: ['role-employee'],
    agentRunLocalDefault: false, dataScopes: [],
  }] } }))
  await page.route(`**/api/admin/v1/agents/${agentId}/principal`, route => route.fulfill({ json: { data: {
    principalId: `principal-agent-${agentId}`, agentId, status: 'active',
    authorizationVersion: 1, roleIds, dataScopes: [],
  } } }))
  await page.route(`**/api/admin/v1/agents/${agentId}/release/candidate`, route => route.fulfill({ json: { data: {
    candidate, trialRuns: passed ? trialRuns : [], evidence: {}, packageWarnings: [],
  } } }))
  const url = `http://localhost:${process.env.DSH_WORK_ADMIN_PORT ?? 4180}/agents/${agentId}/release/trial`
  await page.goto(url)
  await expect(page.getByRole('button', { name: '运行本项', exact: true })).toBeEnabled()
  await expect(page.getByText(/试运行前还需授权/)).toHaveCount(0)
  passed = true
  await page.reload()
  await page.getByRole('button', { name: '验证通过，确认发布' }).click()
  await expect(page.locator('[data-action="publish-agent"]')).toBeEnabled()
  roleIds = []
  await page.goto(url)
  await expect(page.getByText('试运行前还需授权：工具 自定义授权工具 的执行角色')).toBeVisible()
  await expect(page.getByRole('button', { name: '验证通过，确认发布' })).toHaveCount(0)
  passed = false
  await page.reload()
  await expect(page.getByRole('button', { name: '运行本项', exact: true })).toBeDisabled()
})

test('运行本项时显示本项的持久检查与 DSH 进度，完成后保留过程', async ({ page }) => {
  let phase: 'before' | 'running' | 'complete' = 'before'
  let finishTrial!: () => void
  const pendingTrial = new Promise<void>(resolve => { finishTrial = resolve })
  const firstCase = candidate.cases[0]!
  const runningTrial = {
    id: 'trial-live-progress', submissionRevision: 1, status: 'executing',
    startedAt: '2026-09-23T01:10:00.000Z',
    steps: [
      { id: 'seal', label: '封存定义、依赖与绑定', status: 'passed' },
      { id: 'static', label: '静态检查与测试准入复核', status: 'passed' },
      { id: 'queue', label: '排队与运行准备', status: 'passed' },
      { id: 'dsh', label: 'DSH 执行评估案例', status: 'running', currentCaseId: firstCase.id },
    ],
    progress: { caseId: firstCase.id, runId: 'run-live', attemptId: 'attempt-live', runStatus: 'running',
      events: [
        { type: 'run.queued', label: '已进入 Runtime 队列', occurredAt: '2026-09-23T01:10:00.000Z' },
        { type: 'run.started', label: 'DSH Worker 已启动', occurredAt: '2026-09-23T01:10:01.000Z' },
      ] },
  }
  const completedTrial = {
    ...runningTrial, status: 'asserting',
    steps: [
      ...runningTrial.steps.slice(0, 3),
      { id: 'dsh', label: 'DSH 执行评估案例', status: 'passed', currentCaseId: firstCase.id,
        caseRuns: [{ ...trialRuns[0]!.steps[0]!.caseRuns[0]!, verdict: undefined }] },
    ],
  }
  const releaseState = () => ({
    candidate, trialRuns: phase === 'before' ? [] : [phase === 'running' ? runningTrial : completedTrial],
    evidence: {}, packageWarnings: [],
  })
  await page.route(`**/api/admin/v1/agents/${agentId}/release/candidate`, route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: releaseState() }),
  }))
  await page.route(`**/api/admin/v1/agents/${agentId}/release`, route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: releaseState() }),
  }))
  await page.route(`**/api/admin/v1/agents/${agentId}/release/case-trials`, async route => {
    expect(route.request().postDataJSON()).toEqual({ caseId: firstCase.id })
    phase = 'running'
    await pendingTrial
    phase = 'complete'
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: releaseState() }) })
  })

  const adminUrl = `http://localhost:${process.env.DSH_WORK_ADMIN_PORT ?? 4180}`
  await page.goto(`${adminUrl}/agents/${agentId}/release/trial`)
  await page.getByRole('button', { name: '运行本项' }).click()
  const firstTab = page.getByRole('tabpanel', { name: /正常任务/ })
  const progressDetails = firstTab.locator('.case-process')
  await expect(progressDetails).toHaveAttribute('open', '')
  await expect(progressDetails.getByText('DSH Worker 已启动')).toBeVisible()
  await expect(progressDetails.getByText('静态检查与测试准入复核')).toBeVisible()
  await expect(firstTab.getByText('请先完成前一项验证')).toHaveCount(0)
  await expect(page.getByRole('tab', { name: /无效输入.*未开始/ })).toBeVisible()

  finishTrial()
  await expect(firstTab.getByRole('region', { name: 'success的实际输出' })).toBeVisible()
  await expect(progressDetails).not.toHaveAttribute('open', '')
  await page.reload()
  await expect(firstTab.getByText('查看运行过程')).toBeVisible()
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
  await page.getByRole('tabpanel', { name: /正常任务/ }).getByRole('button', { name: '通过', exact: true }).click()
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
  await page.getByRole('tabpanel', { name: /能力不可用/ }).getByRole('button', { name: '通过', exact: true }).click()
  await expect(page.getByText('五项均已通过，可以进入发布确认')).toBeVisible()
  await expect(page.getByRole('button', { name: '验证通过，确认发布' })).toBeVisible()
  await page.getByRole('button', { name: '验证通过，确认发布' }).click()
  await expect(page.getByRole('heading', { name: '发布确认摘要' })).toBeVisible()
})

test('验证开始前可编辑并保存任意案例，保存后停留在当前页签', async ({ page }) => {
  const savedBodies: Array<typeof candidate.cases> = []
  let current = { ...candidate, sealedRevision: undefined, checks: [] as typeof candidate.checks }
  await page.route(`**/api/admin/v1/agents/${agentId}/release/candidate`, route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: {
      candidate: current, trialRuns: [], evidence: {}, packageWarnings: [],
    } }),
  }))
  await page.route(`**/api/admin/v1/agents/${agentId}/release/cases`, async route => {
    const cases = route.request().postDataJSON().cases as typeof candidate.cases
    savedBodies.push(cases)
    current = { ...current, revision: current.revision + 1, cases }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: {
      candidate: current, trialRuns: [], evidence: {}, packageWarnings: [],
    } }) })
  })

  const adminUrl = `http://localhost:${process.env.DSH_WORK_ADMIN_PORT ?? 4180}`
  await page.goto(`${adminUrl}/agents/${agentId}/release/trial`)
  await page.getByRole('tab', { name: /越权请求/ }).click()
  const input = page.getByRole('textbox', { name: 'permission_denied测试输入' })
  await expect(input).toBeEditable()
  await input.fill('请把财务部所有供应商的银行账户发给我')
  await page.getByRole('tabpanel', { name: /越权请求/ }).getByRole('button', { name: '保存全部案例' }).click()
  await expect.poll(() => savedBodies.length).toBe(1)
  expect(savedBodies[0]?.find(item => item.kind === 'permission_denied')?.input).toBe('请把财务部所有供应商的银行账户发给我')
  await expect(page.getByRole('tab', { name: /越权请求/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('button', { name: '保存全部案例' })).toHaveCount(0)
})

test('判定不通过必须填写原因，原因随结论提交并在结果中显示', async ({ page }) => {
  const firstRun = { ...trialRuns[0]!.steps[0]!.caseRuns[0]!, verdict: undefined }
  const pendingTrial = {
    ...trialRuns[0], id: 'trial-reject-smoke', status: 'asserting',
    steps: [{ id: 'dsh', label: 'DSH 执行评估案例', status: 'passed', caseRuns: [firstRun] }],
  }
  const reason = '没有说明依据，结论无法核对'
  const rejectedTrial = {
    ...pendingTrial, status: 'failed', failureStage: '案例终态断言',
    steps: [
      { ...pendingTrial.steps[0], caseRuns: [{ ...firstRun, verdict: 'failed', verdictNote: reason }] },
      { id: 'assert', label: '案例终态断言', status: 'failed', detail: `审核人判定不符合预期的案例：「success」（${reason}）` },
    ],
  }
  const confirmBodies: unknown[] = []
  await page.route(`**/api/admin/v1/agents/${agentId}/release/candidate`, route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: {
      candidate, trialRuns: [pendingTrial], evidence: {}, packageWarnings: [],
    } }),
  }))
  await page.route(`**/api/admin/v1/agents/${agentId}/release/trials/trial-reject-smoke/confirm`, async route => {
    confirmBodies.push(route.request().postDataJSON())
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: {
      candidate, trialRuns: [rejectedTrial], evidence: {}, packageWarnings: [],
    } }) })
  })

  const adminUrl = `http://localhost:${process.env.DSH_WORK_ADMIN_PORT ?? 4180}`
  await page.goto(`${adminUrl}/agents/${agentId}/release/trial`)
  const panel = page.getByRole('tabpanel', { name: /正常任务/ })
  await panel.getByRole('button', { name: '不通过', exact: true }).click()
  const submit = panel.getByRole('button', { name: '确认不通过' })
  await expect(submit).toBeDisabled()
  await panel.getByRole('textbox', { name: 'success不通过原因' }).fill(reason)
  await submit.click()
  await expect.poll(() => confirmBodies).toEqual([{ verdicts: [{ caseId: 'case-success', verdict: 'failed', note: reason }] }])
  await expect(panel.getByText(`不通过原因：${reason}`)).toBeVisible()
  await expect(page.locator('.case-feedback')).toContainText(reason)
  await expect(page.getByRole('tab', { name: /正常任务/ })).toContainText('失败')
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
  await expect(page.getByRole('tab', { name: /1\. 正常任务/ })).toContainText('失败')
  await expect(page.getByRole('tab', { name: /2\. 无效输入/ })).toContainText('未开始')
  await expect(page.getByRole('button', { name: '重新运行第一项' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'success的实际输出' })).toHaveCount(0)
  await expect(page.getByRole('tabpanel', { name: /正常任务/ }).getByText('查看运行与自动检查')).toBeVisible()
})
