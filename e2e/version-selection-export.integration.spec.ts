import { expect, test } from '@playwright/test'

test('VE-05 exports a single Run transcript from the server', async ({ page }) => {
  await page.goto('/workbench')
  await page.getByLabel('对话输入').fill(`P1-导出单 Run-${Date.now()}`)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByText(/受控测试运行已完成/).first()).toBeVisible()
  await page.getByRole('button', { name: '更多', exact: true }).first().click()
  await page.getByRole('menuitem', { name: '导出本次 Run' }).click()
  const download = await page.waitForEvent('download')
  const path = await download.path()
  expect(path).toBeTruthy()
  const text = await download.createReadStream().then(async stream => {
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks).toString('utf8')
  })
  expect(text).toMatch(/"scope"\s*:\s*"run"/)
  expect(download.suggestedFilename()).toMatch(/Run|run/)
})
