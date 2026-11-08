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
  it('states that the default route chooses the model of new runs through the model gateway', async () => {
    const wrapper = await render()
    const notice = wrapper.find('.route-effect-notice')
    expect(notice.exists()).toBe(true)
    expect(notice.text()).toContain('默认路由决定新运行使用的模型')
    expect(notice.text()).toContain('平台模型网关')
    expect(notice.text()).toContain('新运行会被拒绝')
    expect(wrapper.text()).not.toContain('仅记录')
    expect(wrapper.text()).not.toContain('DSH Profile')
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

  it('flags a legacy DSH reference as needing an API key and offers only platform-encrypted keys', async () => {
    const legacy: ModelProvider = { ...provider, credential: { id: 'c1', backend: 'dsh-managed', externalRef: 'DEEPSEEK_API_KEY', status: 'configured', hint: null, lastVerifiedAt: null, updatedAt: '2026-11-06T00:00:00.000Z' } }
    const pinia = createPinia()
    setActivePinia(pinia)
    useAuthStore().$patch({ permissions: ['admin:write'] })
    vi.spyOn(adminApi, 'getModelProviders').mockResolvedValue([legacy])
    vi.spyOn(adminApi, 'getModelRoutes').mockResolvedValue([route])
    const wrapper = mount(ModelGovernanceView, { attachTo: document.body, global: { plugins: [pinia, ElementPlus], stubs: { teleport: true, ElSelect: { template: '<div><slot /></div>' }, ElOption: true } } })
    wrappers.push(wrapper)
    await flushPromises()
    expect(wrapper.text()).toContain('需录入 API Key')
    expect(wrapper.text()).toContain('已不生效')
    const stat = wrapper.findAll('.overview-stat').find(item => item.text().includes('凭据已配置'))!
    expect(stat.find('.overview-stat__value').text()).toBe('0')
    const setKey = vi.spyOn(adminApi, 'setModelProviderApiKey').mockResolvedValue(legacy)
    await buttonByText(wrapper, '密钥').trigger('click')
    await flushPromises()
    const dialog = wrapper.findAll('.el-dialog').find(item => item.text().includes('的密钥'))!
    expect(dialog.text()).not.toContain('DSH 受管引用')
    expect(dialog.find('.credential-legacy').text()).toContain('DEEPSEEK_API_KEY')
    await dialog.find('input[type="password"]').setValue('sk-new-key')
    await buttonByText(wrapper, '保存').trigger('click')
    await flushPromises()
    expect(setKey).toHaveBeenCalledWith({ providerId: legacy.id, apiKey: 'sk-new-key' })
  })

  describe('添加模型时的厂商模型下拉', () => {
    const keyed: ModelProvider = { ...provider, credential: { id: 'c1', backend: 'postgres-encrypted', externalRef: 'model-provider:deepseek-official:api-key', status: 'configured', hint: 'wxyz', lastVerifiedAt: null, updatedAt: '2026-11-06T00:00:00.000Z' } }
    const AutocompleteStub = {
      name: 'ElAutocomplete',
      props: ['modelValue', 'fetchSuggestions'],
      emits: ['update:modelValue', 'select'],
      template: '<input class="model-key-input" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
    }

    async function renderWith(providers: ModelProvider[]) {
      const pinia = createPinia()
      setActivePinia(pinia)
      useAuthStore().$patch({ permissions: ['admin:write'] })
      vi.spyOn(adminApi, 'getModelProviders').mockResolvedValue(providers)
      vi.spyOn(adminApi, 'getModelRoutes').mockResolvedValue([route])
      const wrapper = mount(ModelGovernanceView, { attachTo: document.body, global: { plugins: [pinia, ElementPlus], stubs: { teleport: true, ElSelect: { template: '<div><slot /></div>' }, ElOption: true, ElAutocomplete: AutocompleteStub } } })
      wrappers.push(wrapper)
      await flushPromises()
      return wrapper
    }

    function suggestions(wrapper: VueWrapper, query: string) {
      const fetch = wrapper.findComponent(AutocompleteStub).props('fetchSuggestions') as (q: string, cb: (items: Array<{ value: string }>) => void) => void
      let result: string[] = []
      fetch(query, items => { result = items.map(item => item.value) })
      return result
    }

    it('已录入密钥时打开弹窗即拉取厂商模型，建议中排除已添加的模型并按输入过滤', async () => {
      const catalog = vi.spyOn(adminApi, 'listProviderModelCatalog').mockResolvedValue({ modelKeys: ['deepseek-v4-flash', 'deepseek-v4-pro', 'qwen-max'] })
      const wrapper = await renderWith([keyed])
      await buttonByText(wrapper, '添加模型').trigger('click')
      await flushPromises()
      expect(catalog).toHaveBeenCalledWith({ providerId: 'provider-1' })
      expect(wrapper.text()).toContain('已从厂商获取 3 个模型（2 个未添加）')
      expect(suggestions(wrapper, '')).toEqual(['deepseek-v4-flash', 'qwen-max'])
      expect(suggestions(wrapper, 'QWEN')).toEqual(['qwen-max'])
    })

    it('选中建议时自动填写模型名称；手动输入的标识原样提交', async () => {
      vi.spyOn(adminApi, 'listProviderModelCatalog').mockResolvedValue({ modelKeys: ['qwen-max'] })
      const create = vi.spyOn(adminApi, 'createProviderModel').mockResolvedValue(keyed)
      const wrapper = await renderWith([keyed])
      await buttonByText(wrapper, '添加模型').trigger('click')
      await flushPromises()
      const input = wrapper.findComponent(AutocompleteStub)
      input.vm.$emit('update:modelValue', 'qwen-max')
      input.vm.$emit('select', { value: 'qwen-max' })
      await flushPromises()
      // 用户随后改成手动输入的标识（不经过建议列表），失焦也不会丢。
      await wrapper.find('.model-key-input').setValue('  qwen3.8-flash ')
      const footerButtons = wrapper.findAll('button').filter(item => item.text() === '添加模型')
      await footerButtons.at(-1)!.trigger('click')
      await flushPromises()
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'provider-1', modelKey: 'qwen3.8-flash', displayName: 'qwen-max' }))
    })

    it('拉取失败时提示原因，仍可手动填写', async () => {
      vi.spyOn(adminApi, 'listProviderModelCatalog').mockRejectedValue(new Error('厂商未提供模型列表（HTTP 404）'))
      const wrapper = await renderWith([keyed])
      await buttonByText(wrapper, '添加模型').trigger('click')
      await flushPromises()
      expect(wrapper.text()).toContain('未能获取模型列表：厂商未提供模型列表（HTTP 404）')
      expect(suggestions(wrapper, '')).toEqual([])
    })

    it('未录入密钥时不请求厂商，提示手动填写', async () => {
      const catalog = vi.spyOn(adminApi, 'listProviderModelCatalog')
      const wrapper = await renderWith([provider])
      await buttonByText(wrapper, '添加模型').trigger('click')
      await flushPromises()
      expect(catalog).not.toHaveBeenCalled()
      expect(wrapper.text()).toContain('尚未录入 API Key，无法获取模型列表')
    })
  })
})
