import ElementPlus from 'element-plus'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { ArtifactCard } from '@dsh-work/ui-core'

import { artifactPreview } from '@/utils/artifact-preview'

// 共享成果卡（ui-core）的“预览”入口：宿主按成果类型与解析状态决定（执行隔离 2b-5）。
const base = { name: '营收.xlsx', type: 'xlsx' as const, version: 1, size: '18 KB', createdAt: '10-27', summary: '' }

function card(artifact: typeof base & { textPreview?: 'available' | 'failed' | 'pending'; textPreviewError?: string }) {
  const preview = artifactPreview(artifact)
  return mount(ArtifactCard, {
    props: { artifact, previewable: preview.kind !== null, previewNote: preview.note },
    global: { plugins: [ElementPlus] },
  })
}

describe('ArtifactCard preview (2b-5)', () => {
  it('offers a preview for Office files with text and emits it', async () => {
    const wrapper = card({ ...base, textPreview: 'available' })
    const button = wrapper.get('[data-testid="artifact-preview-open"]')
    expect(button.attributes('aria-label')).toBe('预览 营收.xlsx')
    await button.trigger('click')
    expect(wrapper.emitted('preview')).toHaveLength(1)
  })

  it('shows why a failed extraction cannot be previewed', () => {
    const wrapper = card({ ...base, name: '报告.pdf', type: 'pdf' as never, textPreview: 'failed', textPreviewError: 'PDF 无法读取' })
    expect(wrapper.find('[data-testid="artifact-preview-open"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="artifact-preview-note"]').text()).toBe('无法预览：PDF 无法读取')
  })

  it('keeps the HTML-only default for hosts that do not decide', () => {
    const html = mount(ArtifactCard, { props: { artifact: { ...base, name: '看板.html', type: 'html' } }, global: { plugins: [ElementPlus] } })
    expect(html.find('[data-testid="artifact-preview-open"]').exists()).toBe(true)
    const sheet = mount(ArtifactCard, { props: { artifact: base }, global: { plugins: [ElementPlus] } })
    expect(sheet.find('[data-testid="artifact-preview-open"]').exists()).toBe(false)
  })
})
