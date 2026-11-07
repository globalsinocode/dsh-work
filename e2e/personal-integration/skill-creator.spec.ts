import { expect, test, type Page } from '@playwright/test'

// SKC-01（P1）：员工与 Skill 创建专家对话后，回复下出现 Skill 草稿卡片，由员工自己提交审核或撤回。
// 真实 PostgreSQL 与 HTTP 接口，合成 Runtime（不调用模型）；`P1-创建Skill` 由启动脚本钩子在临时工作区写出
// Skill 目录并经草稿服务保存（真实 DSH 中由模型用 bash 写目录后调用 skill_draft_save）。

const expert = 'agent-p1-skill-creator'
const skillName = '销售周报汇总（P1）'

function reply(page: Page, prompt: string) {
  return page.getByRole('article').filter({ has: page.getByText(prompt, { exact: true }) })
    .locator('xpath=following-sibling::article[1]')
}

function draftCard(scope: ReturnType<typeof reply>) {
  return scope.getByRole('article', { name: `Skill 草稿：${skillName}` })
}

test.afterEach(async ({ page }) => {
  await page.request.put('/api/workbench/v1/me/preferences', { data: { uiMode: 'work' } })
})

test('P1: the dsh-work assistant recommends the Skill creator; “去聊天” opens it with the question prefilled (SKC-01 step 1)', async ({ page }) => {
  const prompt = `我想把常用的周报做法做成 Skill P1-推荐同事-Skill创建-${crypto.randomUUID().slice(0, 8)}`
  await page.goto('/workbench')
  await page.getByLabel('对话输入').fill(prompt)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page).toHaveURL(/\/conversations\/run-/)
  const recommendation = reply(page, prompt).getByRole('article', { name: '推荐的 AI 同事：Skill 创建专家（P1）' })
  await expect(recommendation).toContainText('推荐理由：专门帮员工把反复做的工作写成 Skill 草稿')

  await recommendation.getByRole('button', { name: '去和Skill 创建专家（P1）聊天' }).click()
  await expect(page).toHaveURL(new RegExp(`/workbench\\?agent=${expert}$`))
  await expect(page.getByLabel('已选择 AI 同事', { exact: true })).toContainText('Skill 创建专家（P1）')
  await expect(page.getByLabel('对话输入')).toHaveValue('我想把每周的销售周报做成一个 Skill')
  await expect(page.getByTestId('recommendation-prefill-notice')).toContainText('确认后再发送')
})

test('P1: A mode shows the draft card; the employee previews, submits and withdraws it, and the state survives a reload', async ({ page }) => {
  const prompt = `帮我做一个销售周报 Skill P1-创建Skill-${crypto.randomUUID().slice(0, 8)}`
  await page.goto(`/workbench?agent=${expert}`)
  // 选中专家后输入框会带入它的示例问题；等带入完成再输入，避免被覆盖。
  await expect(page.getByLabel('对话输入')).toHaveValue('帮我做一个周报 Skill')
  await page.getByLabel('对话输入').fill(prompt)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page).toHaveURL(/\/conversations\/run-/)

  const card = draftCard(reply(page, prompt))
  await expect(card).toBeVisible()
  await expect(card).toContainText('scripts/weekly_report.py')
  await expect(card).toContainText('脚本')
  await expect(card).toContainText('包校验：通过')
  await expect(card).not.toContainText('试跑')

  await card.getByRole('button', { name: '预览 SKILL.md' }).click()
  await expect(card.getByTestId('skill-draft-preview')).toContainText(`name: ${skillName}`)

  await card.getByRole('button', { name: '提交审核' }).click()
  await expect(card.getByRole('status')).toContainText('已提交审核')
  await page.reload()
  const reloaded = draftCard(reply(page, prompt))
  await expect(reloaded).toContainText('待审核')
  await reloaded.getByRole('button', { name: '撤回提交' }).click()
  await expect(reloaded.getByRole('button', { name: '提交审核' })).toBeVisible()
  await page.reload()
  await expect(draftCard(reply(page, prompt)).getByRole('button', { name: '提交审核' })).toBeVisible()
})

test('P1: collab mode single chat shows the same draft card under the expert’s reply', async ({ page }) => {
  await page.request.put('/api/workbench/v1/me/preferences', { data: { uiMode: 'collab' } })
  const prompt = `协作模式下做一个周报 Skill P1-创建Skill-${crypto.randomUUID().slice(0, 8)}`
  await page.goto(`/c/chats/agent/${expert}`)
  await expect(page.getByRole('heading', { name: 'Skill 创建专家（P1）', level: 1 })).toBeVisible()
  await page.getByLabel('对话输入').fill(prompt)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  const card = draftCard(reply(page, prompt))
  await expect(card).toBeVisible()
  await expect(card.getByRole('button', { name: '提交审核' })).toBeVisible()
})
