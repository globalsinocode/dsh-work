import { expect, test, type Page } from '@playwright/test'

// EX-ATTACH-01（P1）：对话中上传的本地文件显示在发送它的那条消息下，多轮对话与刷新后仍在；
// 附了文件的消息只以本轮文件作为输入；不附文件的追问沿用上一轮的附件（功能规则“附件跨轮延续”）。
// 真实 PostgreSQL 与 HTTP 接口，合成 Runtime（不调用模型）；不拦截页面请求。

function ownMessage(page: Page, prompt: string) {
  return page.getByRole('article').filter({ has: page.getByText(prompt, { exact: true }) })
}

async function attach(page: Page, name: string, content: string) {
  const chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '添加内容' }).click()
  await page.getByRole('menuitem', { name: '上传本地文件' }).click()
  await (await chooser).setFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(content) })
  await expect(page.getByLabel('已选择文件').getByText(name)).toBeVisible()
}

async function send(page: Page, prompt: string) {
  await page.getByLabel('对话输入').fill(prompt)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
}

test('P1: uploaded files stay listed under the message that sent them', async ({ page }) => {
  const tag = crypto.randomUUID().slice(0, 8)
  const first = `P1-附件-第一轮-${tag}`
  const second = `P1-附件-第二轮-${tag}`
  const firstFile = `库存清单-${tag}.csv`
  const secondFile = `订单明细-${tag}.csv`

  await page.goto('/workbench')
  await attach(page, firstFile, '物料,库存\nA-01,120\n')
  await send(page, first)
  await expect(page).toHaveURL(/\/conversations\/run-/)
  await expect(ownMessage(page, first).getByLabel('附带文件').getByText(firstFile)).toBeVisible()
  await expect(page.getByText(/受控测试运行已完成/).first()).toBeVisible()

  await attach(page, secondFile, '订单,物料\nSO-1,A-01\n')
  await send(page, second)
  await expect(ownMessage(page, second).getByLabel('附带文件').getByText(secondFile)).toBeVisible()

  // 附了新文件的一轮只以本轮文件作为输入，不混入上一轮的文件。
  const reply = page.getByText('受控测试运行已完成（非真实模型回答）；输入文件 1 个。')
  await expect(reply).toHaveCount(2)

  // 不附文件的追问沿用上一轮的附件；这条消息下不列文件。
  const third = `P1-附件-第三轮-${tag}`
  await send(page, third)
  await expect(reply).toHaveCount(3)
  await expect(ownMessage(page, third).getByLabel('附带文件')).toHaveCount(0)

  await page.reload()
  await expect(ownMessage(page, first).getByLabel('附带文件').getByRole('listitem')).toHaveText([firstFile])
  await expect(ownMessage(page, second).getByLabel('附带文件').getByRole('listitem')).toHaveText([secondFile])
  await expect(ownMessage(page, third).getByLabel('附带文件')).toHaveCount(0)
})
