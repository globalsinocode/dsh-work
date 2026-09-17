import { expect, test } from '@playwright/test'

const adminUrl = `http://localhost:${process.env.DSH_WORK_ADMIN_PORT ?? 4180}`

test('employee can open the workbench and enter a team workspace', async ({ page }) => {
  await page.goto('/workbench')

  await expect(page).toHaveTitle(/工作台 · dsh-work/)
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

  await page.getByRole('button', { name: '工作空间', exact: true }).click()
  await expect(page).toHaveURL(/\/workspaces$/)
  await expect(page.getByRole('heading', { name: '工作空间', exact: true })).toBeVisible()
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
  await expect(filesPanel.getByRole('button', { name: '引用到对话' })).toHaveCount(2)

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

  await page.getByRole('button', { name: '连接器管理', exact: true }).click()
  await expect(page).toHaveURL(/\/connectors$/)
  await expect(page.getByRole('button', { name: '全部检查' })).toBeVisible()

  await page.getByRole('button', { name: 'Runtimes', exact: true }).click()
  await expect(page).toHaveURL(/\/runtimes$/)
  await expect(page.getByText('Runtimes', { exact: true }).first()).toBeVisible()
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
