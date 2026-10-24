import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { describe, expect, it, vi } from 'vitest'

import ExternalConnections from '@/components/external-connections/external-connections.vue'

describe('external-connections', () => {
  it('renders empty copy and row actions', async () => {
    const revoke = vi.fn()
    const authorize = vi.fn()
    const wrapper = mount(ExternalConnections, {
      props: {
        items: [],
        authorize,
        revoke,
        reload: vi.fn(),
      },
      global: { plugins: [ElementPlus] },
    })
    expect(wrapper.text()).toContain('管理员尚未登记需要个人授权的外部连接')

    await wrapper.setProps({
      items: [{
        connectorId: 'c-1', name: 'ERP', scopeDescription: '只读', toolCount: 2, status: 'unauthorized',
      }, {
        connectorId: 'c-2', name: 'CRM', scopeDescription: '读写', toolCount: 1, status: 'active',
      }],
    })
    await flushPromises()
    const authorizeButton = wrapper.findAll('button').find(button => button.text() === '授权')
    expect(authorizeButton).toBeDefined()
    const revokeButton = wrapper.findAll('button').find(button => button.text() === '解除授权')
    expect(revokeButton).toBeDefined()
    await revokeButton!.trigger('click')
    expect(revoke).toHaveBeenCalledWith('c-2')
  })
})
