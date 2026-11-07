import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import type { DingTalkSelfBinding } from '@/types/domain'
import DingTalkSettingsSection from './DingTalkSettingsSection.vue'

const bound: DingTalkSelfBinding = {
  enabled: true, status: 'bound', invalid: null, selfRebindLocked: false,
  binding: { id: 'b1', dingtalkName: '赵宁', dingtalkDepartment: '销售部', boundBy: 'self', boundByAdminName: null, boundAt: '2026-11-05T02:02:00.000Z' },
}

function mountSection() {
  setActivePinia(createPinia())
  return mount(DingTalkSettingsSection, { global: { plugins: [ElementPlus], stubs: { teleport: true } } })
}

afterEach(() => vi.restoreAllMocks())

describe('用户中心 › 钉钉 (DT-S1 prototype ④)', () => {
  it('shows a self binding and unbinds after confirmation', async () => {
    vi.spyOn(workbenchApi, 'getDingTalkBinding').mockResolvedValue(bound)
    const unbind = vi.spyOn(workbenchApi, 'unbindDingTalk').mockResolvedValue({ ...bound, status: 'invalid', binding: null, invalid: { reason: 'self_unbind', at: '2026-11-05T03:00:00.000Z' } })
    const wrapper = mountSection()
    await flushPromises()
    expect(wrapper.text()).toContain('已绑定')
    expect(wrapper.text()).toContain('赵宁（销售部）')
    expect(wrapper.text()).toContain('本人在钉钉内登录时绑定')
    expect(wrapper.text()).not.toContain('请立即解除绑定')
    await wrapper.findAll('button').find(item => item.text() === '解除绑定')!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('钉钉内的登录会立即失效')
    await wrapper.findAll('button').filter(item => item.text() === '解除绑定').at(-1)!.trigger('click')
    await flushPromises()
    expect(unbind).toHaveBeenCalledOnce()
    expect(wrapper.text()).toContain('已失效')
    expect(wrapper.text()).toContain('如何绑定')
    expect(wrapper.get('[role="status"]').text()).toBe('已解除绑定。')
  })

  it('warns about an admin binding', async () => {
    vi.spyOn(workbenchApi, 'getDingTalkBinding').mockResolvedValue({ ...bound, binding: { ...bound.binding!, boundBy: 'admin', boundByAdminName: '陈默' } })
    const wrapper = mountSection()
    await flushPromises()
    expect(wrapper.text()).toContain('管理员陈默代为绑定')
    expect(wrapper.text()).toContain('如果不是你本人的钉钉账号，请立即解除绑定并联系管理员')
  })

  it('explains a self-binding lock and hides the how-to', async () => {
    vi.spyOn(workbenchApi, 'getDingTalkBinding').mockResolvedValue({ enabled: true, status: 'invalid', binding: null, invalid: { reason: 'admin_unbind', at: '2026-11-05T03:00:00.000Z' }, selfRebindLocked: true })
    const wrapper = mountSection()
    await flushPromises()
    expect(wrapper.text()).toContain('已失效')
    expect(wrapper.text()).toContain('管理员已暂停你的钉钉自行绑定')
    expect(wrapper.text()).not.toContain('如何绑定')
  })

  it('stays hidden when DingTalk is not configured and nothing is bound', async () => {
    vi.spyOn(workbenchApi, 'getDingTalkBinding').mockResolvedValue({ enabled: false, status: 'unbound', binding: null, invalid: null, selfRebindLocked: false })
    const wrapper = mountSection()
    await flushPromises()
    expect(wrapper.find('section').exists()).toBe(false)
  })
})
