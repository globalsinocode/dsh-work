import ElementPlus from 'element-plus'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Artifact } from '@/types/domain'
import ArtifactPreviewPanel from './ArtifactPreviewPanel.vue'

const { downloadArtifact, getArtifactText } = vi.hoisted(() => ({ downloadArtifact: vi.fn(), getArtifactText: vi.fn() }))
vi.mock('@/api/client', () => ({ workbenchApi: { downloadArtifact, getArtifactText } }))
const downloadArtifactFile = vi.hoisted(() => vi.fn())
vi.mock('@/utils/feedback', () => ({ downloadArtifactFile, notifyActionFailure: vi.fn() }))

// EX-ARTIFACT-08：对话中点击成果后的预览右栏。

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'a-md', name: '库存周报.md', type: 'markdown', version: 2, size: '2 KB', createdAt: '', runId: 'run-1',
    workspaceId: 'ws-personal', summary: '', ...overrides,
  }
}

function mountPanel(props: { artifact: Artifact | null; docked: boolean }) {
  return mount(ArtifactPreviewPanel, { props, global: { plugins: [ElementPlus] }, attachTo: document.body })
}

describe('ArtifactPreviewPanel', () => {
  beforeEach(() => {
    downloadArtifact.mockReset()
    getArtifactText.mockReset()
    downloadArtifactFile.mockReset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('docks beside the conversation with the file name, version, download and close', async () => {
    downloadArtifact.mockResolvedValue(new Blob(['# 周报正文']))
    const file = artifact()
    const wrapper = mountPanel({ artifact: file, docked: true })
    await flushPromises()

    const aside = wrapper.get('aside')
    expect(aside.attributes('aria-label')).toBe('成果预览：库存周报.md')
    expect(aside.text()).toContain('库存周报.md')
    expect(aside.text()).toContain('V2 · 2 KB')
    expect(aside.text()).toContain('周报正文')
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    await wrapper.get('[data-testid="artifact-panel-download"]').trigger('click')
    expect(downloadArtifactFile).toHaveBeenCalledWith(file)
    await wrapper.get('button[aria-label="关闭成果预览"]').trigger('click')
    await aside.trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(2)
    wrapper.unmount()
  })

  it('replaces the content when another artifact is chosen', async () => {
    downloadArtifact.mockImplementation(async (id: string) => new Blob([`正文 ${id}`]))
    const wrapper = mountPanel({ artifact: artifact({ id: 'a-1', name: '甲.md' }), docked: true })
    await flushPromises()
    expect(wrapper.get('aside').text()).toContain('正文 a-1')

    await wrapper.setProps({ artifact: artifact({ id: 'a-2', name: '乙.md' }) })
    expect(wrapper.get('aside').text()).not.toContain('正文 a-1')
    await flushPromises()
    expect(wrapper.get('aside').attributes('aria-label')).toBe('成果预览：乙.md')
    expect(wrapper.get('aside').text()).toContain('正文 a-2')
    wrapper.unmount()
  })

  it('marks Office text as extracted and shows HTML only rendered, without a source view', async () => {
    getArtifactText.mockResolvedValue({ status: 'available', type: 'docx', text: '季度报告正文', pageCount: null, sheetCount: null, rowCount: null })
    const doc = mountPanel({ artifact: artifact({ type: 'docx', name: '报告.docx', textPreview: 'available' }), docked: true })
    await flushPromises()
    expect(doc.get('aside').text()).toContain('V2 · 2 KB · 解析文本')
    expect(doc.find('[aria-label="预览方式"]').exists()).toBe(false)
    doc.unmount()

    downloadArtifact.mockResolvedValue(new Blob(['<h1>看板</h1>']))
    const html = mountPanel({ artifact: artifact({ type: 'html', name: '看板.html' }), docked: true })
    await flushPromises()
    expect(html.find('[data-testid="artifact-preview-frame"]').attributes('sandbox')).toBe('allow-scripts')
    expect(html.find('[aria-label="预览方式"]').exists()).toBe(false)
    expect(html.text()).not.toContain('源代码')
    expect(html.find('[data-testid="artifact-preview-source"]').exists()).toBe(false)
    html.unmount()
  })

  it('expands to full screen, leaves it on Escape before closing, and starts docked again next time', async () => {
    downloadArtifact.mockResolvedValue(new Blob(['# 周报正文']))
    const wrapper = mountPanel({ artifact: artifact(), docked: true })
    await flushPromises()
    const aside = () => wrapper.get('aside')

    await wrapper.get('button[aria-label="全屏查看"]').trigger('click')
    expect(aside().classes()).toContain('artifact-panel--expanded')
    expect(wrapper.find('button[aria-label="全屏查看"]').exists()).toBe(false)

    await aside().trigger('keydown', { key: 'Escape' })
    expect(aside().classes()).not.toContain('artifact-panel--expanded')
    expect(wrapper.emitted('close')).toBeUndefined()

    await wrapper.get('button[aria-label="全屏查看"]').trigger('click')
    await wrapper.get('button[aria-label="退出全屏"]').trigger('click')
    expect(aside().classes()).not.toContain('artifact-panel--expanded')

    await wrapper.get('button[aria-label="全屏查看"]').trigger('click')
    await wrapper.setProps({ artifact: null })
    await wrapper.setProps({ artifact: artifact() })
    expect(aside().classes()).not.toContain('artifact-panel--expanded')
    wrapper.unmount()
  })

  it('keeps focus inside the full-screen preview', async () => {
    downloadArtifact.mockResolvedValue(new Blob(['# 周报正文']))
    const outside = document.createElement('button')
    outside.textContent = '被遮住的对话'
    document.body.prepend(outside)
    const wrapper = mountPanel({ artifact: artifact(), docked: true })
    await flushPromises()
    const aside = () => wrapper.get('aside')
    expect(aside().attributes('role')).toBeUndefined()

    await wrapper.get('button[aria-label="全屏查看"]').trigger('click')
    expect(aside().attributes('role')).toBe('dialog')
    expect(aside().attributes('aria-modal')).toBe('true')

    // jsdom 不做布局：让预览内的按钮都算可见。
    const buttons = aside().findAll('button').map(button => button.element as HTMLButtonElement)
    for (const button of buttons) vi.spyOn(button, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
    const first = buttons[0]!
    const last = buttons[buttons.length - 1]!

    last.focus()
    await aside().trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    await aside().trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)

    // 焦点被移到预览外时拉回预览。
    outside.focus()
    expect(document.activeElement).toBe(first)

    // 退出全屏后不再限制焦点。
    await wrapper.get('button[aria-label="退出全屏"]').trigger('click')
    expect(aside().attributes('role')).toBeUndefined()
    outside.focus()
    expect(document.activeElement).toBe(outside)
    wrapper.unmount()
  })

  it('opens as a labelled drawer over the conversation when it cannot dock', async () => {
    downloadArtifact.mockResolvedValue(new Blob(['# 周报正文']))
    const wrapper = mountPanel({ artifact: artifact(), docked: false })
    await flushPromises()
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.getAttribute('aria-label')).toBe('成果预览：库存周报.md')
    expect(dialog?.textContent).toContain('周报正文')
    expect(wrapper.find('aside.artifact-panel').exists()).toBe(false)
    expect((dialog as HTMLElement).style.width).not.toBe('100%')

    // 抽屉同样可以全屏展开。
    ;(document.querySelector('button[aria-label="全屏查看"]') as HTMLButtonElement).click()
    await flushPromises()
    expect((document.querySelector('[role="dialog"]') as HTMLElement).style.width).toBe('100%')
    expect(document.querySelector('button[aria-label="退出全屏"]')).not.toBeNull()

    ;(document.querySelector('button[aria-label="关闭成果预览"]') as HTMLButtonElement).click()
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })
})
