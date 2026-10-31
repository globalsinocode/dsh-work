import ElementPlus from 'element-plus'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkbenchApiError, workbenchApi } from '@/api/client'
import type { WeknoraIntegrationStatus } from '@/types/domain'
import KnowledgeBasesView from '@/views/knowledge-bases/index.vue'

const router = vi.hoisted(() => ({ push: vi.fn() }))
const route = vi.hoisted(() => ({ path: '/knowledge', query: {} as Record<string, string> }))

vi.mock('vue-router', () => ({ useRouter: () => router, useRoute: () => route }))

const pendingBind: WeknoraIntegrationStatus = {
  configured: true,
  linked: false,
  source: null,
  canUnlink: false,
  directoryAccount: 'none',
}

async function mountPage() {
  const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {})
  const wrapper = mount(KnowledgeBasesView, { global: { plugins: [ElementPlus] } })
  await flushPromises()
  return { wrapper, assign }
}

describe('KnowledgeBasesView 绑定入口', () => {
  beforeEach(() => {
    route.query = {}
    vi.spyOn(workbenchApi, 'getWeknoraStatus').mockResolvedValue(pendingBind)
    vi.spyOn(workbenchApi, 'listWeknoraKnowledgeBases').mockResolvedValue({ list: [] })
  })

  it('待绑定时点击连接会跳转到接口返回的地址', async () => {
    vi.spyOn(workbenchApi, 'startWeknoraBind').mockResolvedValue({ url: 'https://kb.example/bind' })
    const { wrapper, assign } = await mountPage()

    await wrapper.get('button').trigger('click')
    await flushPromises()

    expect(workbenchApi.startWeknoraBind).toHaveBeenCalledOnce()
    expect(assign).toHaveBeenCalledWith('https://kb.example/bind')
  })

  it('连接接口失败时在页面上展示错误说明', async () => {
    vi.spyOn(workbenchApi, 'startWeknoraBind').mockRejectedValue(
      new WorkbenchApiError({ message: '知识库暂时无法访问' }, 503, '失败'),
    )
    const { wrapper } = await mountPage()

    await wrapper.get('button').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('知识库暂时无法访问')
  })
})
