import ElementPlus from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import ModelGovernanceView from './ModelGovernanceView.vue'
import { adminApi } from '../api/client'
import { useAuthStore } from '../stores/auth'
import type { ModelProvider, ModelRoute } from '../types/domain'

const wrappers: VueWrapper[] = []

afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.restoreAllMocks()
})

const provider: ModelProvider = {
  id: 'provider-1', key: 'deepseek-official', name: 'DeepSeek 官方', providerType: 'openai-completions',
  trustLevel: 'external', baseUrl: 'https://api.deepseek.com', status: 'active', credential: null,
  models: [{ id: 'model-1', providerId: 'provider-1', modelKey: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', capabilities: ['text'], status: 'active' }],
  updatedAt: '2026-10-15T00:00:00.000Z',
}

const route: ModelRoute = {
  id: 'route-default', key: 'default', name: '平台默认模型路由', purpose: 'default',
  providerModelId: 'model-1', providerId: 'provider-1', providerName: 'DeepSeek',
  modelKey: 'deepseek-v4-pro', modelName: 'DeepSeek V4 Pro', priority: 100, enabled: true,
  updatedAt: '2026-10-15T00:00:00.000Z',
}

const standbyRoute: ModelRoute = { ...route, id: 'route-standby', key: 'standby', name: '备用模型路由', enabled: false }

async function render(routes: ModelRoute[] = [route]) {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().$patch({ permissions: ['admin:write'] })
  vi.spyOn(adminApi, 'getModelProviders').mockResolvedValue([provider])
  vi.spyOn(adminApi, 'getModelRoutes').mockResolvedValue(routes)
  const wrapper = mount(ModelGovernanceView, {
    attachTo: document.body,
    global: { plugins: [pinia, ElementPlus], stubs: { teleport: true, ElSelect: { template: '<div><slot /></div>' }, ElOption: true } },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

function buttonByText(wrapper: VueWrapper, text: string) {
  const button = wrapper.findAll('button').find(item => item.text() === text)
  if (!button) throw new Error(`没有找到按钮：${text}`)
  return button
}

describe('ModelGovernanceView', () => {
  it('states that model routes are recorded only and do not choose the executing model', async () => {
    const wrapper = await render()
    const notice = wrapper.find('.record-only-notice')
    expect(notice.exists()).toBe(true)
    expect(notice.text()).toContain('模型路由目前仅记录')
    expect(notice.text()).toContain('DSH Profile')
    expect(notice.text()).toContain('新运行会被拒绝')
    expect(wrapper.text()).toContain('模型路由（仅记录）')
    expect(wrapper.text()).toContain('仅记录到运行快照')
  })

  it('shows the provider protocol and trust level and the current default route', async () => {
    const wrapper = await render()
    expect(wrapper.text()).toContain('OpenAI Chat Completions 兼容')
    expect(wrapper.text()).toContain('外部厂商')
    expect(wrapper.find('.overview-stat__value--text').text()).toBe('平台默认模型路由')
  })

  it('requires an explicit trust level before creating a provider', async () => {
    const wrapper = await render()
    const create = vi.spyOn(adminApi, 'createModelProvider').mockResolvedValue(provider)
    await buttonByText(wrapper, '新建 Provider').trigger('click')
    await flushPromises()
    await buttonByText(wrapper, '创建 Provider').trigger('click')
    await flushPromises()
    expect(create).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('请选择信任级别')
  })

  it('makes a stopped route the default only after confirming the switch', async () => {
    const wrapper = await render([route, standbyRoute])
    await wrapper.findAll('.el-tabs__item')[1]!.trigger('click')
    await flushPromises()
    const { ElMessageBox } = await import('element-plus')
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never)
    const update = vi.spyOn(adminApi, 'updateModelRoute').mockResolvedValue({ ...standbyRoute, enabled: true })
    await buttonByText(wrapper, '设为默认').trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('平台默认模型路由'), '设为默认路由', expect.anything())
    expect(update).toHaveBeenCalledWith({ routeId: 'route-standby', name: '备用模型路由', providerModelId: 'model-1', enabled: true })
  })

  it('sends an entered API key only on create and never shows it back', async () => {
    const wrapper = await render()
    const create = vi.spyOn(adminApi, 'createModelProvider').mockResolvedValue(provider)
    await buttonByText(wrapper, '新建 Provider').trigger('click')
    await flushPromises()
    const dialog = wrapper.findAll('.el-dialog').find(item => item.text().includes('新建 Provider'))!
    const inputs = dialog.findAll('input')
    await inputs.find(item => item.attributes('placeholder') === '例如：DeepSeek 官方')!.setValue('第二家厂商')
    await inputs.find(item => item.attributes('placeholder') === '例如：deepseek-official')!.setValue('vendor-two')
    await inputs.find(item => item.attributes('placeholder') === 'https://api.example.com')!.setValue('https://vendor.example.com')
    await dialog.findAll('input[type="radio"]').find(item => item.attributes('value') === 'external')!.setValue(true)
    await inputs.find(item => item.attributes('type') === 'password')!.setValue('fake-model-key-1234')
    await buttonByText(wrapper, '创建 Provider').trigger('click')
    await flushPromises()
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ key: 'vendor-two', trustLevel: 'external', apiKey: 'fake-model-key-1234' }))
    expect(document.body.innerHTML).not.toContain('fake-model-key-1234')
  })

  it('shows a saved platform key only by its last four characters', async () => {
    const keyed: ModelProvider = { ...provider, credential: { id: 'c1', backend: 'postgres-encrypted', externalRef: 'model-provider:deepseek-official:api-key', status: 'configured', hint: 'wxyz', lastVerifiedAt: null, updatedAt: '2026-11-06T00:00:00.000Z' } }
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().$patch({ permissions: ['admin:write'] })
    vi.spyOn(adminApi, 'getModelProviders').mockResolvedValue([keyed])
    vi.spyOn(adminApi, 'getModelRoutes').mockResolvedValue([route])
    const wrapper = mount(ModelGovernanceView, { attachTo: document.body, global: { plugins: [pinia, ElementPlus], stubs: { teleport: true, ElSelect: { template: '<div><slot /></div>' }, ElOption: true } } })
    wrappers.push(wrapper)
    await flushPromises()
    expect(wrapper.text()).toContain('平台加密保存 · 末尾 wxyz')
    expect(wrapper.text()).not.toContain('model-provider:deepseek-official:api-key')
  })

  it('asks before an edit replaces the current default route', async () => {
    const wrapper = await render([route, standbyRoute])
    await wrapper.findAll('.el-tabs__item')[1]!.trigger('click')
    await flushPromises()
    const { ElMessageBox } = await import('element-plus')
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValue('cancel')
    const update = vi.spyOn(adminApi, 'updateModelRoute').mockResolvedValue(standbyRoute)
    const editButtons = wrapper.findAll('button').filter(item => item.text() === '编辑')
    await editButtons[1]!.trigger('click')
    await flushPromises()
    const dialog = wrapper.findAll('.el-dialog').find(item => item.text().includes('编辑 备用模型路由'))!
    await dialog.find('input[type="checkbox"]').setValue(true)
    await buttonByText(wrapper, '保存').trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('平台默认模型路由'), '设为默认路由', expect.anything())
    expect(update).not.toHaveBeenCalled()
  })

  it('asks before switching a provider with a stored key back to a DSH reference', async () => {
    const keyed: ModelProvider = { ...provider, credential: { id: 'c1', backend: 'postgres-encrypted', externalRef: 'model-provider:deepseek-official:api-key', status: 'configured', hint: 'wxyz', lastVerifiedAt: null, updatedAt: '2026-11-06T00:00:00.000Z' } }
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().$patch({ permissions: ['admin:write'] })
    vi.spyOn(adminApi, 'getModelProviders').mockResolvedValue([keyed])
    vi.spyOn(adminApi, 'getModelRoutes').mockResolvedValue([route])
    const wrapper = mount(ModelGovernanceView, { attachTo: document.body, global: { plugins: [pinia, ElementPlus], stubs: { teleport: true, ElSelect: { template: '<div><slot /></div>' }, ElOption: true } } })
    wrappers.push(wrapper)
    await flushPromises()
    const { ElMessageBox } = await import('element-plus')
    const confirm = vi.spyOn(ElMessageBox, 'confirm').mockRejectedValue('cancel')
    const update = vi.spyOn(adminApi, 'updateCredentialReference').mockResolvedValue(keyed)
    await buttonByText(wrapper, '密钥').trigger('click')
    await flushPromises()
    const dialog = wrapper.findAll('.el-dialog').find(item => item.text().includes('的密钥'))!
    await dialog.findAll('input[type="radio"]').find(item => item.attributes('value') === 'dsh')!.setValue(true)
    await flushPromises()
    await dialog.findAll('input').find(item => item.attributes('placeholder') === '例如：DEEPSEEK_API_KEY')!.setValue('DEEPSEEK_API_KEY')
    await buttonByText(wrapper, '保存').trigger('click')
    await flushPromises()
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('无法恢复'), '改为 DSH 受管引用', expect.anything())
    expect(update).not.toHaveBeenCalled()
  })
})
