import ElementPlus from 'element-plus'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { ArtifactCard } from '@dsh-work/ui-core'

function mountCard(type: 'html' | 'xlsx') {
  return mount(ArtifactCard, {
    props: {
      artifact: {
        name: type === 'html' ? '看板.html' : '清单.xlsx',
        type,
        version: 2,
        size: '4 KB',
        createdAt: '今天 09:23',
        summary: '摘要',
      },
    },
    global: { plugins: [ElementPlus] },
  })
}

describe('ArtifactCard 直接预览', () => {
  it('点击文件名发出 preview，不发出 download', async () => {
    const wrapper = mountCard('xlsx')
    await wrapper.get('[data-testid="artifact-card-open"]').trigger('click')
    expect(wrapper.emitted('preview')).toHaveLength(1)
    expect(wrapper.emitted('download')).toBeUndefined()
  })

  it('操作区只有下载，没有名为预览的按钮', () => {
    const wrapper = mountCard('html')
    const labels = wrapper.findAll('button').map(button => button.text().trim())
    expect(labels).not.toContain('预览')
    expect(labels).toContain('下载')
  })

  it('下载按钮只发出 download', async () => {
    const wrapper = mountCard('html')
    await wrapper.get('[data-testid="artifact-card-download"]').trigger('click')
    expect(wrapper.emitted('download')).toHaveLength(1)
    expect(wrapper.emitted('preview')).toBeUndefined()
  })
})
