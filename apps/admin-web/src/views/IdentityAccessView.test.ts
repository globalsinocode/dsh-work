import ElementPlus, { ElMessage } from 'element-plus'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { adminApi, AdminApiError } from '@/api/client'
import IdentityAccessView from './IdentityAccessView.vue'

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ canManageIdentity: true, identityProvider: 'local-password', user: { id: 'test-admin' } }),
}))

const wrappers: VueWrapper[] = []
const duplicateMessage = '登录账号已存在，请使用其他手机号或邮箱'

async function openAccount() {
  const wrapper = mount(IdentityAccessView, {
    global: {
      plugins: [ElementPlus],
      stubs: { teleport: true, ElSelect: { template: '<div><slot /></div>' }, ElOption: true },
    },
  })
  wrappers.push(wrapper)
  await flushPromises()
  await wrapper.findAll('button').find(item => item.text() === '新建账号')!.trigger('click')
  await flushPromises()
  return wrapper.get('[role="dialog"]')
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ localEnabled: true, aiHubEnabled: false }) }))
  vi.spyOn(adminApi, 'getIdentityUsers').mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20, summary: { synchronized: 0, active: 0, authorized: 0 } })
  vi.spyOn(adminApi, 'getIdentityRoles').mockResolvedValue([])
  vi.spyOn(adminApi, 'getLocalPermissions').mockResolvedValue([])
  vi.spyOn(adminApi, 'createLocalAccount').mockResolvedValue({ userId: 'created-user', username: 'created@example.invalid' })
})

afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  ElMessage.closeAll()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('new account validation', () => {
  it('ignores a duplicate response for an account that has already been replaced', async () => {
    let finishOldCheck!: (value: { username: string; available: boolean }) => void
    const check = vi.spyOn(adminApi, 'checkLocalLoginAccount')
      .mockImplementationOnce(() => new Promise(resolve => { finishOldCheck = resolve }))
      .mockResolvedValueOnce({ username: 'new@example.invalid', available: true })
    const dialog = await openAccount()
    const input = dialog.get('#account-username')
    await input.setValue('old@example.invalid')
    await input.trigger('blur')
    await input.setValue('new@example.invalid')
    await input.trigger('blur')
    await flushPromises()
    finishOldCheck({ username: 'old@example.invalid', available: false })
    await flushPromises()
    expect(check).toHaveBeenCalledTimes(2)
    expect(dialog.text()).not.toContain(duplicateMessage)
    expect(dialog.find('[role="status"]').exists()).toBe(false)
    expect(adminApi.createLocalAccount).not.toHaveBeenCalled()
  })

  it('waits for the in-flight blur check before submitting and keeps duplicate errors inside the form', async () => {
    let finishCheck!: (value: { username: string; available: boolean }) => void
    const check = vi.spyOn(adminApi, 'checkLocalLoginAccount').mockImplementation(() => new Promise(resolve => { finishCheck = resolve }))
    const dialog = await openAccount()
    await dialog.get('#account-username').setValue('existing@example.invalid')
    await dialog.get('#account-name').setValue('测试员工')
    await dialog.get('#account-password').setValue('Initial1')
    await dialog.get('#account-username').trigger('blur')
    const save = dialog.findAll('button').find(item => item.text() === '开通账号')!
    await save.trigger('click')
    expect(check).toHaveBeenCalledTimes(1)
    expect(adminApi.createLocalAccount).not.toHaveBeenCalled()
    finishCheck({ username: 'existing@example.invalid', available: false })
    await flushPromises()
    expect(adminApi.createLocalAccount).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(dialog.get('.el-form-item__error').text()).toBe(duplicateMessage))
    expect(save.attributes()).not.toHaveProperty('disabled')
    expect((dialog.get('#account-password').element as HTMLInputElement).value).toBe('Initial1')
  })

  it('shows a conflict discovered during creation and allows correction without losing other fields', async () => {
    vi.spyOn(adminApi, 'checkLocalLoginAccount').mockResolvedValue({ username: 'race@example.invalid', available: true })
    vi.mocked(adminApi.createLocalAccount).mockRejectedValueOnce(new AdminApiError({ code: 'local_account_exists', message: duplicateMessage }, 409, '创建失败'))
    const dialog = await openAccount()
    await dialog.get('#account-username').setValue('race@example.invalid')
    await dialog.get('#account-name').setValue('测试员工')
    await dialog.get('#account-password').setValue('Initial1')
    const save = dialog.findAll('button').find(item => item.text() === '开通账号')!
    await save.trigger('click')
    await flushPromises()
    await vi.waitFor(() => expect(dialog.get('.el-form-item__error').text()).toBe(duplicateMessage))
    expect((dialog.get('#account-name').element as HTMLInputElement).value).toBe('测试员工')
    expect((dialog.get('#account-password').element as HTMLInputElement).value).toBe('Initial1')
    await dialog.get('#account-username').setValue('corrected@example.invalid')
    await save.trigger('click')
    await flushPromises()
    expect(adminApi.createLocalAccount).toHaveBeenLastCalledWith(expect.objectContaining({ username: 'corrected@example.invalid', name: '测试员工', password: 'Initial1' }))
    expect(adminApi.createLocalAccount).toHaveBeenCalledTimes(2)
  })
})
