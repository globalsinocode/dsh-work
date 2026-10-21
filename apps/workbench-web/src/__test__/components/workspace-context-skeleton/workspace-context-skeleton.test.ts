import ElementPlus from 'element-plus'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import WorkspaceContextSkeleton from '@/components/workspace-context-skeleton/workspace-context-skeleton.vue'

describe('workspace-context-skeleton', () => {
  it('渲染团队空间详情布局骨架并标记加载状态', () => {
    const wrapper = mount(WorkspaceContextSkeleton, {
      global: { plugins: [ElementPlus] },
    })

    expect(wrapper.find('[data-testid="workspace-context-skeleton"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="workspace-context-skeleton"]').attributes('aria-busy')).toBe('true')
    expect(wrapper.find('.workspace-context-skeleton__composer').exists()).toBe(true)
    expect(wrapper.find('.workspace-context-skeleton__aside').exists()).toBe(true)
  })
})
