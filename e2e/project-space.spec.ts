import { expect, test } from '@playwright/test'

// 项目空间 S1 的 P0 冒烟旅程（e2e/TEST-CATALOG.md PS-E2E-01、PS-E2E-02）。
// 冒烟服务只提供 ws-supply 的内存名册、简报与员工任务；Agent 任务执行、权限矩阵与
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
  await expect(tabs.getByRole('tab')).toHaveText([/^任务/, /^对话/, /^共享文件/, /^成果/])
  await expect(tabs.getByRole('tab', { name: /^任务/ })).toHaveAttribute('aria-selected', 'true')

  const title = `整理华东供应商名单 ${Date.now()}`
  await page.getByTestId('project-task-create').click()
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
  await expect(row).toContainText('承接：周衡')

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
