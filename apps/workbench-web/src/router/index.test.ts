import { describe, expect, it } from 'vitest'

import router from './index'

describe('workbench authentication routes', () => {
  it('serves login errors outside the backend auth proxy', () => {
    const route = router.resolve('/login-error')

    expect(route.name).toBe('auth-error')
    expect(route.meta.public).toBe(true)
  })

  it('routes employees to the Skill plaza without a duplicate page title', () => {
    const route = router.resolve('/skills')

    expect(route.name).toBe('skills')
    expect(route.meta.section).toBe('员工工作台')
  })

  it('routes employees to the AI colleague catalog', () => {
    const route = router.resolve('/agents')

    expect(route.name).toBe('agents')
    expect(route.meta.title).toBe('AI 同事')
    expect(route.meta.section).toBe('员工工作台')
  })
})
