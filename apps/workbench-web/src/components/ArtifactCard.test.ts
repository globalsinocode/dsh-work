import ElementPlus from 'element-plus'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { ArtifactCard } from '@dsh-work/ui-core'

import { artifactPreview } from '@/utils/artifact-preview'

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

  it('HTML 默认可预览，未声明的表格只有下载', () => {
    const html = mountCard('html')
    const htmlLabels = html.findAll('button').map(button => button.text().trim())
    expect(htmlLabels).toContain('预览')
    expect(htmlLabels).toContain('下载')
    const sheet = mountCard('xlsx')
    const sheetLabels = sheet.findAll('button').map(button => button.text().trim())
    expect(sheetLabels).not.toContain('预览')
    expect(sheetLabels).toContain('下载')
  })

  it('下载按钮只发出 download', async () => {
    const wrapper = mountCard('html')
    await wrapper.get('[data-testid="artifact-card-download"]').trigger('click')
    expect(wrapper.emitted('download')).toHaveLength(1)
    expect(wrapper.emitted('preview')).toBeUndefined()
  })
})

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
