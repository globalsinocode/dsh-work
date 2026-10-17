import { expect, test } from '@playwright/test'

// P0 页面冒烟：详情页经验分区按 Agent 审核经验申请；申请由路由夹具提供。
const agentId = 'operations-analyst'
const adminUrl = `http://localhost:${process.env.DSH_WORK_ADMIN_PORT ?? 4180}`

const pending = {
  id: 'memory-proposal-detail', agentId, agentName: '运营分析助手',
  sourceAgentVersionId: 'agent-version-operations-030', sourceAgentVersion: '0.3.0',
  sourceRunId: 'run-operations-e2e', sourceAttemptId: 'attempt-operations-e2e', proposedBy: `principal-agent-${agentId}`,
  title: '周报核对顺序', content: '整理周报前先核对数据截止时间和缺失字段，再给出结论与依据。',
  contentDigest: 'c'.repeat(64), status: 'pending', reviewedBy: null, reviewedAt: null,
  reviewComment: null as string | null, publishedVersionId: null as string | null, createdAt: '2026-10-16T00:00:00.000Z',
}

test('详情页经验分区按 Agent 审核：拒绝须写原因，批准后进入已发布', async ({ page }) => {
  let current = [pending]
  const queries: string[] = []
  const reviews: unknown[] = []
  await page.route(url => url.pathname.endsWith('/api/admin/v1/experience-iterations/applications'), async route => {
    queries.push(new URL(route.request().url()).searchParams.get('agentId') ?? '')
    await route.fulfill({ json: { data: current } })
  })
  await page.route('**/api/admin/v1/experience-iterations/applications/*/review', async route => {
    const body = route.request().postDataJSON() as { decision: 'approved' | 'rejected'; comment?: string }
    reviews.push(body)
    current = [{ ...pending, status: body.decision, reviewComment: body.comment ?? null,
      publishedVersionId: body.decision === 'approved' ? 'memory-version-detail' : null }]
    await route.fulfill({ json: { data: current[0] } })
  })

  await page.route('**/api/admin/v1/experience-iterations/agents/*/experiences', route => route.fulfill({ json: { data: [] } }))
  await page.goto(`${adminUrl}/agents/${agentId}?section=experience`)
  const section = page.getByRole('region', { name: '经验' })
  await expect(page.getByRole('tab', { name: '经验', selected: true })).toBeVisible()
  await expect.poll(() => queries).toContain(agentId)
  await expect(section.getByRole('tab', { name: /待审核/ })).toContainText('1')
  await section.getByRole('row').filter({ hasText: '周报核对顺序' }).getByRole('button', { name: '审核' }).click()

  const dialog = page.getByRole('dialog', { name: '经验申请' })
  await expect(dialog).toContainText('run-operations-e2e / attempt-operations-e2e')
  await dialog.getByRole('button', { name: '拒绝' }).click()
  await expect(dialog).toContainText('拒绝时必须填写原因')
  expect(reviews).toEqual([])
  await dialog.getByRole('textbox', { name: '审核说明' }).fill('已核对来源，可作为通用做法')
  await dialog.getByRole('button', { name: '批准并发布' }).click()
  await expect.poll(() => reviews).toEqual([expect.objectContaining({ decision: 'approved', comment: '已核对来源，可作为通用做法' })])
  await expect(page.getByText('已发布 Agent 经验版本', { exact: true })).toBeVisible()
  await expect(section.getByRole('tab', { name: /待审核/ })).toContainText('0')
  await section.getByRole('tab', { name: /已发布/ }).click()
  await expect(section.getByRole('row').filter({ hasText: '周报核对顺序' })).toContainText('已发布')
})

test('全局经验迭代页可跳到对应 Agent 的经验分区', async ({ page }) => {
  await page.route('**/api/admin/v1/experience-iterations/agents', route => route.fulfill({ json: { data: [{
    agentId, agentName: pending.agentName, agentVersion: '0.3.0', agentStatus: 'published',
    totalApplications: 1, pendingApplications: 1, approvedApplications: 0, rejectedApplications: 0,
    latestApplicationAt: pending.createdAt,
  }] } }))
  await page.route('**/api/admin/v1/experience-iterations/applications**', route => route.fulfill({ json: { data: [pending] } }))
  await page.route('**/api/admin/v1/experience-iterations/agents/*/experiences', route => route.fulfill({ json: { data: [] } }))
  await page.goto(`${adminUrl}/experience-iterations`)
  await page.getByRole('link', { name: `打开 ${pending.agentName} 的经验分区` }).click()
  await expect(page).toHaveURL(new RegExp(`/agents/${agentId}\\?section=experience$`))
  await expect(page.getByRole('tab', { name: '经验', selected: true })).toBeVisible()
})
