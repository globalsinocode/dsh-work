import ElementPlus from 'element-plus'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalAuthPage } from '@dsh-work/ui-core'

const wrappers: VueWrapper[] = []
const fetchMock = vi.fn()
function render(audience: 'admin' | 'workbench', changePassword = false) {
  const wrapper = mount(LocalAuthPage, { props: { audience, changePassword }, global: { plugins: [ElementPlus] } })
  wrappers.push(wrapper)
  return wrapper
}
function button(wrapper: VueWrapper, text: string) {
  return wrapper.findAll('button').find(item => item.text() === text)!
}
beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ mode: 'oidc', localEnabled: true, aiHubEnabled: true }) })
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(window.location, 'assign').mockImplementation(() => {})
  vi.spyOn(window.location, 'replace').mockImplementation(() => {})
  window.history.replaceState({}, '', '/login?return_to=%2Fsettings%3Fview%3Dprofile%23details')
})
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe.each(['admin', 'workbench'] as const)('%s shared login page', audience => {
  it.each([7, 65])('rejects a new password with %i characters before sending a request', async length => {
    const wrapper = render(audience, true)
    await flushPromises()
    await wrapper.get('#local-password').setValue('legacy-test-only-passphrase')
    await wrapper.get('#local-new-password').setValue('x'.repeat(length))
    await wrapper.get('#local-confirm-password').setValue('x'.repeat(length))
    await wrapper.get('form').trigger('submit')
    expect(wrapper.get('[role="alert"]').text()).toContain('8–64')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(window.location.assign).not.toHaveBeenCalled()
  })

  it('continues directly to the original page after changing the initial password', async () => {
    const wrapper = render(audience, true)
    await flushPromises()
    expect(wrapper.text()).toContain('保存后直接进入系统')
    await wrapper.get('#local-password').setValue('initial-test-passphrase')
    await wrapper.get('#local-new-password').setValue('Private12345')
    await wrapper.get('#local-confirm-password').setValue('Private12345')
    const target = `${window.location.origin}/settings?view=profile#details`
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ location: target }) })
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(fetchMock).toHaveBeenLastCalledWith(`/auth/${audience}/password`, expect.objectContaining({
      method: 'POST', credentials: 'same-origin',
      body: JSON.stringify({ currentPassword: 'initial-test-passphrase', newPassword: 'Private12345', returnTo: '/settings?view=profile#details' }),
    }))
    expect(window.location.assign).toHaveBeenCalledExactlyOnceWith(target)
    expect((wrapper.get('#local-password').element as HTMLInputElement).value).toBe('')
    expect((wrapper.get('#local-new-password').element as HTMLInputElement).value).toBe('')
    expect((wrapper.get('#local-confirm-password').element as HTMLInputElement).value).toBe('')
  })

  it('stays on the change-password form when password verification fails', async () => {
    const wrapper = render(audience, true)
    await flushPromises()
    await wrapper.get('#local-password').setValue('incorrect-current-password')
    await wrapper.get('#local-new-password').setValue('Private12345')
    await wrapper.get('#local-confirm-password').setValue('Private12345')
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: { message: '当前密码错误或会话已过期' } }) })
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('当前密码错误')
    expect(window.location.assign).not.toHaveBeenCalled()
    expect(wrapper.get('h1').text()).toBe('修改密码')
    expect(button(wrapper, '保存新密码').attributes()).not.toHaveProperty('disabled')
  })

  it('defaults to the password form with AI Hub enabled, and preserves the return target on login failure', async () => {
    const wrapper = render(audience)
    await flushPromises()
    expect(wrapper.get('h1').text()).toBe(audience === 'admin' ? '登录运营平台' : '登录员工工作台')
    expect(window.location.assign).not.toHaveBeenCalled()
    expect(window.location.replace).not.toHaveBeenCalled()
    await wrapper.get('#local-username').setValue('test.employee')
    await wrapper.get('#local-password').setValue('test-only-password')
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: { message: '账号或密码错误' } }) })
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(fetchMock).toHaveBeenLastCalledWith(`/auth/${audience}/login`, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ username: 'test.employee', password: 'test-only-password', returnTo: '/settings?view=profile#details' }),
    }))
    expect(wrapper.get('[role="alert"]').text()).toContain('账号或密码错误')
    expect((wrapper.get('#local-username').element as HTMLInputElement).value).toBe('test.employee')
    expect((wrapper.get('#local-password').element as HTMLInputElement).value).toBe('')
  })

  it('starts enterprise login with one click, clears the password and blocks duplicate submissions', async () => {
    const wrapper = render(audience)
    await flushPromises()
    await wrapper.get('#local-password').setValue('transient-password')
    await button(wrapper, '使用 AI Hub 账号登录').trigger('click')
    expect(window.location.assign).toHaveBeenCalledWith(`/auth/${audience}/oidc/login?return_to=%2Fsettings%3Fview%3Dprofile%23details`)
    expect(wrapper.find('h2').exists()).toBe(false)
    expect((wrapper.get('#local-password').element as HTMLInputElement).value).toBe('')
    expect(button(wrapper, '正在前往 AI Hub…').attributes()).toHaveProperty('disabled')
    expect(button(wrapper, '登录').attributes()).toHaveProperty('disabled')
    await button(wrapper, '正在前往 AI Hub…').trigger('click')
    await wrapper.get('form').trigger('submit')
    expect(window.location.assign).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('hides the AI Hub entry when the provider is not configured', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ mode: 'local', localEnabled: true, aiHubEnabled: false }) })
    const wrapper = render(audience)
    await flushPromises()
    expect(wrapper.text()).not.toContain('使用 AI Hub 账号登录')
    expect(wrapper.text()).not.toContain('其他登录方式')
    expect(wrapper.find('#local-username').exists()).toBe(true)
    expect(button(wrapper, '登录').attributes()).not.toHaveProperty('disabled')
    expect(window.location.assign).not.toHaveBeenCalled()
  })

  it('recovers from an upstream failure directly on the password form without another redirect', async () => {
    window.history.replaceState({}, '', '/login?provider=ai-hub&auth_error=ai_hub_unavailable&return_to=%2Fsettings')
    const wrapper = render(audience)
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('AI Hub 暂不可用')
    expect(wrapper.find('#local-username').exists()).toBe(true)
    expect(wrapper.find('h2').exists()).toBe(false)
    expect(window.location.assign).not.toHaveBeenCalled()
    await button(wrapper, '使用 AI Hub 账号登录').trigger('click')
    expect(window.location.assign).toHaveBeenCalledWith(`/auth/${audience}/oidc/login?return_to=%2Fsettings`)
  })
})

it('retries a failed configuration load without silently redirecting', async () => {
  fetchMock.mockResolvedValueOnce({ ok: false })
  const wrapper = render('admin')
  await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain('暂时无法加载登录配置')
  expect(wrapper.find('form').exists()).toBe(false)
  await button(wrapper, '重试').trigger('click')
  await flushPromises()
  expect(wrapper.find('#local-username').exists()).toBe(true)
  expect(window.location.assign).not.toHaveBeenCalled()
})

it('keeps first-password changes separate from the AI Hub entry and validates confirmation', async () => {
  const wrapper = render('admin', true)
  await flushPromises()
  expect(wrapper.text()).not.toContain('使用 AI Hub 账号登录')
  await wrapper.get('#local-password').setValue('current-test-password')
  await wrapper.get('#local-new-password').setValue('NewTest12345')
  await wrapper.get('#local-confirm-password').setValue('Different12')
  await wrapper.get('form').trigger('submit')
  expect(wrapper.get('[role="alert"]').text()).toContain('两次输入的新密码不一致')
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(wrapper.get('a').attributes('href')).toBe('/login?return_to=%2Fsettings%3Fview%3Dprofile%23details')
})

it('replaces an external return target before sending it to either provider', async () => {
  window.history.replaceState({}, '', '/login?return_to=https%3A%2F%2Fevil.invalid')
  const wrapper = render('admin')
  await flushPromises()
  await button(wrapper, '使用 AI Hub 账号登录').trigger('click')
  expect(window.location.assign).toHaveBeenCalledWith('/auth/admin/oidc/login?return_to=%2Foverview')
})

it('preserves the explicit switch-account intent for the enterprise login flow', async () => {
  window.history.replaceState({}, '', '/login?switch_account=true&return_to=%2Fidentity')
  const wrapper = render('admin')
  await flushPromises()
  await button(wrapper, '使用 AI Hub 账号登录').trigger('click')
  expect(window.location.assign).toHaveBeenCalledWith('/auth/admin/oidc/switch-account?return_to=%2Fidentity')
})
