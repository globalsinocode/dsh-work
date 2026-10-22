import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'

type HardeningFixtures = {
  ownerUserId: string
  memberUserId: string
  discussionSessionId: string
}

async function fixtures(request: import('@playwright/test').APIRequestContext): Promise<HardeningFixtures> {
  const response = await request.get('/api/workbench/v1/test/hardening/fixtures')
  expect(response.ok()).toBeTruthy()
  return (await response.json() as { data: HardeningFixtures }).data
}

test('NT-01 discussion notifies other participant without echoing actor', async ({ request }) => {
  const seed = await fixtures(request)
  const posted = await request.post(`/api/workbench/v1/sessions/${seed.discussionSessionId}/messages`, {
    headers: { 'x-test-user-id': seed.ownerUserId },
    data: { content: '通知参与者测试', idempotencyKey: randomUUID() },
  })
  expect(posted.ok()).toBeTruthy()
  const memberInbox = await request.get('/api/workbench/v1/notifications?unread=true&limit=20', {
    headers: { 'x-test-user-id': seed.memberUserId },
  })
  expect(memberInbox.ok()).toBeTruthy()
  const memberBody = await memberInbox.json() as { data: { items: unknown[] } }
  expect(memberBody.data.items.length).toBeGreaterThan(0)
  const ownerInbox = await request.get('/api/workbench/v1/notifications?unread=true&limit=20', {
    headers: { 'x-test-user-id': seed.ownerUserId },
  })
  const ownerBody = await ownerInbox.json() as { data: { items: Array<{ kind?: string }> } }
  const selfEcho = ownerBody.data.items.filter(item => item.kind === 'discussion_posted')
  expect(selfEcho.length).toBe(0)
})
