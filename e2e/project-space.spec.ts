import { expect, test } from '@playwright/test'

// P2-28：每个 P0 用例从同一份内存夹具开始，避免可变状态跨用例泄漏。
test.beforeEach(async ({ page }) => {
  await page.request.post('/api/testing/p0/reset')
})

// 项目空间 S1/S2 的 P0 冒烟旅程（e2e/TEST-CATALOG.md PS-E2E-01、PS-E2E-02、PS-E2E-05）。
// 冒烟服务只提供 ws-supply 的内存名册、简报、员工任务与项目档案；档案员整理、Agent 任务执行、权限矩阵与
// 持久化由服务端集成测试和 P1 旅程覆盖，这里不能据此宣称真实链路通过。

test('PS-E2E-01 项目简报查看与编辑', async ({ page }) => {
  await page.goto('/workspaces/ws-supply')
  const brief = page.getByTestId('project-brief')
  await expect(brief.getByRole('heading', { name: '项目简报' })).toBeVisible()
  await expect(page.getByTestId('project-brief-content')).not.toBeEmpty()

  const content = `目标：缺货率降到 2%（${Date.now()}）`
  await brief.getByRole('button', { name: '编辑简报' }).click()
  const editor = page.getByRole('dialog', { name: '编辑项目简报' })
  await editor.getByLabel('简报内容').fill(content)
  await editor.getByLabel('截止时间').fill('2026-12-31')
  await editor.getByLabel('截止时间').press('Enter')
  await editor.getByRole('button', { name: '保存' }).click()
  await expect(editor).toBeHidden()
  await expect(page.getByTestId('project-brief-content')).toHaveText(content)
  await expect(page.getByTestId('project-brief-due')).toContainText('2026-12-31')
  await expect(brief).toContainText('林岚 更新于')

  // 清空截止时间：保存后不再显示截止标记。
  await brief.getByRole('button', { name: '编辑简报' }).click()
  await editor.getByLabel('截止时间').fill('')
  await editor.getByLabel('截止时间').press('Enter')
  await editor.getByRole('button', { name: '保存' }).click()
  await expect(editor).toBeHidden()
  await expect(page.getByTestId('project-brief-due')).toHaveCount(0)
})

test('PS-E2E-02 员工任务创建与完成', async ({ page }) => {
  await page.goto('/workspaces/ws-supply')
  const tabs = page.getByRole('tablist', { name: '工作空间内容' })
  await expect(tabs.getByRole('tab')).toHaveText([/^任务/, /^对话/, /^共享文件/, /^成果/, /^档案/])
  await expect(tabs.getByRole('tab', { name: /^任务/ })).toHaveAttribute('aria-selected', 'true')

  const title = `整理华东供应商名单 ${Date.now()}`
  await page.getByRole('button', { name: '新建任务' }).first().click()
  const editor = page.getByRole('dialog', { name: '新建任务' })
  await editor.getByLabel('任务标题').fill(title)
  await editor.getByLabel('任务说明').fill('按区域分组')
  // Element Plus 下拉按既有 E2E 约定用键盘操作。
  const assignee = editor.getByRole('combobox', { name: '承接者' })
  await assignee.press('Enter')
  await expect(page.getByRole('option', { name: '周衡' })).toBeVisible()
  await assignee.press('ArrowDown')
  await assignee.press('ArrowDown')
  await assignee.press('Enter')
  await expect(editor).toContainText('周衡')
  await editor.getByRole('button', { name: '保存' }).click()
  await expect(editor).toBeHidden()

  const row = page.getByTestId('project-task-row').filter({ hasText: title })
  await expect(row.getByTestId('project-task-status')).toHaveText('待办')
  await expect(row.getByTestId('project-task-assignee-cell')).toContainText('周衡')

  await row.getByRole('button', { name: '开始处理' }).click()
  await expect(row.getByTestId('project-task-status')).toHaveText('进行中')

  await row.getByRole('button', { name: '完成' }).click()
  const completion = page.getByRole('dialog', { name: new RegExp(`完成任务“${title}”`) })
  await completion.getByLabel('完成说明').fill('已按华东、华南分组')
  await completion.getByRole('button', { name: '确认完成' }).click()
  await expect(completion).toBeHidden()
  await expect(row.getByTestId('project-task-status')).toHaveText('已完成')
  await expect(row.getByTestId('project-task-note')).toContainText('已按华东、华南分组')
})

test('PS-E2E-05 项目档案查看、编辑与回退', async ({ page }) => {
  await page.goto('/workspaces/ws-supply')
  const tabs = page.getByRole('tablist', { name: '工作空间内容' })
  await tabs.getByRole('tab', { name: /^档案/ }).click()
  await expect(tabs.getByRole('tab', { name: /^档案/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page).toHaveURL(/tab=archive/)

  const meta = page.getByTestId('project-archive-meta')
  const items = page.getByTestId('project-archive-item')
  await expect(items.first()).toBeVisible()
  const versionOf = async () => Number((await meta.innerText()).match(/第 (\d+) 版/)![1])
  const start = await versionOf()

  // 行内编辑第一条：版本号加一，来源为本人手动编辑。
  const edited = `华东缺货集中在高周转 SKU 类目（复核 ${Date.now()}）`
  await page.getByRole('button', { name: '编辑第 1 条' }).click()
  await page.getByLabel('修改第 1 条').fill(edited)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(items.first()).toContainText(edited)
  await expect(meta).toContainText(`第 ${start + 1} 版`)
  await expect(meta).toContainText('林岚手动编辑')

  // 添加一条、删除一条（删除前确认）：每次保存都生成新版本。
  const added = `进展：安全库存方案待评审（${Date.now()}）`
  await page.getByRole('button', { name: '添加一条' }).click()
  await page.getByLabel('新条目').fill(added)
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await expect(items.last()).toContainText(added)
  await expect(meta).toContainText(`第 ${start + 2} 版`)
  const count = await items.count()
  await page.getByRole('button', { name: `删除第 ${count} 条` }).click()
  const confirm = page.getByRole('dialog', { name: '删除这一条？' })
  await confirm.getByRole('button', { name: '删除' }).click()
  await expect(items).toHaveCount(count - 1)
  await expect(page.getByText(added)).toHaveCount(0)
  await expect(meta).toContainText(`第 ${start + 3} 版`)

  // 版本历史：查看档案员版本的变更，回退到第 1 版生成新版本，历史保留。
  await page.getByRole('button', { name: '版本历史' }).click()
  const history = page.getByRole('dialog', { name: '档案版本历史' })
  const versions = history.getByTestId('project-archive-version')
  await expect(versions).toHaveCount(start + 3)
  const archivistVersion = versions.filter({ hasText: '项目档案员' }).first()
  await expect(archivistVersion).toContainText('依据任务「分析华东缺货原因」的成果')
  await archivistVersion.getByRole('button', { name: '查看变更' }).click()
  await expect(history.getByTestId('project-archive-changes')).toContainText('新增')
  await versions.filter({ hasText: /^第 1 版/ }).getByRole('button', { name: '回退到此版' }).click()
  await page.getByRole('dialog', { name: '回退到第 1 版？' }).getByRole('button', { name: '确认回退' }).click()
  await expect(history).toBeHidden()
  await expect(meta).toContainText(`第 ${start + 4} 版`)
  await expect(meta).toContainText('林岚回退到第 1 版')

  // 右栏：项目简报与成员可收起；Agent 分组固定显示项目档案员（系统）。
  const briefToggle = page.getByTestId('project-brief').getByRole('button', { name: '项目简报' })
  await briefToggle.click()
  await expect(briefToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('project-brief-content')).toBeHidden()
  await briefToggle.click()
  await expect(page.getByTestId('project-brief-content')).toBeVisible()
  const membersToggle = page.getByRole('button', { name: '成员', exact: true })
  await membersToggle.click()
  await expect(membersToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('panel-employee-section')).toBeHidden()
  await membersToggle.click()
  await expect(page.getByTestId('panel-employee-section')).toBeVisible()
  await expect(page.getByTestId('panel-archivist-row')).toContainText('项目档案员')
  await expect(page.getByTestId('panel-archivist-row')).toContainText('系统')

  // 收起状态是本浏览器偏好：两者都收起后刷新，仍保持收起（人工验收 6.9）。
  await briefToggle.click()
  await membersToggle.click()
  await expect(briefToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(membersToggle).toHaveAttribute('aria-expanded', 'false')
  await page.reload()
  await expect(page.getByTestId('panel-archivist-row')).toBeVisible()
  await expect(membersToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(briefToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('project-brief-content')).toBeHidden()
})
