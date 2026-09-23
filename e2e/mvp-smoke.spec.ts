import { expect, test } from '@playwright/test'
import { mockTasks } from '../server/src/infrastructure/prototype/data.ts'

const adminUrl = `http://localhost:${process.env.DSH_WORK_ADMIN_PORT ?? 4180}`

test('employee can open the workbench and enter a team workspace', async ({ page }) => {
  await page.goto('/workbench')

  await expect(page).toHaveTitle(/新对话 · dsh-work/)
  await expect(page.getByRole('heading', { name: /dsh-work，我帮你/ })).toBeVisible()
  await expect(page.getByLabel('对话输入')).toBeVisible()
  await expect(page.getByRole('button', { name: '发送消息' })).toBeDisabled()
  await expect(page.getByLabel('当前活动')).toHaveCount(0)
  await expect(page.getByRole('group', { name: '选择工作模式' })).toHaveCount(0)
  await expect(page.getByLabel('选择执行模式')).toHaveCount(0)
  await expect(page.getByLabel('选择数据权限范围')).toHaveCount(0)
  await expect(page.getByLabel('选择 Agent')).toHaveCount(0)

  const commonTasks = page.getByRole('navigation', { name: '常用任务' })
  await expect(commonTasks.getByRole('button')).toHaveCount(4)
  await commonTasks.getByRole('button', { name: '分析文件' }).click()
  await expect(page.getByLabel('对话输入')).toHaveValue('分析我上传的文件，概括主要指标、异常项和需要跟进的问题。')

  await page.getByRole('button', { name: '团队空间', exact: true }).click()
  await expect(page).toHaveURL(/\/workspaces$/)
  await expect(page.getByRole('heading', { name: '团队空间', exact: true })).toBeVisible()
  await expect(page.getByText('供应链经营分析', { exact: true })).toBeVisible()

  await page.getByText('供应链经营分析', { exact: true }).first().click()
  await expect(page).toHaveURL(/\/workspaces\/ws-supply/)
  // 页签可访问名是「标签 + 计数」（如「对话 12」）；对话页签内还有一层
  // 「新对话／历史对话」切换（同为 role=tab），因此限定在外层 tablist 内匹配。
  const workspaceTabs = page.getByRole('tablist', { name: '工作空间内容' })
  await expect(workspaceTabs.getByRole('tab', { name: /^对话/ })).toHaveAttribute('aria-selected', 'true')
  await expect(workspaceTabs.getByRole('tab', { name: /^共享文件/ })).toBeVisible()
  await expect(workspaceTabs.getByRole('tab', { name: /^成果/ })).toBeVisible()
})

test('employee can inspect shared files and workspace artifacts', async ({ page }) => {
  await page.goto('/workspaces/ws-supply?tab=files')

  const workspaceTabs = page.getByRole('tablist', { name: '工作空间内容' })
  await expect(workspaceTabs.getByRole('tab', { name: /^共享文件/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('heading', { name: '共享文件', exact: true })).toBeVisible()

  const filesPanel = page.locator('#workspace-panel-files')
  await expect(filesPanel.getByText('八月生产计划_v3.xlsx', { exact: true })).toBeVisible()
  await expect(filesPanel.getByText('华东区交付口径说明.docx', { exact: true })).toBeVisible()
  // Prototype 文件没有服务端确认的 canReference，团队文件不得提供引用入口。
  await expect(filesPanel.getByRole('button', { name: '引用到对话' })).toHaveCount(0)

  await workspaceTabs.getByRole('tab', { name: /^成果/ }).click()
  await expect(page.getByRole('heading', { name: '成果', exact: true })).toBeVisible()
  await expect(page.getByText('华东区订单交付风险清单.xlsx', { exact: true })).toBeVisible()
  await expect(page.getByText('华东区交付风险分析报告.pdf', { exact: true })).toBeVisible()
})

test('employee can preview an HTML artifact inside a sandboxed frame', async ({ page }) => {
  // ART-E2E-01：HTML 成果沙箱预览。
  await page.goto('/workspaces/ws-supply?tab=artifacts')

  const htmlCard = page.locator('.artifact-card', { hasText: '华东区交付风险看板.html' })
  await expect(htmlCard).toBeVisible()
  await expect(htmlCard.getByRole('button', { name: '预览' })).toBeVisible()
  // 非 HTML 成果不提供预览入口。
  const xlsxCard = page.locator('.artifact-card', { hasText: '华东区订单交付风险清单.xlsx' })
  await expect(xlsxCard.getByRole('button', { name: '预览' })).toHaveCount(0)

  await htmlCard.getByRole('button', { name: '预览' }).click()
  const dialog = page.getByRole('dialog', { name: /成果预览/ })
  await expect(dialog).toBeVisible()

  const frame = dialog.locator('iframe[data-testid="artifact-preview-frame"]')
  // opaque origin：允许内联脚本，但不与主机同源（不含 allow-same-origin）。
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
  await expect(page.frameLocator('iframe[data-testid="artifact-preview-frame"]').getByText('华东区交付风险看板')).toBeVisible()

  // el-radio-button 的原生 input 视觉隐藏，点击命中的是包裹它的 label 文本。
  await dialog.getByText('源代码', { exact: true }).click()
  await expect(dialog.getByTestId('artifact-preview-source')).toContainText('E2E-HTML-ARTIFACT-20260917')

  await dialog.getByRole('button', { name: '关闭成果预览' }).click()
  await expect(dialog).toBeHidden()
})

test('administrator can navigate governance modules and switch Skill tabs', async ({ page }) => {
  await page.goto(`${adminUrl}/capabilities`)

  await expect(page).toHaveTitle(/Skill 管理 · dsh-work/)
  await expect(page.getByText('管理平台', { exact: true })).toBeVisible()
  const skillTabs = page.getByRole('tablist', { name: 'Skill 管理' })
  await expect(skillTabs.getByRole('tab', { name: /Skill 列表/ })).toHaveAttribute('aria-selected', 'true')
  await skillTabs.getByRole('tab', { name: '新增 Skill' }).click()
  await expect(page).toHaveURL(/\/skills\/install$/)

  await page.getByRole('button', { name: 'MCP 连接器', exact: true }).click()
  await expect(page).toHaveURL(/\/connectors$/)
  await expect(page.getByRole('button', { name: '全部检查' })).toBeVisible()
  await expect(page.getByText('企业知识 MCP', { exact: true })).toBeVisible()
  await expect(page.getByText('DSH Runtime 内置工具连接器', { exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'DSH 工具管理', exact: true }).click()
  await expect(page).toHaveURL(/\/tools$/)
  await page.getByRole('button', { name: '同步 DSH 工具', exact: true }).click()
  await expect(page.getByText('编辑文本文件', { exact: true })).toBeVisible()
  await expect(page.getByText('任务进度清单', { exact: true })).toBeVisible()
  await expect(page.getByText('在 Agent 版本中配置', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('不代表任何 Agent 已经获得使用权', { exact: false })).toBeVisible()

  const admissionFilter = page.getByTestId('tool-admission-filter')
  const runtimeStatusFilter = page.getByTestId('tool-runtime-status-filter')
  await admissionFilter.click()
  await page.locator('.el-select-dropdown:visible').getByRole('option', { name: '可授权', exact: true }).click()
  await expect(page.getByText('编辑文本文件', { exact: true })).toBeVisible()

  await runtimeStatusFilter.click()
  await page.locator('.el-select-dropdown:visible').getByRole('option', { name: '已停用', exact: true }).click()
  await expect(page.getByText('暂无匹配的 DSH 内置工具', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Runtimes', exact: true }).click()
  await expect(page).toHaveURL(/\/runtimes$/)
  await expect(page.getByText('Runtimes', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: '查看' }).first().click()
  const dshConnector = page.getByRole('region', { name: 'DSH Runtime 内置工具连接' })
  await expect(dshConnector.getByText('connector-dsh-workspace', { exact: true })).toBeVisible()
  await expect(dshConnector.getByRole('button', { name: '检查工具连接' })).toBeVisible()
})

test('platform administrator can inspect and resolve an action-bound approval', async ({ page }) => {
  const approval = {
    id: 'approval-e2e', runId: 'run-e2e', taskId: 'task-e2e', sourceAttemptId: 'attempt-source',
    checkpointId: 'checkpoint-e2e', checkpointDigest: 'a'.repeat(64), actionName: 'erp.update',
    parameterDigest: 'b'.repeat(64), resourceRef: 'erp://orders/42', executionIdentity: 'U00008',
    dataVersion: 'etag-v1', riskLevel: 'high', status: 'pending',
    expiresAt: '2026-09-23T00:00:00.000Z', requestedAt: '2026-09-22T00:00:00.000Z',
    resolvedBy: null, resolvedAt: null, resumedAttemptId: null, actionConsumedAt: null,
  }
  let resolved = false
  await page.route('**/api/admin/v1/approvals**', async (route) => {
    if (route.request().method() === 'POST') {
      resolved = true
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: {
        ...approval, status: 'approved', resolvedBy: 'U00008', resolvedAt: '2026-09-22T00:01:00.000Z', resumedAttemptId: 'attempt-resumed',
      }, meta: { api: 'admin', adapter: 'prototype-memory', timestamp: new Date().toISOString() } }) })
      return
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      data: resolved ? [{ ...approval, status: 'approved', resolvedBy: 'U00008', resolvedAt: '2026-09-22T00:01:00.000Z', resumedAttemptId: 'attempt-resumed' }] : [approval],
      meta: { api: 'admin', adapter: 'prototype-memory', timestamp: new Date().toISOString() },
    }) })
  })
  await page.goto(`${adminUrl}/approvals`)
  await expect(page.locator('.admin-topbar').getByText('动作审批', { exact: true })).toBeVisible()
  const row = page.getByRole('row').filter({ hasText: 'erp.update' })
  await expect(row).toContainText('erp://orders/42')
  await expect(row).toContainText('bbbbbbbbbbbb')
  await row.getByRole('button', { name: '批准', exact: true }).click()
  await page.getByRole('dialog', { name: '批准动作' }).getByRole('button', { name: '批准', exact: true }).click()
  await expect(page.getByText('已批准并创建恢复 Attempt', { exact: true })).toBeVisible()
  await expect(row).toHaveCount(0)
  expect(resolved).toBe(true)
})

test('platform administrator can review one Agent experience iteration application', async ({ page }) => {
  const application = {
    id: 'memory-proposal-e2e', agentId: 'agent-quality', agentName: '质量分析 Agent',
    sourceAgentVersionId: 'agent-version-quality-2', sourceAgentVersion: '2.0.0',
    sourceRunId: 'run-quality-e2e', sourceAttemptId: 'attempt-quality-e2e', proposedBy: 'principal-agent-quality',
    title: '异常分析核对方法',
    content: '分析异常时先核对当前数据版本、缺失字段和外部操作回执，再形成可复核的结论。',
    contentDigest: 'b'.repeat(64), status: 'pending', reviewedBy: null, reviewedAt: null,
    reviewComment: null, publishedVersionId: null, createdAt: '2026-09-22T00:00:00.000Z',
  }
  let published = false
  await page.route('**/api/admin/v1/experience-iterations/agents', async route => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      data: [{
        agentId: application.agentId, agentName: application.agentName, agentVersion: '2.1.0', agentStatus: 'published',
        totalApplications: published ? 1 : 1, pendingApplications: published ? 0 : 1,
        approvedApplications: published ? 1 : 0, rejectedApplications: 0, latestApplicationAt: application.createdAt,
      }],
      meta: { api: 'admin', adapter: 'postgres', timestamp: new Date().toISOString() },
    }) })
  })
  await page.route('**/api/admin/v1/experience-iterations/applications**', async route => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      data: published ? [] : [application],
      meta: { api: 'admin', adapter: 'postgres', timestamp: new Date().toISOString() },
    }) })
  })
  await page.route('**/api/admin/v1/experience-iterations/applications/*/review', async (route) => {
    if (route.request().method() === 'POST') {
      published = true
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        data: { ...application, status: 'approved', publishedVersionId: 'memory-version-e2e' },
        meta: { api: 'admin', adapter: 'postgres', timestamp: new Date().toISOString() },
      }) })
      return
    }
    await route.continue()
  })

  await page.goto(`${adminUrl}/experience-iterations`)
  await expect(page.locator('.admin-topbar').getByText('经验迭代', { exact: true })).toBeVisible()
  await expect(page.locator('.admin-topbar__subtitle')).toContainText('按稳定 Agent 归属')
  await expect(page.getByRole('alert').filter({ hasText: '经验迭代按稳定 Agent 归属' })).toHaveCount(0)
  const row = page.getByRole('row').filter({ hasText: '异常分析核对方法' })
  await expect(row).toContainText('质量分析 Agent')
  await expect(row).toContainText('run-quality-e2e')
  await row.getByRole('button', { name: '批准发布', exact: true }).click()
  await page.getByRole('dialog', { name: '批准并发布经验迭代申请' }).getByRole('button', { name: '批准并发布', exact: true }).click()
  await expect(page.getByText('已发布 Agent 经验版本', { exact: true })).toBeVisible()
  expect(published).toBe(true)
})

test('employee conversations do not expose controlled-memory submission', async ({ page }) => {
  const run = mockTasks.find(item => item.id === 'run-260827-002')
  if (!run) throw new Error('Missing succeeded personal Run fixture')
  const runDetail = {
    ...run,
    requestedBy: 'U00001',
    messages: run.messages.map(message => message.role === 'assistant'
      ? { ...message, runId: run.id }
      : message),
  }
  await page.route(`**/api/workbench/v1/runs/${run.id}`, async route => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      data: runDetail, meta: { api: 'workbench', adapter: 'prototype', timestamp: new Date().toISOString() },
    }) })
  })
  await page.goto(`/conversations/${run.id}`)
  await expect(page.getByText('委外加工发料应依据已审核的委外订单执行', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: '提交受控记忆候选' })).toHaveCount(0)
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: '用户中心' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '受控记忆授权' })).toHaveCount(0)
})

test('administrator can open system information from the user menu', async ({ page }) => {
  await page.goto(`${adminUrl}/overview`)

  const userMenu = page.getByRole('button', { name: /平台管理员/ })
  await expect(userMenu).toBeVisible()
  await userMenu.click()
  await page.getByRole('menuitem', { name: '关于 dsh-work' }).click()

  await expect(page).toHaveURL(/\/about$/)
  await expect(page.getByRole('heading', { name: 'dsh-work 管理平台' })).toBeVisible()
  await expect(page.getByTestId('about-system-version')).toHaveText(/^v\d{4}\.\d{2}\.\d{2}-\d{2}$/)
  await expect(page.getByTestId('about-dsh-version')).toHaveText('0.1.2-rc.1')
})

test('administrator can read the integration guide and api docs', async ({ page }) => {
  await page.goto(`${adminUrl}/overview`)

  const nav = page.getByRole('navigation', { name: '管理后台主导航' })
  await expect(nav.getByRole('button', { name: '接入规范' })).toBeVisible()
  await expect(nav.getByRole('button', { name: '接口文档' })).toBeVisible()

  await nav.getByRole('button', { name: '接入规范' }).click()
  await expect(page).toHaveURL(/\/docs\/guide$/)
  await expect(page.getByRole('heading', { name: '移动端接入规范' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '认证与会话' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '事件流（SSE）' })).toBeVisible()

  const [guideDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('download-guide').click(),
  ])
  expect(guideDownload.suggestedFilename()).toBe('dsh-work-移动端接入规范.md')

  await nav.getByRole('button', { name: '接口文档' }).click()
  // Scalar 会附加文档内锚点（如 #description/introduction），只断言路径前缀。
  await expect(page).toHaveURL(/\/docs\/api/)
  const apiPanel = page.getByTestId('api-docs-panel')
  // 页面渲染移动端 H5 子集契约（openapi-mobile-h5.json）：左侧接口目录按 tag
  // 分组，正文以「接口信息表 + 请求/响应报文 + 字段表」展示每个端点。
  // 以下断言对应其中路径 /workspaces 与 /runs/{runId}/events 的 summary。
  await expect(apiPanel.getByRole('heading', { name: /查询当前员工的个人工作空间/ })).toBeVisible()
  await expect(apiPanel.getByRole('link', { name: /通过 SSE 订阅 Run 事件/ })).toBeVisible()
  // 端点信息表包含 HTTP URL / HTTP Method / 权限要求三行。
  await expect(apiPanel.getByText('权限要求').first()).toBeVisible()
  await expect(apiPanel.getByText(/GET \/api\/workbench\/v1\/session/).first()).toBeVisible()

  const [specDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('download-spec').click(),
  ])
  expect(specDownload.suggestedFilename()).toBe('openapi-mobile-h5.json')
})
