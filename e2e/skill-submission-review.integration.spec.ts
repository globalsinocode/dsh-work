import { expect, test, type APIResponse } from '@playwright/test'

/**
 * SKC-02（P1）：管理员审核员工 Skill 提交。一次性 PostgreSQL、真实审核与发布门禁、合成严格试运行证据；
 * 提交人看到的结论按存储状态核对（员工草稿卡片的展示由组件与集成测试覆盖）。
 */
async function data<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBeTruthy()
  return (await response.json()).data as T
}

interface Fixture {
  suffix: string
  weekly: { submissionId: string; versionId: string }
  minutes: { submissionId: string; versionId: string }
}

test('SKC-02: 管理员查看提交与试运行证据，选择可见范围通过发布，或填写原因拒绝', async ({ page }) => {
  const fixture = await data<Fixture>(await page.request.post('/api/admin/v1/test/skill-submissions/fixture'))
  const weeklyName = `周报汇总-${fixture.suffix}`
  const minutesName = `会议纪要-${fixture.suffix}`

  // 1. 待审核列表：提交人、来源、是否含脚本、试运行状态。
  await page.goto('/skills/review')
  const tabs = page.getByRole('tablist', { name: 'Skill 管理' })
  await expect(tabs.getByRole('tab', { name: /待审核/ })).toHaveAttribute('aria-selected', 'true')
  const weeklyRow = page.getByRole('row', { name: new RegExp(weeklyName) })
  await expect(weeklyRow).toContainText('对话创建')
  await expect(weeklyRow).toContainText('含 1 个脚本')
  await expect(weeklyRow).toContainText('未试运行')
  await expect(page.getByRole('row', { name: new RegExp(minutesName) })).toContainText('纯指令')

  // 2. 含脚本的提交：分别查看 SKILL.md 与脚本源码；试运行通过前不能发布。
  await page.getByRole('button', { name: `审核 ${weeklyName}` }).click()
  const drawer = page.getByRole('dialog', { name: `审核：${weeklyName}` })
  await expect(drawer.getByLabel('SKILL.md 内容')).toContainText(`name: ${weeklyName}`)
  await drawer.getByRole('tab', { name: '脚本：scripts/report.py' }).click()
  await expect(drawer.getByLabel('scripts/report.py 内容')).toContainText('import openpyxl')
  await expect(drawer.getByRole('button', { name: '通过并发布' })).toBeDisabled()
  await expect(drawer).toContainText('先完成一次严格试运行')

  await drawer.getByRole('button', { name: '开始试运行' }).click()
  await expect(drawer.getByText('已通过')).toBeVisible()
  await expect(drawer.getByRole('button', { name: '通过并发布' })).toBeEnabled()

  // 3. 通过：指定角色但未勾选时不能确认；勾选后发布，进入 Skill 列表且可见范围生效。
  await drawer.getByRole('button', { name: '通过并发布' }).click()
  const approve = page.getByRole('dialog', { name: '通过并发布' })
  await approve.locator('.el-radio').filter({ hasText: '指定角色' }).click()
  await expect(approve.getByRole('button', { name: '确认发布' })).toBeDisabled()
  await approve.locator('.el-checkbox').first().click()
  await approve.getByRole('button', { name: '确认发布' }).click()
  await expect(page.getByText(`“${weeklyName}”已发布`)).toBeVisible()
  await expect(page.getByRole('row', { name: new RegExp(weeklyName) })).toHaveCount(0)
  await expect.poll(async () => (await data<{ status: string }>(await page.request.get(
    `/api/admin/v1/test/skill-submissions/${fixture.weekly.submissionId}/outcome`))).status).toBe('approved')
  const published = (await data<Array<{ name: string; status: string; visibleRoleIds: string[] | null }>>(
    await page.request.get('/api/admin/v1/skills'))).find(skill => skill.name === weeklyName)
  expect(published?.status).toBe('published')
  expect(published?.visibleRoleIds?.length).toBe(1)

  // 4. 试运行未完成的提交不能发布；拒绝必须填写原因。
  await page.getByRole('button', { name: `审核 ${minutesName}` }).click()
  const minutesDrawer = page.getByRole('dialog', { name: `审核：${minutesName}` })
  await minutesDrawer.getByRole('button', { name: '开始试运行' }).click()
  await expect(minutesDrawer.getByText('试运行中')).toBeVisible()
  await expect(minutesDrawer.getByRole('button', { name: '通过并发布' })).toBeDisabled()
  await expect(minutesDrawer).toContainText('严格试运行进行中')
  await minutesDrawer.getByRole('button', { name: '拒绝', exact: true }).click()
  const reject = page.getByRole('dialog', { name: '拒绝提交' })
  await expect(reject.getByRole('button', { name: '确认拒绝' })).toBeDisabled()
  await reject.getByLabel('拒绝原因').fill('请补充待办的截止日期格式。')
  await reject.getByRole('button', { name: '确认拒绝' }).click()
  await expect(page.getByText('已拒绝，提交人会在草稿卡片上看到原因')).toBeVisible()
  const outcome = await data<{ status: string; reviewNote: string }>(await page.request.get(
    `/api/admin/v1/test/skill-submissions/${fixture.minutes.submissionId}/outcome`))
  expect(outcome).toEqual({ status: 'rejected', reviewNote: '请补充待办的截止日期格式。' })
})
