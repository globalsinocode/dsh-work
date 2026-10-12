import ElementPlus from 'element-plus'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import LoginModeSettings from './LoginModeSettings.vue'

const api = vi.hoisted(() => ({ getLoginSettings: vi.fn(), saveLoginSettings: vi.fn() }))
vi.mock('@/api/client', () => ({ adminApi: api }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ canManageIdentity: true }) }))
const wrappers: VueWrapper[] = []
function render() {
  const wrapper = mount(LoginModeSettings, { global: { plugins: [ElementPlus] } })
  wrappers.push(wrapper)
  return wrapper
}
beforeEach(() => {
  vi.resetAllMocks()
  api.getLoginSettings.mockResolvedValue({
    activeMode: 'local', savedMode: null, pendingRestart: false, revision: 0, updatedAt: null,
    options: [
      { mode: 'local', available: true, issues: [] },
      { mode: 'oidc', available: false, issues: ['AI_HUB_CLIENT_SECRET is required'] },
    ],
  })
})
afterEach(() => wrappers.splice(0).forEach(wrapper => wrapper.unmount()))

describe('LoginModeSettings prerequisite feedback', () => {
  it('disables an unavailable login mode and displays the missing prerequisite', async () => {
    const wrapper = render()
    await flushPromises()
    expect(wrapper.text()).toContain('AI_HUB_CLIENT_SECRET is required')
    const unavailable = wrapper.findAll('input[type="radio"]').find(input => input.attributes('value') === 'oidc')!
    expect(unavailable.attributes()).toHaveProperty('disabled')
    expect(api.saveLoginSettings).not.toHaveBeenCalled()
  })

  it('retains an accessible refresh action after an initial loading failure', async () => {
    api.getLoginSettings.mockRejectedValueOnce(new Error('服务暂时不可用'))
    const wrapper = render()
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('服务暂时不可用')
    expect(wrapper.find('input[type="radio"]').exists()).toBe(false)
    await wrapper.findAll('button').find(button => button.text() === '刷新设置')!.trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('使用部署默认值')
    expect(api.getLoginSettings).toHaveBeenCalledTimes(2)
  })
})
