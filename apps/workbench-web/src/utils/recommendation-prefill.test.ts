import { afterEach, describe, expect, it } from 'vitest'

import { recommendationPrefillState, takeRecommendationPrefill } from './recommendation-prefill'

afterEach(() => window.history.replaceState(null, ''))

describe('recommendation prefill', () => {
  it('is read once from history state and never from the address bar', () => {
    window.history.replaceState({ back: '/tasks/run-1', ...recommendationPrefillState('这份合同的违约金合理吗？') }, '', '/workbench?agent=agent-contract')
    expect(window.location.search).toBe('?agent=agent-contract')
    expect(takeRecommendationPrefill()).toBe('这份合同的违约金合理吗？')
    expect(window.history.state).toEqual({ back: '/tasks/run-1' })
    expect(takeRecommendationPrefill()).toBe('')
  })
})
