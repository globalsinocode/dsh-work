import { expect, test, type Page } from '@playwright/test'

// EX-ARTIFACT-07（P1）：Office/PDF 成果查看解析文本、图片成果直接预览。真实 PostgreSQL、HTTP 接口与
// 成果发布流程；合成 Runtime（不调用模型），解析文本来自测试用解析器替身（不启动容器）。

function reply(page: Page, prompt: string) {
  return page.getByRole('article').filter({ has: page.getByText(prompt, { exact: true }) })
    .locator('xpath=following-sibling::article[1]')
}

test('P1: Office artifacts show their extracted text and images preview in the conversation and in 我的文件', async ({ page }) => {
  const prompt = `P1-成果达成 P1-办公成果-${crypto.randomUUID().slice(0, 8)}`
  await page.goto('/workbench')
  await page.getByLabel('对话输入').fill(prompt)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page).toHaveURL(/\/conversations\/run-/)
  const answer = reply(page, prompt)
  await expect(answer.getByText(/成果已登记/)).toBeVisible()

  // 解析失败的 PDF 不提供“查看正文”，原处说明原因。
  await expect(answer.getByRole('button', { name: '下载成果 季度经营报告.pdf' })).toBeVisible()
  await expect(answer.getByText('无法生成正文：PDF 无法读取，请下载查看')).toBeVisible()
  await expect(answer.getByRole('button', { name: '展开 季度经营报告.pdf 正文' })).toHaveCount(0)

  // 表格按工作表显示为表格，可切换工作表，可收起。
  await answer.getByRole('button', { name: '展开 华东营收.xlsx 正文' }).click()
  await expect(answer.getByText('解析文本 · 只含单元格内容', { exact: false })).toBeVisible()
  await expect(answer.getByRole('cell', { name: '华东', exact: true })).toBeVisible()
  await expect(answer.getByRole('cell', { name: '=SUM(B2:B3)' })).toBeVisible()
  await answer.getByRole('button', { name: '明细' }).click()
  await expect(answer.getByRole('button', { name: '明细' })).toHaveAttribute('aria-pressed', 'true')
  await expect(answer.getByRole('cell', { name: '7月' })).toBeVisible()
  await answer.getByRole('button', { name: '收起 华东营收.xlsx 正文' }).click()
  await expect(answer.getByRole('cell', { name: '7月' })).toHaveCount(0)

  // 演示稿按页列出文字与备注；文档按原文显示。
  await answer.getByRole('button', { name: '展开 经营概览.pptx 正文' }).click()
  await expect(answer.getByText('第 1 页')).toBeVisible()
  await expect(answer.getByText('备注：P1 合成备注')).toBeVisible()
  await answer.getByRole('button', { name: '展开 季度经营报告.docx 正文' }).click()
  await expect(answer.getByText('华东区收入同比增长 12%。')).toBeVisible()

  // 图片在回复下直接显示缩略图，点击放大，可关闭。
  const thumb = answer.getByRole('button', { name: '放大查看 营收趋势.png' })
  await expect(thumb.getByRole('img', { name: '营收趋势.png' })).toBeVisible()
  expect(await thumb.getByRole('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
  await thumb.click()
  const dialog = page.getByRole('dialog', { name: /成果预览/ })
  await expect(dialog.getByRole('img', { name: '营收趋势.png' })).toBeVisible()
  await dialog.getByRole('button', { name: '关闭成果预览' }).click()
  await expect(dialog).toBeHidden()

  // 我的文件：解析成功的表格与图片提供“预览”，解析失败的 PDF 不提供。
  await page.goto('/files?source=artifact')
  await expect(page.getByRole('button', { name: '预览 季度经营报告.pdf' })).toHaveCount(0)
  await page.getByRole('button', { name: '预览 华东营收.xlsx' }).first().click()
  const filesDialog = page.getByRole('dialog', { name: /成果预览/ })
  await expect(filesDialog.getByText('工作表：营收')).toBeVisible()
  await expect(filesDialog.getByText('工作表：明细')).toBeVisible()
  await expect(filesDialog.getByRole('cell', { name: '7月' })).toBeVisible()
  await filesDialog.getByRole('button', { name: '关闭成果预览' }).click()
  await expect(filesDialog).toBeHidden()
})
