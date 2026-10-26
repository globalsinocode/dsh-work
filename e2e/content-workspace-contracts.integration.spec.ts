import { expect, test } from '@playwright/test'

type HardeningFixtures = {
  teamId: string
  workspaceFileLogicalId: string | null
  viewerUserId: string
}

async function fixtures(request: import('@playwright/test').APIRequestContext): Promise<HardeningFixtures> {
  const response = await request.get('/api/workbench/v1/test/hardening/fixtures')
  expect(response.ok()).toBeTruthy()
  return (await response.json() as { data: HardeningFixtures }).data
}

test('CW-02 selects a real team file reference from the composer', async ({ page, request }) => {
  const seed = await fixtures(request)
  if (!seed.workspaceFileLogicalId) test.skip(true, '缺少团队文件夹具')
  await page.goto(`/workspaces/${seed.teamId}`)
  await page.getByRole('tab', { name: '讨论' }).click()
  await page.getByRole('button', { name: '引用团队文件' }).click()
  await page.getByRole('button', { name: /月报\.csv/ }).click()
  await page.getByRole('textbox', { name: '任务描述' }).fill('引用团队文件测试')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText('引用团队文件测试')).toBeVisible()
})

test('CW-04 viewer cannot upload via API', async ({ request }) => {
  const seed = await fixtures(request)
  const viewerId = seed.viewerUserId
  if (!viewerId) test.skip(true, '缺少 viewer 夹具')
  const upload = await request.post(`/api/workbench/v1/workspaces/${seed.teamId}/files`, {
    headers: {
      'x-test-user-id': viewerId,
      'Content-Type': 'text/plain',
      'X-File-Name': encodeURIComponent('禁止.csv'),
    },
    data: 'x',
  })
  expect(upload.status()).toBe(403)
})
