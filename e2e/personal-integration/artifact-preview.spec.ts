import { expect, test, type Page } from '@playwright/test'

// EX-ARTIFACT-07 / EX-ARTIFACT-08（P1）：Office/PDF 成果查看解析文本、图片成果预览，对话中在右栏打开。真实 PostgreSQL、HTTP 接口与
// 成果发布流程；合成 Runtime（不调用模型），解析文本来自测试用解析器替身（不启动容器）。

function reply(page: Page, prompt: string) {
  return page.getByRole('article').filter({ has: page.getByText(prompt, { exact: true }) })
    .locator('xpath=following-sibling::article[1]')
}

test('P1: Office artifacts and images preview in the conversation side panel and in 我的文件', async ({ page }) => {
  const prompt = `P1-成果达成 P1-办公成果-${crypto.randomUUID().slice(0, 8)}`
  await page.goto('/workbench')
  await page.getByLabel('对话输入').fill(prompt)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page).toHaveURL(/\/conversations\/run-/)
  const answer = reply(page, prompt)
  await expect(answer.getByText(/成果已登记/)).toBeVisible()

  // 解析失败的 PDF 在卡片下说明原因；点开右栏同样说明。
  await expect(answer.getByRole('button', { name: '下载成果 季度经营报告.pdf' })).toBeVisible()
  await expect(answer.getByText('无法生成正文：PDF 无法读取，请下载查看')).toBeVisible()
  await answer.getByRole('button', { name: '预览成果 季度经营报告.pdf' }).click()
  const pdfPanel = page.getByRole('complementary', { name: '成果预览：季度经营报告.pdf' })
  await expect(pdfPanel.getByText('无法生成正文：PDF 无法读取，请下载查看')).toBeVisible()

  // 表格在右栏按工作表显示为表格，可切换工作表。
  await answer.getByRole('button', { name: '预览成果 华东营收.xlsx' }).click()
  const sheetPanel = page.getByRole('complementary', { name: '成果预览：华东营收.xlsx' })
  await expect(sheetPanel.getByText('V1 · ', { exact: false })).toBeVisible()
  await expect(sheetPanel.getByText('解析文本 · 只含单元格内容', { exact: false })).toBeVisible()
  await expect(sheetPanel.getByRole('cell', { name: '华东', exact: true })).toBeVisible()
  await expect(sheetPanel.getByRole('cell', { name: '=SUM(B2:B3)' })).toBeVisible()
  await sheetPanel.getByRole('button', { name: '明细' }).click()
  await expect(sheetPanel.getByRole('button', { name: '明细' })).toHaveAttribute('aria-pressed', 'true')
  await expect(sheetPanel.getByRole('cell', { name: '7月' })).toBeVisible()
  await expect(answer.getByRole('button', { name: '预览成果 华东营收.xlsx' })).toHaveAttribute('aria-pressed', 'true')
  // 回复内不再就地展开正文。
  await expect(answer.getByRole('cell', { name: '7月' })).toHaveCount(0)

  // 演示稿按页列出文字与备注；文档按原文显示；切换时右栏替换为新成果。
  await answer.getByRole('button', { name: '预览成果 经营概览.pptx' }).click()
  await expect(page.getByRole('complementary', { name: '成果预览：经营概览.pptx' }).getByText('第 1 页')).toBeVisible()
  await expect(page.getByText('备注：P1 合成备注')).toBeVisible()
  await expect(page.getByRole('complementary', { name: '成果预览：华东营收.xlsx' })).toHaveCount(0)
  await answer.getByRole('button', { name: '预览成果 季度经营报告.docx' }).click()
  await expect(page.getByRole('complementary', { name: '成果预览：季度经营报告.docx' }).getByText('华东区收入同比增长 12%。')).toBeVisible()

  // 图片在回复下直接显示缩略图，点击在右栏显示原图，可关闭。
  const thumb = answer.getByRole('button', { name: '预览图片 营收趋势.png' })
  await expect(thumb.getByRole('img', { name: '营收趋势.png' })).toBeVisible()
  expect(await thumb.getByRole('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
  await thumb.click()
  const imagePanel = page.getByRole('complementary', { name: '成果预览：营收趋势.png' })
  await expect(imagePanel.getByRole('img', { name: '营收趋势.png' })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await imagePanel.getByRole('button', { name: '关闭成果预览' }).click()
  await expect(imagePanel).toHaveCount(0)

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

test('P1: the preview gives way to 对话详情 and becomes a drawer on narrow screens', async ({ page }) => {
  const prompt = `P1-成果达成 P1-办公成果-${crypto.randomUUID().slice(0, 8)}`
  await page.goto('/workbench')
  await page.getByLabel('对话输入').fill(prompt)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  const answer = reply(page, prompt)
  await expect(answer.getByText(/成果已登记/)).toBeVisible()

  // 宽屏：右栏与对话并排，输入框仍可用；「对话详情」与预览同在右侧，打开一个就收起另一个。
  await answer.getByRole('button', { name: '预览成果 华东营收.xlsx' }).click()
  const panel = page.getByRole('complementary', { name: '成果预览：华东营收.xlsx' })
  await expect(panel.getByRole('cell', { name: '华东', exact: true })).toBeVisible()
  const panelBox = (await panel.boundingBox())!
  const composerBox = (await page.getByLabel('对话输入').boundingBox())!
  expect(composerBox.x + composerBox.width).toBeLessThanOrEqual(panelBox.x)
  // 全屏查看：盖住整个窗口，按对话框处理；Esc 先退出全屏，右栏仍在。
  await panel.getByRole('button', { name: '全屏查看' }).click()
  const fullscreenPanel = page.getByRole('dialog', { name: '成果预览：华东营收.xlsx' })
  await expect(fullscreenPanel.getByRole('button', { name: '退出全屏' })).toBeVisible()
  const viewport = page.viewportSize()!
  await expect.poll(async () => (await fullscreenPanel.boundingBox())?.width).toBe(viewport.width)
  // 正文最宽 1200px；Tab 不会落到被遮住的对话上。
  expect((await fullscreenPanel.getByRole('table').boundingBox())!.width).toBeLessThanOrEqual(1200)
  for (let step = 0; step < 12; step++) {
    await page.keyboard.press('Tab')
    expect(await fullscreenPanel.evaluate(element => element.contains(document.activeElement))).toBe(true)
  }
  await fullscreenPanel.getByRole('button', { name: '退出全屏' }).focus()
  await page.keyboard.press('Escape')
  await expect(panel.getByRole('button', { name: '全屏查看' })).toBeVisible()
  await expect.poll(async () => (await panel.boundingBox())?.x).toBe(panelBox.x)

  await page.getByRole('button', { name: '对话详情' }).click()
  await expect(page.getByRole('dialog', { name: '对话详情' })).toBeVisible()
  await expect(panel).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: '对话详情' })).toBeHidden()

  // 窄屏：改为覆盖在对话上的抽屉，Esc 收起。
  await page.setViewportSize({ width: 1024, height: 768 })
  await answer.getByRole('button', { name: '预览成果 经营概览.pptx' }).click()
  const drawer = page.getByRole('dialog', { name: '成果预览：经营概览.pptx' })
  await expect(drawer.getByText('第 1 页')).toBeVisible()
  await expect(page.getByRole('complementary', { name: /成果预览/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()

  // 手机宽度：全屏。
  await page.setViewportSize({ width: 390, height: 844 })
  await answer.getByRole('button', { name: '预览成果 季度经营报告.docx' }).click()
  const sheet = page.getByRole('dialog', { name: '成果预览：季度经营报告.docx' })
  await expect(sheet.getByText('华东区收入同比增长 12%。')).toBeVisible()
  expect((await sheet.boundingBox())!.width).toBeGreaterThanOrEqual(389)
  await sheet.getByRole('button', { name: '关闭成果预览' }).click()
  await expect(sheet).toBeHidden()
})
