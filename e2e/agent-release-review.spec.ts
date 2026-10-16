import { expect, test, type Page } from '@playwright/test'

// P0 页面冒烟：验证与发布页只做前端交互，服务端响应由路由夹具提供；
// 验证到发布的真实链路由 agent-release-governance 集成套件覆盖。
const agentId = 'operations-analyst'
const adminUrl = `http://localhost:${process.env.DSH_WORK_ADMIN_PORT ?? 4180}`
const releasePath = `**/api/admin/v1/agents/${agentId}`

const access = {
  agentId, revision: 1, principalId: `principal-agent-${agentId}`, principalStatus: 'active',
  visibleRoleIds: ['role-employee'], roleIds: ['role-employee'], dataScopes: ['当前工作空间'],
  roleOptions: [{ id: 'role-employee', name: '员工', status: 'active' }], scopeOptions: [],
  capabilities: [], routines: [],
}

const passedChecks = { runRecorded: true, executionSucceeded: true, outputNonEmpty: true }

function validationCase(position: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `case-${position + 1}`, position, source: position === 0 ? 'example' : 'custom', sourceRef: null,
    prompt: position === 0 ? '请汇总本周供应异常' : '只能访问授权数据时你会怎么做？',
    status: 'succeeded', runId: `run-${position + 1}`, attemptId: `attempt-${position + 1}`, runCount: 1,
    checks: passedChecks, output: '符合预期的回答', error: null,
    verdict: null as 'passed' | 'failed' | null, verdictNote: null as string | null, verdictBy: null, verdictAt: null,
    startedAt: '2026-10-16T00:00:00.000Z', finishedAt: '2026-10-16T00:00:05.000Z',
    ...overrides,
  }
}

function validation(cases: Array<ReturnType<typeof validationCase>>, status = 'completed') {
  return {
    id: 'validation-smoke', agentId, agentVersionId: 'agent-version-operations-040', version: '0.4.0',
    status, createdBy: 'admin', createdAt: '2026-10-16T00:00:00.000Z', completedAt: null, cases,
    publishable: cases.every(item => item.verdict === 'passed'),
  }
}

function overview(current: ReturnType<typeof validation> | null, overrides: Record<string, unknown> = {}) {
  return {
    agentId,
    activeVersion: { id: 'agent-version-operations-030', version: '0.3.0' },
    draft: { id: 'agent-version-operations-040', version: '0.4.0', status: current ? 'candidate' : 'draft' },
    candidate: current ? { id: 'agent-version-operations-040', version: '0.4.0' } : null,
    draftChanged: false,
    testCases: [{ id: 'test-case-1', prompt: '只能访问授权数据时你会怎么做？' }],
    plannedCases: [
      { source: 'example', sourceRef: null, prompt: '请汇总本周供应异常' },
      { source: 'custom', sourceRef: 'test-case-1', prompt: '只能访问授权数据时你会怎么做？' },
    ],
    checks: [
      { id: 'audience', label: '可见角色', passed: true, detail: '1 个可见角色' },
      { id: 'authorization', label: '工具授权', passed: true, detail: '已获授权' },
      { id: 'cases', label: '验证案例', passed: true, detail: '2 个案例' },
    ],
    usesMcp: false,
    validation: current,
    ...overrides,
  }
}

async function serveRelease(page: Page, release: ReturnType<typeof overview>) {
  await page.route(releasePath, async route => {
    if (route.request().method() !== 'GET') return route.fallback()
    // 页面优先使用 Agent 列表中的定义；这里只需返回发布总览。
    await route.fulfill({ json: { data: { agent: { id: agentId, name: '运营分析助手' }, release } } })
  })
  await page.route(`${releasePath}/versions`, route => route.fulfill({ json: { data: { items: [] } } }))
}

test.beforeEach(async ({ page }) => {
  await page.route(`**/api/admin/v1/agents/${agentId}/access`, route => route.fulfill({ json: { data: access } }))
})

test('旧发布工作台地址落到详情页的验证与发布分区，显示验证前检查与将运行的案例', async ({ page }) => {
  await serveRelease(page, overview(null))
  await page.goto(`${adminUrl}/agents/${agentId}/release/trial`)
  await expect(page).toHaveURL(new RegExp(`/agents/${agentId}\\?section=release$`))
  await expect(page.getByRole('tab', { name: '验证与发布', selected: true })).toBeVisible()
  await expect(page.getByRole('region', { name: '验证前检查' })).toContainText('3/3 项通过')
  const cases = page.getByRole('region', { name: '验证案例' })
  await expect(cases.getByRole('list', { name: '本次将运行的案例' })).toContainText('请汇总本周供应异常')
  await expect(cases.getByRole('list', { name: '本次将运行的案例' })).toContainText('自定义问题')
  await expect(page.getByRole('button', { name: '开始验证' })).toBeEnabled()
  await expect(page.getByRole('region', { name: '确认发布' })).toHaveCount(0)
  for (const removed of ['提交审核', '退回修改', '撤回候选', '运行本项']) {
    await expect(page.getByRole('button', { name: removed })).toHaveCount(0)
  }
})

test('验证前检查未通过时不能开始验证', async ({ page }) => {
  await serveRelease(page, overview(null, {
    checks: [{ id: 'audience', label: '可见角色', passed: false, detail: '还没有设置可见角色' }],
  }))
  await page.goto(`${adminUrl}/agents/${agentId}?section=release`)
  await expect(page.getByRole('region', { name: '验证前检查' })).toContainText('还没有设置可见角色')
  await expect(page.getByRole('button', { name: '开始验证' })).toBeDisabled()
})

test('全部案例判定通过后一次确认发布，发布说明随请求提交', async ({ page }) => {
  let current = validation([validationCase(0), validationCase(1)])
  await serveRelease(page, overview(current))
  await page.route(`${releasePath}/validations/validation-smoke`, route => route.fulfill({ json: { data: current } }))
  await page.route(`${releasePath}/validations/validation-smoke/cases/*/verdict`, async route => {
    const caseId = route.request().url().split('/cases/')[1]!.split('/')[0]!
    const body = route.request().postDataJSON() as { verdict: 'passed' | 'failed'; note?: string }
    current = validation(current.cases.map(item => item.id === caseId
      ? { ...item, verdict: body.verdict, verdictNote: body.note ?? null } : item))
    await route.fulfill({ json: { data: current } })
  })
  const publishBodies: unknown[] = []
  await page.route(`${releasePath}/publish`, async route => {
    publishBodies.push(route.request().postDataJSON())
    await route.fulfill({ json: { data: overview(null, { draft: null, candidate: null }) } })
  })

  await page.goto(`${adminUrl}/agents/${agentId}?section=release`)
  const publish = page.getByRole('button', { name: '确认发布' })
  await expect(publish).toBeDisabled()
  await page.getByRole('article', { name: '案例 1' }).getByRole('button', { name: '通过', exact: true }).click()
  await page.getByRole('article', { name: '案例 2' }).getByRole('button', { name: '通过', exact: true }).click()
  await expect(page.getByRole('region', { name: '验证结果' })).toContainText('2 项判定通过')
  await page.getByRole('textbox', { name: '发布说明' }).fill('业务确认通过')
  await publish.click()
  await expect.poll(() => publishBodies).toEqual([{ validationId: 'validation-smoke', note: '业务确认通过' }])
  await expect(page.getByText('发布完成')).toBeVisible()
})

test('判定不通过必须填写原因；机器检查未通过的案例不能判为通过，可单独重跑', async ({ page }) => {
  let current = validation([validationCase(0, {
    status: 'interrupted', checks: { runRecorded: true, executionSucceeded: false, outputNonEmpty: false },
    output: '', error: '服务重启中断',
  })])
  await serveRelease(page, overview(current))
  await page.route(`${releasePath}/validations/validation-smoke`, route => route.fulfill({ json: { data: current } }))
  const verdictBodies: unknown[] = []
  await page.route(`${releasePath}/validations/validation-smoke/cases/case-1/verdict`, async route => {
    const body = route.request().postDataJSON() as { verdict: 'failed'; note: string }
    verdictBodies.push(body)
    current = validation([{ ...current.cases[0]!, verdict: body.verdict, verdictNote: body.note }])
    await route.fulfill({ json: { data: current } })
  })
  let reruns = 0
  await page.route(`${releasePath}/validations/validation-smoke/cases/case-1/rerun`, async route => {
    reruns += 1
    current = validation([validationCase(0, { runCount: 2 })])
    await route.fulfill({ json: { data: current } })
  })

  await page.goto(`${adminUrl}/agents/${agentId}?section=release`)
  const item = page.getByRole('article', { name: '案例 1' })
  await expect(item).toContainText('服务重启中断')
  await expect(item.getByRole('list', { name: '机器检查' })).toContainText('✕ 执行成功')
  await expect(item.getByRole('button', { name: '通过', exact: true })).toBeDisabled()

  const reason = '中断后没有回答，需要重跑'
  await item.getByRole('button', { name: '不通过', exact: true }).click()
  const submit = item.getByRole('button', { name: '确认不通过' })
  await expect(submit).toBeDisabled()
  await item.getByRole('textbox', { name: '案例 1 不通过原因' }).fill(reason)
  await submit.click()
  await expect.poll(() => verdictBodies).toEqual([{ verdict: 'failed', note: reason }])
  await expect(item.getByText(`不通过原因：${reason}`)).toBeVisible()

  await item.getByRole('button', { name: '重跑本项' }).click()
  await expect.poll(() => reruns).toBe(1)
  await expect(item).toContainText('第 2 次运行')
  await expect(item.getByRole('button', { name: '通过', exact: true })).toBeEnabled()
})

test('草稿在验证后被修改时提示结果不代表新草稿', async ({ page }) => {
  const current = validation([validationCase(0)])
  await serveRelease(page, overview(current, {
    draft: { id: 'agent-version-operations-050', version: '0.5.0', status: 'draft' }, draftChanged: true,
  }))
  await page.route(`${releasePath}/validations/validation-smoke`, route => route.fulfill({ json: { data: current } }))
  await page.goto(`${adminUrl}/agents/${agentId}?section=release`)
  await expect(page.getByText('草稿已修改')).toBeVisible()
  await expect(page.getByRole('button', { name: '验证修改后的草稿' })).toBeEnabled()
})
