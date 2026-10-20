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
