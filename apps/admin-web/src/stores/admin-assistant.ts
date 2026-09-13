import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { adminApi } from '../api/client'
import { useAuthStore } from './auth'
import type { AdminConversation } from '../types/assistant'

export type AssistantContext = 'general' | 'skills' | 'agents' | 'operations'
interface Conversation extends AdminConversation { draft: string; context: AssistantContext; loaded: boolean; saved: boolean }
export const useAdminAssistantStore = defineStore('admin-assistant', () => {
  const auth = useAuthStore()
  const conversations = ref<Conversation[]>([])
  const selectedId = ref('')
  const loading = ref(false)
  const error = ref('')
  const busyIds = ref<string[]>([])
  const current = computed(() => conversations.value.find(item => item.id === selectedId.value)!)
  const active = computed(() => current.value.runs.some(run => ['queued', 'running', 'cancel_requested'].includes(run.status)))
  const requests = new Map<string, { text: string; id: string }>()
  let generation = 0
  let selection = 0
  let refreshing = false

  function start(context: AssistantContext = 'general') {
    const blank = conversations.value.find(item => !item.saved && !item.draft)
    if (blank) { selectedId.value = blank.id; blank.context = context; return }
    const id = `admin-session-${crypto.randomUUID()}`
    conversations.value.unshift({ id, title: '管理助手', messages: [], runs: [], installations: [], draft: '', context, loaded: true, saved: false })
    selectedId.value = id
  }
  watch(() => [auth.user.id, auth.canReadAdmin], () => {
    generation++
    conversations.value = []; busyIds.value = []; requests.clear(); error.value = ''; loading.value = false
    start()
  }, { immediate: true })

  function merge(data: AdminConversation) {
    const existing = conversations.value.find(item => item.id === data.id)
    if (existing) Object.assign(existing, data, { loaded: true, saved: true })
    else conversations.value.unshift({ ...data, draft: '', context: 'skills', loaded: true, saved: true })
  }
  async function load() {
    if (!auth.canReadAdmin) return
    const epoch = generation
    loading.value = true; error.value = ''
    try {
      const rows = await adminApi.getAssistantConversations()
      if (epoch !== generation) return
      for (const row of rows) {
        if (!conversations.value.some(item => item.id === row.id)) conversations.value.push({ ...row, messages: [], runs: [], installations: [], draft: '', context: 'skills', loaded: false, saved: true })
      }
    } catch (cause) { if (epoch === generation) error.value = message(cause) }
    finally { if (epoch === generation) loading.value = false }
  }
  async function select(id: string) {
    if (!auth.canReadAdmin) return
    const choice = ++selection
    let found = conversations.value.find(item => item.id === id)
    const epoch = generation
    error.value = ''
    try {
      if (!found?.loaded) {
        mergeIfCurrent(await adminApi.getAssistantConversation(id), epoch)
        found = conversations.value.find(item => item.id === id)
      }
      if (found && epoch === generation && choice === selection) selectedId.value = id
    } catch (cause) { if (epoch === generation) error.value = message(cause) }
  }
  function mergeIfCurrent(data: AdminConversation, epoch: number) { if (epoch === generation) merge(data) }
  async function refresh() {
    if (!auth.canReadAdmin || !current.value.saved || refreshing) return
    const id = selectedId.value, epoch = generation
    refreshing = true
    try { mergeIfCurrent(await adminApi.getAssistantConversation(id), epoch) }
    catch (cause) { if (epoch === generation) error.value = message(cause) }
    finally { refreshing = false }
  }
  async function send() {
    if (!auth.canManage || active.value || busyIds.value.includes(selectedId.value)) return
    const conversation = current.value, text = conversation.draft.trim()
    if (!text) return
    let request = requests.get(conversation.id)
    if (request?.text !== text) { request = { text, id: crypto.randomUUID() }; requests.set(conversation.id, request) }
    await act(conversation.id, async () => {
      const result = await adminApi.sendAssistantMessage({ sessionId: conversation.id, message: text, requestId: request!.id })
      if (conversation.draft.trim() === text) conversation.draft = ''
      requests.delete(conversation.id)
      return result
    })
  }
  async function act(id: string, perform: () => Promise<AdminConversation>, replyOnFailure = false) {
    if (!auth.canManage || busyIds.value.includes(id)) return
    const epoch = generation
    const messageIds = new Set(conversations.value.find(item => item.id === id)?.messages.map(item => item.id) ?? [])
    busyIds.value.push(id); error.value = ''
    try { mergeIfCurrent(await perform(), epoch) }
    catch (cause) {
      if (epoch !== generation) return
      let hasConversationReply = false
      try {
        const refreshed = await adminApi.getAssistantConversation(id)
        hasConversationReply = refreshed.messages.some(item => item.role === 'assistant' && !messageIds.has(item.id))
        mergeIfCurrent(refreshed, epoch)
      }
      catch { /* Keep the action error; polling can recover the conversation later. */ }
      if (!replyOnFailure || !hasConversationReply) error.value = message(cause)
    }
    finally { if (epoch === generation) busyIds.value = busyIds.value.filter(value => value !== id) }
  }
  async function confirm(runId: string, planSha256: string) { await act(selectedId.value, () => adminApi.confirmSkillInstallation(runId, planSha256), true) }
  async function cancel(runId: string) { await act(selectedId.value, () => adminApi.cancelAssistantRun(runId)) }
  async function retry(runId: string) { await act(selectedId.value, () => adminApi.retryAssistantRun(runId)) }
  return { conversations, selectedId, current, active, loading, error, busyIds, start, load, select, refresh, send, confirm, cancel, retry }
})
function message(cause: unknown) { return cause instanceof Error ? cause.message : '管理助手请求失败，请重试' }
