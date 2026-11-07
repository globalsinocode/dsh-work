import ElementPlus, { ElMessageBox } from 'element-plus'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { adminApi, AdminApiError } from '@/api/client'
import type { DingTalkSettings } from '@/types/domain'
import DingTalkSettingsDialog from './DingTalkSettingsDialog.vue'

const configured: DingTalkSettings = {
  configured: true, source: 'admin', corpId: 'ding-corp', agentId: '3189', appKey: 'app-key', secretHint: '0001',
  secretReadable: true, secretProblem: null, sessionTtlSeconds: 43200, bindingTicketTtlSeconds: 300, adminDailyBindLimit: 50, timeoutMs: 10000,
  canStoreSecret: true, updatedAt: '2026-11-06T01:00:00.000Z', updatedByName: '陈默',
}

function mountDialog(settings: DingTalkSettings) {
  return mount(DingTalkSettingsDialog, { props: { settings, modelValue: true }, global: { plugins: [ElementPlus], stubs: { teleport: true } } })
}

afterEach(() => vi.restoreAllMocks())

describe('钉钉应用配置对话框', () => {
  it('keeps the saved AppSecret when left blank and converts units', async () => {
    const save = vi.spyOn(adminApi, 'saveDingTalkSettings').mockResolvedValue(configured)
    const wrapper = mountDialog(configured)
    await flushPromises()
    expect((wrapper.get('#dingtalk-app-secret').element as HTMLInputElement).placeholder).toBe('已保存（尾号 0001），留空不修改')
    await wrapper.findAll('button').find(button => button.text() === '验证并保存')!.trigger('click')
    await flushPromises()
    expect(save).toHaveBeenCalledWith({
      corpId: 'ding-corp', agentId: '3189', appKey: 'app-key',
      sessionTtlSeconds: 43200, bindingTicketTtlSeconds: 300, adminDailyBindLimit: 50, timeoutMs: 10000,
    })
    expect(wrapper.emitted('saved')).toHaveLength(1)
  })

  it('sends a new AppSecret and shows a rejected-credentials error without closing', async () => {
    const save = vi.spyOn(adminApi, 'saveDingTalkSettings').mockRejectedValue(new AdminApiError({ code: 'dingtalk_credentials_rejected', message: '钉钉拒绝了这组凭据' }, 422, ''))
    const wrapper = mountDialog({ ...configured, configured: false, corpId: null, agentId: null, appKey: null, secretHint: null })
    await flushPromises()
    await wrapper.get('#dingtalk-corp-id').setValue('ding-corp')
    await wrapper.get('#dingtalk-agent-id').setValue('3189')
    await wrapper.get('#dingtalk-app-key').setValue('app-key')
    await wrapper.get('#dingtalk-app-secret').setValue('new-secret-1234')
    await wrapper.findAll('button').find(button => button.text() === '验证并保存')!.trigger('click')
    await flushPromises()
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ appSecret: 'new-secret-1234' }))
    expect(wrapper.get('[role="alert"]').text()).toContain('钉钉拒绝了这组凭据')
    expect(wrapper.emitted('saved')).toBeUndefined()
  })

  it('explains when the server cannot store secrets', async () => {
    const wrapper = mountDialog({ ...configured, canStoreSecret: false })
    await flushPromises()
    expect(wrapper.text()).toContain('服务未配置凭据主密钥 DSH_CREDENTIAL_MASTER_KEY')
    expect((wrapper.get('#dingtalk-app-secret').element as HTMLInputElement).disabled).toBe(true)
  })

  it('keeps exact seconds for fields that were not changed', async () => {
    const save = vi.spyOn(adminApi, 'saveDingTalkSettings').mockResolvedValue(configured)
    const wrapper = mountDialog({ ...configured, sessionTtlSeconds: 1800, bindingTicketTtlSeconds: 90 })
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === '验证并保存')!.trigger('click')
    await flushPromises()
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ sessionTtlSeconds: 1800, bindingTicketTtlSeconds: 90 }))
  })

  it('asks before switching to another DingTalk corp and does not save when cancelled', async () => {
    const save = vi.spyOn(adminApi, 'saveDingTalkSettings').mockResolvedValue(configured)
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValueOnce('cancel').mockResolvedValueOnce('confirm' as never)
    const wrapper = mountDialog(configured)
    await flushPromises()
    await wrapper.get('#dingtalk-corp-id').setValue('ding-corp-other')
    await wrapper.get('#dingtalk-app-secret').setValue('other-secret-1234')
    const button = wrapper.findAll('button').find(item => item.text() === '验证并保存')!
    await button.trigger('click')
    await flushPromises()
    expect(confirm.mock.calls[0]![0]).toContain('所有员工的钉钉绑定都会失效')
    expect(save).not.toHaveBeenCalled()
    await button.trigger('click')
    await flushPromises()
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ corpId: 'ding-corp-other' }))
  })
})
