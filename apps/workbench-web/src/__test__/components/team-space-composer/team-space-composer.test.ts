import ElementPlus from 'element-plus'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'

import { emptyComposerDraft } from '@dsh-work/workbench-components'

import TeamSpaceComposer from '@/components/team-space-composer/team-space-composer.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/', component: { template: '<div />' } }],
})

function mountTeamComposer(
  props: Record<string, unknown> = {},
  onDraftChange?: (fromKey: string, draft: ReturnType<typeof emptyComposerDraft>) => void,
) {
  return mount(TeamSpaceComposer, {
    props: {
      placement: 'dock',
      contextKey: 'history',
      workspaceId: 'ws-1',
      workspaceName: '团队 A',
      mentionOptions: [],
      drafts: {},
      ...(onDraftChange ? { onDraftChange } : {}),
      ...props,
    },
    global: {
      plugins: [ElementPlus, router],
      stubs: { teleport: true, ElDropdown: { template: '<div><slot /></div>' } },
    },
  })
}

describe('team-space-composer', () => {
  it('keeps drafts per contextKey when switching keys on the same instance', async () => {
    const drafts: Record<string, ReturnType<typeof emptyComposerDraft>> = {}
    const wrapper = mountTeamComposer({ contextKey: 'history', drafts }, (fromKey, draft) => {
      drafts[fromKey] = draft
    })

    const textarea = wrapper.get('textarea')
    await textarea.setValue('历史里未发送')
    await textarea.trigger('input')
    await nextTick()

    await wrapper.setProps({ contextKey: 'session:s1' })
    await nextTick()
    expect(wrapper.emitted('draft-change')?.[0]?.[0]).toBe('history')

    drafts.history = { prompt: '历史里未发送', files: [], mentions: [] }
    await wrapper.setProps({ contextKey: 'session:s1', drafts })
    await nextTick()
    expect(wrapper.get('textarea').element.value).toBe('')

    await wrapper.setProps({ contextKey: 'history', drafts })
    await flushPromises()
    expect(wrapper.get('textarea').element.value).toBe('历史里未发送')
  })

  it('keeps shortcut hint when mentionOptions arrive later', async () => {
    const wrapper = mountTeamComposer({ mentionOptions: [] })
    const textarea = wrapper.get('textarea')
    const hintBefore = wrapper.get('.workbench-trust--compact').text()

    await wrapper.setProps({
      mentionOptions: [{ id: 'm1', name: '智能助手' }],
    })
    await nextTick()

    expect(wrapper.get('textarea').element).toBe(textarea.element)
    expect(wrapper.get('.workbench-trust--compact').text()).toBe(hintBefore)
    expect(hintBefore).toContain('Tab')
  })

  it('does not wipe attachments on mount when the parent has no stored draft yet', async () => {
    const wrapper = mountTeamComposer({ drafts: {} })
    const fileInput = wrapper.get<HTMLInputElement>('input[type="file"]')
    const file = new File(['材料'], '挂载前.pdf', { type: 'application/pdf' })
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: [file] })
    await fileInput.trigger('change')
    await flushPromises()

    expect(wrapper.text()).toContain('挂载前.pdf')
  })

  it('applies a new initialPrompt without clearing selected files', async () => {
    const wrapper = mountTeamComposer({ initialPrompt: '' })
    const fileInput = wrapper.get<HTMLInputElement>('input[type="file"]')
    const file = new File(['材料'], '业务材料.pdf', { type: 'application/pdf' })
    Object.defineProperty(fileInput.element, 'files', { configurable: true, value: [file] })
    await fileInput.trigger('change')
    await flushPromises()

    await wrapper.setProps({
      initialPrompt: '请整理我接下来提供的业务材料，提炼关键事实、待办事项和责任人。',
    })
    await nextTick()

    expect(wrapper.text()).toContain('业务材料.pdf')
    expect(wrapper.get('textarea').element.value).toContain('请整理我接下来提供的业务材料')
  })

  it('includes contextKey on submit and clears current draft on confirm', async () => {
    const drafts: Record<string, ReturnType<typeof emptyComposerDraft>> = {}
    const wrapper = mountTeamComposer({
      mentionOptions: [{ id: 'm1', name: 'A' }],
      drafts,
      filesRequireMention: false,
      initialPrompt: '要发送',
    })

    await wrapper.get('[aria-label="发送消息"]').trigger('click')

    const payload = wrapper.emitted('submit')?.[0]?.[0] as {
      contextKey: string
      confirm: () => void
    }
    expect(payload.contextKey).toBe('history')
    payload.confirm()
    await nextTick()
    expect(wrapper.get('textarea').element.value).toBe('')
  })
})
