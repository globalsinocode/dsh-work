import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'

type HardeningFixtures = {
  synthetic: boolean
  teamId: string
  discussionSessionId: string
  discussionTitle: string
  agentMemberId: string | null
  ownerUserId: string
}

async function fixtures(request: import('@playwright/test').APIRequestContext): Promise<HardeningFixtures> {
  const response = await request.get('/api/workbench/v1/test/hardening/fixtures')
  expect(response.ok(), await response.text()).toBeTruthy()
  const body = await response.json() as { data: HardeningFixtures }
  expect(body.data.synthetic).toBe(true)
  return body.data
}

test('CR-01 discussion idempotency returns one message for the same key', async ({ request }) => {
  const seed = await fixtures(request)
  const key = `cr01-${randomUUID()}`
  const body = { content: '幂等讨论', idempotencyKey: key }
  const first = await request.post(`/api/workbench/v1/sessions/${seed.discussionSessionId}/messages`, {
    headers: { 'x-test-user-id': seed.ownerUserId },
    data: body,
  })
  const second = await request.post(`/api/workbench/v1/sessions/${seed.discussionSessionId}/messages`, {
    headers: { 'x-test-user-id': seed.ownerUserId },
    data: body,
  })
  expect(first.ok()).toBeTruthy()
  expect(second.ok()).toBeTruthy()
  const a = (await first.json() as { data: { id: string } }).data
  const b = (await second.json() as { data: { id: string } }).data
  expect(b.id).toBe(a.id)
})

test('CR-04 team discussion continues on workspace thread', async ({ page, request }) => {
  const seed = await fixtures(request)
  await page.goto(`/workspaces/${seed.teamId}`)
  await page.getByRole('tab', { name: '讨论' }).click()
  await page.getByRole('textbox', { name: '任务描述' }).fill('下一轮排期')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText('下一轮排期')).toBeVisible()
  if (!seed.agentMemberId) test.skip(true, '缺少团队 Agent 成员夹具')
  await page.getByRole('button', { name: /选择 Agent/ }).click()
  await page.getByRole('option', { name: /发布助手/ }).click()
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText(/运行中|已完成|受控测试运行已完成/).first()).toBeVisible()
})
