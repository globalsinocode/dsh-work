import ElementPlus from 'element-plus'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { adminApi, AdminApiError } from '@/api/client'
import type { DingTalkBindPreview, DingTalkBindingView } from '@/types/domain'
import DingTalkBindingPanel from './DingTalkBindingPanel.vue'

const wrappers: VueWrapper[] = []
const unbound: DingTalkBindingView = { status: 'unbound', binding: null, invalid: null, selfRebindLocked: false }
const bound: DingTalkBindingView = {
  status: 'bound', invalid: null, selfRebindLocked: false,
  binding: { id: 'binding-1', dingtalkName: '赵宁', dingtalkDepartment: '销售部', boundBy: 'admin', boundByAdminName: '陈默', boundAt: '2026-11-05T02:02:00.000Z' },
}
const preview: DingTalkBindPreview = {
  confirmationToken: 'token-1', expiresInSeconds: 300, dingtalkName: '赵宁', dingtalkDepartment: '销售部',
  maskedMobile: '*******2201', platformName: '赵宁', nameMatches: true, requireIdentityConfirmation: false, conflict: null,
}

function mountPanel() {
  const wrapper = mount(DingTalkBindingPanel, {
    props: { userId: 'user-1', userName: '赵宁', canManage: true },
    global: { plugins: [ElementPlus], stubs: { teleport: true } },
  })
  wrappers.push(wrapper)
  return wrapper
}

function button(wrapper: VueWrapper, text: string) {
  const found = wrapper.findAll('button').find(item => item.text() === text)
  if (!found) throw new Error(`没有按钮：${text}`)
  return found
}

async function lookup(wrapper: VueWrapper) {
  await button(wrapper, '代为绑定钉钉').trigger('click')
  await wrapper.get('#dingtalk-bind-mobile').setValue('138 0000 2201')
  await wrapper.get('form').trigger('submit')
  await flushPromises()
}

beforeEach(() => {
  vi.spyOn(adminApi, 'getDingTalkBinding').mockResolvedValue(unbound)
})

afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.restoreAllMocks()
})

describe('DingTalk binding panel (DT-S1 admin binding)', () => {
  it('previews the DingTalk member and confirms with the confirmation token only', async () => {
    const previewSpy = vi.spyOn(adminApi, 'previewDingTalkBinding').mockResolvedValue(preview)
    const confirm = vi.spyOn(adminApi, 'confirmDingTalkBinding').mockResolvedValue(bound)
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.text()).toContain('未绑定')
    await lookup(wrapper)
    expect(previewSpy).toHaveBeenCalledWith('user-1', '138 0000 2201')
    expect(wrapper.text()).toContain('将绑定以下钉钉成员，请确认是本人')
    expect(wrapper.text()).toContain('销售部 · *******2201')
    await button(wrapper, '确认绑定').trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledWith('user-1', { confirmationToken: 'token-1', identityConfirmed: false, rebind: false })
    expect(wrapper.text()).toContain('已绑定')
    expect(wrapper.text()).toContain('管理员陈默代绑')
    expect(wrapper.get('[role="status"]').text()).toContain('已通知赵宁')
    expect(wrapper.emitted('changed')).toHaveLength(1)
  })

  it('requires “我已核实是本人” when the DingTalk name differs', async () => {
    vi.spyOn(adminApi, 'previewDingTalkBinding').mockResolvedValue({ ...preview, dingtalkName: '赵凝', nameMatches: false, requireIdentityConfirmation: true })
    const confirm = vi.spyOn(adminApi, 'confirmDingTalkBinding').mockResolvedValue(bound)
    const wrapper = mountPanel()
    await flushPromises()
    await lookup(wrapper)
    expect(wrapper.text()).toContain('钉钉姓名“赵凝”与员工姓名“赵宁”不一致')
    expect(button(wrapper, '确认绑定').attributes('disabled')).toBeDefined()
    await wrapper.get('input[type="checkbox"]').setValue(true)
    await button(wrapper, '确认绑定').trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledWith('user-1', expect.objectContaining({ identityConfirmed: true }))
  })

  it('offers 改绑 when the DingTalk member already belongs to another employee', async () => {
    vi.spyOn(adminApi, 'previewDingTalkBinding').mockResolvedValue({ ...preview, conflict: { userId: 'user-2', name: '赵宁（旧）' } })
    const confirm = vi.spyOn(adminApi, 'confirmDingTalkBinding').mockResolvedValue(bound)
    const wrapper = mountPanel()
    await flushPromises()
    await lookup(wrapper)
    expect(wrapper.text()).toContain('已绑定平台员工“赵宁（旧）”')
    await button(wrapper, '改绑到 赵宁').trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledWith('user-1', expect.objectContaining({ rebind: true }))
  })

  it('shows a not-found lookup as an inline error and keeps the number for correction', async () => {
    vi.spyOn(adminApi, 'previewDingTalkBinding').mockRejectedValue(new AdminApiError({ code: 'dingtalk_member_not_found', message: '企业钉钉中没有找到这个手机号，请核对号码，或确认该员工已加入企业钉钉' }, 404, ''))
    const wrapper = mountPanel()
    await flushPromises()
    await lookup(wrapper)
    expect(wrapper.get('[role="alert"]').text()).toContain('没有找到这个手机号')
    expect((wrapper.get('#dingtalk-bind-mobile').element as HTMLInputElement).value).toBe('138 0000 2201')
  })

  it('unbinds with an optional self-binding lock', async () => {
    vi.spyOn(adminApi, 'getDingTalkBinding').mockResolvedValue(bound)
    const unbind = vi.spyOn(adminApi, 'unbindDingTalk').mockResolvedValue({ status: 'invalid', binding: null, invalid: { reason: 'admin_unbind', at: '2026-11-05T03:00:00.000Z' }, selfRebindLocked: true })
    const wrapper = mountPanel()
    await flushPromises()
    await button(wrapper, '解除绑定').trigger('click')
    await flushPromises()
    await wrapper.findAll('input[type="checkbox"]').at(-1)!.setValue(true)
    const confirmButton = wrapper.findAll('button').filter(item => item.text() === '解除绑定').at(-1)!
    await confirmButton.trigger('click')
    await flushPromises()
    expect(unbind).toHaveBeenCalledWith('user-1', true)
    expect(wrapper.text()).toContain('管理员已解除绑定')
    expect(wrapper.text()).toContain('已锁定自行绑定')
  })
})
