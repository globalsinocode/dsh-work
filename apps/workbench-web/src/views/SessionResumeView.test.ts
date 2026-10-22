import { describe, expect, it, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'

import SessionResumeView from './SessionResumeView.vue'

const getConversationSession = vi.fn()
const replace = vi.fn()

vi.mock('@/api/client', () => ({
  workbenchApi: { getConversationSession },
}))

vi.mock('@/stores/tasks', () => ({
  useTaskStore: () => ({
    continueSession: vi.fn(),
  }),
}))

describe('SessionResumeView', () => {
  beforeEach(() => {
    getConversationSession.mockReset()
    replace.mockReset()
  })

  it('redirects to latest Run when session already has one', async () => {
    getConversationSession.mockResolvedValue({
      id: 'session-1',
      title: '续写',
      canContinue: true,
      latestRun: { id: 'run-9' },
    })
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/sessions/:id/resume', component: SessionResumeView }],
    })
    router.replace = replace
    await router.push('/sessions/session-1/resume')
    mount(SessionResumeView, {
      global: { plugins: [router] },
    })
    await flushPromises()
    expect(replace).toHaveBeenCalledWith('/conversations/run-9')
  })
})
