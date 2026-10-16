import { computed, inject, onBeforeUnmount, provide, reactive, ref, watch, type InjectionKey, type Ref } from 'vue'

import { AdminApiError } from '@/api/client'
import { useContentStore } from '@/stores/content'
import type { AgentDefinition, AgentMcpScope } from '@/types/domain'

/** 与服务端 AGENT_SPEC_BOUNDS 一致；服务端仍是最终校验。 */
export const AGENT_DRAFT_BOUNDS = {
  name: { min: 2, max: 40 },
  description: { min: 10, max: 200 },
  instructions: { min: 20, max: 20000 },
  welcomeMessage: { max: 120 },
  examplePrompts: { max: 8, itemMax: 200 },
  timeoutSeconds: { min: 30, max: 600 },
  maxToolCalls: { min: 1, max: 100 },
  maxOutputBytes: { min: 1024, max: 1048576 },
} as const

export interface AgentDraftForm {
  name: string
  description: string
  welcomeMessage: string
  examplePrompts: string[]
  systemPrompt: string
  workInstructions: string
  skills: string[]
  tools: string[]
  mcpScope: AgentMcpScope
  timeoutSeconds: number
  maxToolCalls: number
  maxOutputBytes: number
}

export type AgentDraftField = keyof AgentDraftForm

/**
 * saved：与服务端一致；pending：有修改，等待自动保存；saving：保存中；
 * invalid：内容不合法，未保存；conflict：已被其他操作修改；error：保存失败。
 */
export type AgentDraftSaveState = 'saved' | 'pending' | 'saving' | 'invalid' | 'conflict' | 'error'

export interface AgentDraftEditor {
  form: AgentDraftForm
  errors: Partial<Record<AgentDraftField, string>>
  state: Ref<AgentDraftSaveState>
  message: Ref<string>
  canEdit: Ref<boolean>
  savedAt: Ref<Date | undefined>
  hasUnsavedChanges: Ref<boolean>
  flush: () => Promise<void>
  reload: () => void
}

const editorKey: InjectionKey<AgentDraftEditor> = Symbol('agent-draft-editor')

export function emptyAgentDraftForm(): AgentDraftForm {
  return {
    name: '', description: '', welcomeMessage: '', examplePrompts: ['请介绍你能提供哪些帮助'],
    systemPrompt: '', workInstructions: '', skills: [], tools: [],
    mcpScope: { mode: 'none', connectorIds: [] },
    timeoutSeconds: 300, maxToolCalls: 20, maxOutputBytes: 65536,
  }
}

export function draftFormFromAgent(agent: AgentDefinition, versionTool: (reference: string) => string = reference => reference): AgentDraftForm {
  return {
    name: agent.name,
    description: agent.description,
    welcomeMessage: agent.welcomeMessage,
    examplePrompts: agent.examplePrompts.length ? [...agent.examplePrompts] : [''],
    systemPrompt: agent.systemPrompt,
    workInstructions: agent.workInstructions ?? '',
    skills: [...agent.skills],
    tools: agent.tools.map(versionTool),
    mcpScope: agent.mcpScope?.mode === 'selected'
      ? { mode: 'selected', connectorIds: [...agent.mcpScope.connectorIds] }
      : { mode: agent.mcpScope?.mode ?? 'all', connectorIds: [] },
    timeoutSeconds: agent.timeoutSeconds,
    maxToolCalls: agent.maxToolCalls,
    maxOutputBytes: agent.maxOutputBytes,
  }
}

/** 返回每个字段的第一条校验错误；空对象表示可以保存。 */
export function validateAgentDraft(form: AgentDraftForm): Partial<Record<AgentDraftField, string>> {
  const bounds = AGENT_DRAFT_BOUNDS
  const errors: Partial<Record<AgentDraftField, string>> = {}
  const name = form.name.trim()
  if (name.length < bounds.name.min || name.length > bounds.name.max) errors.name = `名称长度为 ${bounds.name.min}～${bounds.name.max} 个字符`
  const description = form.description.trim()
  if (description.length < bounds.description.min || description.length > bounds.description.max) {
    errors.description = `说明长度为 ${bounds.description.min}～${bounds.description.max} 个字符`
  }
  if (form.welcomeMessage.trim().length > bounds.welcomeMessage.max) errors.welcomeMessage = `欢迎语最多 ${bounds.welcomeMessage.max} 个字符`
  const soul = form.systemPrompt.trim().length
  if (soul < bounds.instructions.min) errors.systemPrompt = `SOUL.md 内容至少需要 ${bounds.instructions.min} 个字符`
  else if (soul > bounds.instructions.max) errors.systemPrompt = `SOUL.md 最多 ${bounds.instructions.max} 个字符`
  const procedures = form.workInstructions.trim().length
  if (procedures > 0 && procedures < bounds.instructions.min) errors.workInstructions = `AGENTS.md 填写后至少需要 ${bounds.instructions.min} 个字符`
  else if (procedures > bounds.instructions.max) errors.workInstructions = `AGENTS.md 最多 ${bounds.instructions.max} 个字符`
  const prompts = form.examplePrompts.map(prompt => prompt.trim()).filter(Boolean)
  if (!prompts.length) errors.examplePrompts = '至少填写一个员工端示例问题'
  else if (prompts.length > bounds.examplePrompts.max) errors.examplePrompts = `示例问题最多 ${bounds.examplePrompts.max} 个`
  else if (prompts.some(prompt => prompt.length > bounds.examplePrompts.itemMax)) errors.examplePrompts = `每个示例问题最多 ${bounds.examplePrompts.itemMax} 个字符`
  if (form.mcpScope.mode === 'selected' && !form.mcpScope.connectorIds.length) errors.mcpScope = '仅选定模式必须选择至少一个 Connector。'
  const range = (value: number, limit: { min: number; max: number }) =>
    Number.isInteger(value) && value >= limit.min && value <= limit.max
  if (!range(form.timeoutSeconds, bounds.timeoutSeconds)) errors.timeoutSeconds = `运行超时为 ${bounds.timeoutSeconds.min}～${bounds.timeoutSeconds.max} 秒`
  if (!range(form.maxToolCalls, bounds.maxToolCalls)) errors.maxToolCalls = `工具调用上限为 ${bounds.maxToolCalls.min}～${bounds.maxToolCalls.max}`
  if (!range(form.maxOutputBytes, bounds.maxOutputBytes)) errors.maxOutputBytes = `输出上限为 ${bounds.maxOutputBytes.min}～${bounds.maxOutputBytes.max} 字节`
  return errors
}

function serialize(form: AgentDraftForm) {
  return JSON.stringify(form)
}

/**
 * 详情页的草稿编辑状态：内容合法时在停止输入后自动保存到工作草稿。
 * 已发布或已冻结待发布时，第一次保存由服务端生成新的草稿版本。
 * 修订号防止覆盖其他人的修改；冲突时停止自动保存并提示重新载入。
 */
export function provideAgentDraftEditor(agent: Ref<AgentDefinition | undefined>, options: {
  canEdit: Ref<boolean>
  delayMs?: number
}): AgentDraftEditor {
  const contentStore = useContentStore()
  const form = reactive<AgentDraftForm>(emptyAgentDraftForm())
  const errors = reactive<Partial<Record<AgentDraftField, string>>>({})
  const state = ref<AgentDraftSaveState>('saved')
  const message = ref('')
  const savedAt = ref<Date>()
  const delay = options.delayMs ?? 800
  let snapshot = serialize(form)
  let revision: string | undefined
  let loadedId = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<void> | undefined

  const hasUnsavedChanges = computed(() => state.value === 'pending' || state.value === 'saving'
    || state.value === 'invalid' || state.value === 'error')

  function versionTool(reference: string) {
    if (reference.lastIndexOf('@') > 0) return reference
    const tool = contentStore.tools.find(item => item.id === reference)
    return `${reference}@${tool?.version ?? '1.0.0'}`
  }

  function load(source: AgentDefinition) {
    if (timer) clearTimeout(timer)
    timer = undefined
    Object.assign(form, draftFormFromAgent(source, versionTool))
    for (const key of Object.keys(errors) as AgentDraftField[]) delete errors[key]
    snapshot = serialize(form)
    revision = source.revision
    loadedId = source.id
    state.value = 'saved'
    message.value = ''
  }

  function reload() {
    if (agent.value) load(agent.value)
  }

  function refreshErrors() {
    const next = validateAgentDraft(form)
    for (const key of Object.keys(errors) as AgentDraftField[]) if (!next[key]) delete errors[key]
    Object.assign(errors, next)
    return Object.keys(next).length === 0
  }

  function schedule() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = undefined; void save() }, delay)
  }

  async function save(): Promise<void> {
    if (running) {
      await running
      if (serialize(form) !== snapshot && state.value !== 'conflict') return save()
      return
    }
    const source = agent.value
    if (!source || !options.canEdit.value || state.value === 'conflict') return
    const sent = serialize(form)
    if (sent === snapshot) { state.value = 'saved'; return }
    if (!refreshErrors()) { state.value = 'invalid'; message.value = '有内容不符合要求，修正后自动保存'; return }
    state.value = 'saving'
    message.value = ''
    const value = JSON.parse(sent) as AgentDraftForm
    running = (async () => {
      try {
        const saved = await contentStore.updateAgentDraft({
          id: source.id,
          owner: source.owner,
          department: source.department,
          name: value.name.trim(),
          description: value.description.trim(),
          welcomeMessage: value.welcomeMessage.trim(),
          examplePrompts: value.examplePrompts.map(prompt => prompt.trim()).filter(Boolean),
          systemPrompt: value.systemPrompt,
          workInstructions: value.workInstructions,
          skills: value.skills,
          tools: value.tools,
          mcpScope: value.mcpScope.mode === 'selected' ? value.mcpScope : { mode: value.mcpScope.mode, connectorIds: [] },
          timeoutSeconds: value.timeoutSeconds,
          maxToolCalls: value.maxToolCalls,
          maxOutputBytes: value.maxOutputBytes,
          changeSummary: `更新 ${value.name.trim()} 配置`,
        }, revision)
        revision = saved.revision
        snapshot = sent
        savedAt.value = new Date()
        state.value = serialize(form) === snapshot ? 'saved' : 'pending'
      } catch (cause) {
        if (cause instanceof AdminApiError && cause.status === 409) {
          state.value = 'conflict'
          message.value = 'Agent 已被其他操作修改，重新载入后再编辑'
        } else {
          state.value = 'error'
          message.value = cause instanceof Error ? cause.message : '草稿保存失败'
        }
      }
    })()
    try {
      await running
    } finally {
      running = undefined
    }
    if ((state.value as AgentDraftSaveState) === 'pending') schedule()
  }

  /** 离开页面或切换操作前调用：立即保存待保存的修改。 */
  async function flush() {
    if (timer) { clearTimeout(timer); timer = undefined }
    await save()
  }

  // 切换 Agent 时载入；没有本地修改时跟随服务端的新修订（例如发布、验证冻结、其他页面保存）。
  watch(agent, value => {
    if (!value) return
    if (value.id !== loadedId || (state.value === 'saved' && !running && value.revision !== revision)) load(value)
  }, { immediate: true })

  watch(form, () => {
    if (!options.canEdit.value || state.value === 'conflict') return
    const changed = serialize(form) !== snapshot
    if (!changed) {
      if (state.value !== 'saving') state.value = 'saved'
      refreshErrors()
      return
    }
    if (!refreshErrors()) {
      if (timer) { clearTimeout(timer); timer = undefined }
      state.value = 'invalid'
      message.value = '有内容不符合要求，修正后自动保存'
      return
    }
    if (state.value !== 'saving') state.value = 'pending'
    message.value = ''
    schedule()
  }, { deep: true })

  onBeforeUnmount(() => { if (timer) clearTimeout(timer) })

  const editor: AgentDraftEditor = {
    form, errors, state, message, savedAt, hasUnsavedChanges, canEdit: options.canEdit, flush, reload,
  }
  provide(editorKey, editor)
  return editor
}

export function useAgentDraftEditor(): AgentDraftEditor {
  const editor = inject(editorKey)
  if (!editor) throw new Error('Agent 草稿编辑器未提供')
  return editor
}
