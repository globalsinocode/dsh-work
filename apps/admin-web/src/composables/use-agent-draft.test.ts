import { createPinia, setActivePinia } from 'pinia'
import { computed, defineComponent, h, nextTick, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { AdminApiError } from '@/api/client'
import { useContentStore } from '@/stores/content'
import type { AgentDefinition } from '@/types/domain'
import { provideAgentDraftEditor, validateAgentDraft, draftFormFromAgent, type AgentDraftEditor } from './use-agent-draft'

const agent: AgentDefinition = {
  id: 'agent-draft-ui', name: '草稿助手', description: '用于验证草稿自动保存的测试 Agent。', owner: '陈默',
  department: 'platform', visibility: '未设置', roleIds: [], allowWorkspaceJoin: true, status: 'draft', version: '0.1.0',
  welcomeMessage: '', examplePrompts: ['请介绍你能提供哪些帮助'], systemPrompt: '你是测试 Agent，只处理当前输入并说明依据。',
  workInstructions: '', maxOutputBytes: 65536, maxToolCalls: 20, timeoutSeconds: 300,
  skills: [], webSearchEnabled: false,
    projectTasksEnabled: false, mcpScope: { mode: 'none', connectorIds: [] }, updatedAt: '2026-10-16 08:00', revision: 'rev-1',
}

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function mountEditor(canEdit = true) {
  const source = ref<AgentDefinition | undefined>(agent)
  let editor!: AgentDraftEditor
  const Host = defineComponent({
    setup() {
      editor = provideAgentDraftEditor(source, { canEdit: computed(() => canEdit), delayMs: 500 })
      return () => h('div')
    },
  })
  const wrapper = mount(Host)
  return { wrapper, editor: () => editor, source }
}

it('内容合法时停止输入后自动保存一次，并带上读取时的修订', async () => {
  const content = useContentStore()
  const save = vi.spyOn(content, 'updateAgentDraft').mockImplementation(async input => ({ ...agent, ...input, revision: 'rev-2' }))
  const { editor } = mountEditor()
  editor().form.name = '草稿助手二'
  await nextTick()
  editor().form.name = '草稿助手三'
  await nextTick()
  expect(editor().state.value).toBe('pending')
  await vi.advanceTimersByTimeAsync(500)
  await flushPromises()
  expect(save).toHaveBeenCalledTimes(1)
  expect(save.mock.calls[0]![0]).toMatchObject({ id: agent.id, name: '草稿助手三', owner: '陈默' })
  expect(save.mock.calls[0]![1]).toBe('rev-1')
  expect(editor().state.value).toBe('saved')

  editor().form.description = '修改后的说明，长度足够用于保存。'
  await nextTick()
  await vi.advanceTimersByTimeAsync(500)
  await flushPromises()
  expect(save.mock.calls[1]![1]).toBe('rev-2')
})

it('内容不合法时不保存并给出字段错误，修正后恢复自动保存', async () => {
  const content = useContentStore()
  const save = vi.spyOn(content, 'updateAgentDraft').mockImplementation(async input => ({ ...agent, ...input, revision: 'rev-2' }))
  const { editor } = mountEditor()
  editor().form.workInstructions = '太短'
  await nextTick()
  await vi.advanceTimersByTimeAsync(1000)
  expect(save).not.toHaveBeenCalled()
  expect(editor().state.value).toBe('invalid')
  expect(editor().errors.workInstructions).toMatch(/至少需要 20 个字符/)
  editor().form.workInstructions = '先核对输入与授权资料，再给出可核对依据的结论和未解决事项。'
  await nextTick()
  expect(editor().errors.workInstructions).toBeUndefined()
  await vi.advanceTimersByTimeAsync(500)
  await flushPromises()
  expect(save).toHaveBeenCalledTimes(1)
})

it('修订冲突时停止自动保存，重新载入后恢复', async () => {
  const content = useContentStore()
  const save = vi.spyOn(content, 'updateAgentDraft')
    .mockRejectedValueOnce(new AdminApiError({ code: 'state_conflict', message: '已变化' }, 409, '冲突'))
  const { editor, source } = mountEditor()
  editor().form.name = '冲突中的名称'
  await nextTick()
  await vi.advanceTimersByTimeAsync(500)
  await flushPromises()
  expect(editor().state.value).toBe('conflict')
  editor().form.name = '冲突后继续修改'
  await nextTick()
  await vi.advanceTimersByTimeAsync(1000)
  expect(save).toHaveBeenCalledTimes(1)

  source.value = { ...agent, name: '其他人保存的名称', revision: 'rev-9' }
  editor().reload()
  expect(editor().form.name).toBe('其他人保存的名称')
  expect(editor().state.value).toBe('saved')
})

it('只读时不保存', async () => {
  const content = useContentStore()
  const save = vi.spyOn(content, 'updateAgentDraft')
  const { editor } = mountEditor(false)
  editor().form.name = '审计员不能修改'
  await nextTick()
  await vi.advanceTimersByTimeAsync(1000)
  expect(save).not.toHaveBeenCalled()
})

it('校验覆盖示例问题、MCP 选定与运行限制', () => {
  const form = draftFormFromAgent(agent)
  expect(validateAgentDraft(form)).toEqual({})
  expect(validateAgentDraft({ ...form, examplePrompts: ['  '] }).examplePrompts).toBeTruthy()
  expect(validateAgentDraft({ ...form, mcpScope: { mode: 'selected', connectorIds: [] } }).mcpScope).toBeTruthy()
  expect(validateAgentDraft({ ...form, timeoutSeconds: 10 }).timeoutSeconds).toBeTruthy()
})

it('“可推荐其他 AI 同事”开关随草稿自动保存，读取时按 Agent 当前设置回显', async () => {
  const content = useContentStore()
  const save = vi.spyOn(content, 'updateAgentDraft').mockImplementation(async input => ({ ...agent, ...input, revision: 'rev-2' }))
  expect(draftFormFromAgent({ ...agent, agentRecommendationEnabled: true }).agentRecommendationEnabled).toBe(true)
  expect(draftFormFromAgent(agent).agentRecommendationEnabled).toBe(false)
  const { editor } = mountEditor()
  editor().form.agentRecommendationEnabled = true
  await nextTick()
  await vi.advanceTimersByTimeAsync(500)
  await flushPromises()
  expect(save.mock.calls[0]![0]).toMatchObject({ id: agent.id, agentRecommendationEnabled: true })
})
