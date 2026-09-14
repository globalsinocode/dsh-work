<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ChatDotRound, Check, Cpu, Document, Grid, Right, VideoPause } from '@element-plus/icons-vue'
import { useRoute, useRouter } from 'vue-router'
import { AssistantMessageContent } from '@dsh-work/ui-core'
import SkillPackagePreview from '@/components/SkillPackagePreview.vue'
import { useAdminAssistantStore } from '@/stores/admin-assistant'
import { useAuthStore } from '@/stores/auth'
import type { AdminActionPlan, SkillInstallation } from '@/types/assistant'

const auth = useAuthStore()
const assistant = useAdminAssistantStore()
const route = useRoute()
const router = useRouter()
const composer = ref<{ focus: () => void }>()
const messageList = ref<HTMLElement>()
const busy = computed(() => assistant.busyIds.includes(assistant.selectedId))
const activeRun = computed(() => [...assistant.current.runs].reverse().find(run => ['queued', 'running', 'cancel_requested'].includes(run.status)))
const pendingDecision = computed(() => assistant.current.proposals.some(item => item.status === 'pending') || assistant.current.actions.some(item => item.status === 'pending'))
const hasConversationContent = computed(() => assistant.current.messages.length > 0 || assistant.current.proposals.length > 0 || assistant.current.actions.length > 0)
const statuses: Record<string, string> = { queued: '等待执行', running: '管理助手处理中', cancel_requested: '正在取消', succeeded: '处理完成', failed: '处理失败', cancelled: '已取消' }
const installationFor = (runId: string) => assistant.current.installations.find(item => item.runId === runId)
const proposalFor = (runId: string) => assistant.current.proposals.find(item => item.runId === runId)
const actionFor = (runId: string) => assistant.current.actions.find(item => item.runId === runId)
const conversationProgress = computed(() => {
  const lastMessage = assistant.current.messages.at(-1)
  const lastRun = assistant.current.runs.at(-1)
  const lastProposal = assistant.current.proposals.at(-1)
  const lastAction = assistant.current.actions.at(-1)
  const lastInstallation = assistant.current.installations.at(-1)
  return [
    assistant.selectedId,
    assistant.current.messages.length, lastMessage?.id, lastMessage?.text,
    assistant.current.runs.length, lastRun?.id, lastRun?.status, lastRun?.error,
    assistant.current.proposals.length, lastProposal?.id, lastProposal?.status,
    assistant.current.actions.length, lastAction?.id, lastAction?.status, lastAction?.resultSummary,
    assistant.current.installations.length, lastInstallation?.id, lastInstallation?.status,
  ].join('\u001f')
})
function installedTitle(installation: SkillInstallation) {
  if (installation.resultType === 'duplicate') return 'Skill 已存在，无需重复安装'
  if (installation.resultType === 'updated') return `新版本 v${installation.installedVersion ?? ''} 已保存为待验证草稿`
  return `安装完成，v${installation.installedVersion ?? '0.1.0'} 为待验证草稿`
}
function installedDescription(installation: SkillInstallation) {
  if (installation.resultType === 'duplicate') return `平台复用了内容一致的现有版本 v${installation.installedVersion ?? ''}，没有创建重复 Skill 或版本。`
  return '平台已保存完整 Skill 包。严格试运行并发布前，Agent 不会使用该版本。'
}
watch(() => route.query.conversation, id => { if (typeof id === 'string') void assistant.select(id) }, { immediate: true })
watch(() => route.query.context, context => {
  if (context === 'skills' || context === 'agents' || context === 'operations') assistant.current.context = context
}, { immediate: true })
watch(conversationProgress, async (progress, previous) => {
  if (progress === previous) return
  await scrollMessagesToLatest()
}, { flush: 'post' })
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => { if (assistant.active) void assistant.refresh() }, 1500)
  if (assistant.current.saved) void assistant.refresh()
})
onUnmounted(() => clearInterval(timer))
async function prepare(text: string) {
  assistant.current.draft = text
  await nextTick()
  composer.value?.focus()
}
async function send(event?: KeyboardEvent) {
  if (event?.isComposing) return
  const text = assistant.current.draft.trim()
  if (!text || pendingDecision.value) return
  await assistant.send()
  await scrollToLatest()
}
async function confirmProposedTask(id: string, digest: string) {
  await assistant.confirmProposal(id, digest)
  await scrollToLatest()
}
async function cancelProposedTask(id: string) {
  await assistant.cancelProposal(id)
  await scrollToLatest()
}
async function confirmAction(plan: AdminActionPlan) {
  await assistant.confirmAction(plan.id, plan.planSha256)
  await scrollToLatest()
}
async function cancelAction(id: string) {
  await assistant.cancelAction(id)
  await scrollToLatest()
}
function actionRows(plan: AdminActionPlan) {
  return [...new Set([...Object.keys(plan.before), ...Object.keys(plan.after)])]
    .filter(key => JSON.stringify(plan.before[key]) !== JSON.stringify(plan.after[key]))
    .map(key => ({ key, before: displayValue(plan.before[key]), after: displayValue(plan.after[key]) }))
}
function displayValue(value: unknown) {
  if (Array.isArray(value)) return value.join('、') || '无'
  if (value === null || value === undefined || value === '') return '无'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
async function scrollToLatest() {
  if (assistant.current.saved && route.query.conversation !== assistant.selectedId) await router.replace({ path: '/assistant', query: { conversation: assistant.selectedId } })
  await scrollMessagesToLatest()
}
async function scrollMessagesToLatest() {
  await nextTick()
  messageList.value?.scrollTo({ top: messageList.value.scrollHeight, behavior: 'smooth' })
}
async function stop() {
  if (!activeRun.value || activeRun.value.status === 'cancel_requested') return
  await assistant.cancel(activeRun.value.id)
}
async function confirmInstallation(runId: string, planSha256: string) {
  await assistant.confirm(runId, planSha256)
  await scrollMessagesToLatest()
}
</script>

<template>
  <div class="ops-page assistant-page">
    <div class="assistant-notice"><el-tag type="success" effect="plain">DSH 已接入</el-tag><span>普通问答由通用管理助手处理；识别到执行任务后，确认前不会调用专用助手，具体写入仍需再次确认计划。</span></div>
    <el-alert v-if="assistant.error" :title="assistant.error" type="error" show-icon :closable="false"><el-button link type="primary" @click="assistant.current.saved ? assistant.refresh() : assistant.load()">重新连接</el-button></el-alert>
    <div class="assistant-workspace">
      <section class="content-panel assistant-conversation" aria-label="管理助手对话" :aria-busy="busy || assistant.active">
        <header class="conversation-header"><span class="assistant-avatar"><el-icon><ChatDotRound /></el-icon></span><div><strong>统一管理入口</strong><small>普通对话 · 受控任务调度</small></div><el-tag type="info" effect="plain">{{ assistant.active ? '处理中' : pendingDecision ? '待确认' : '可对话' }}</el-tag></header>
        <div ref="messageList" class="conversation-body" v-loading="assistant.loading">
          <div v-if="!hasConversationContent" class="assistant-welcome">
            <h2>今天要了解或处理什么？</h2><p>直接描述问题或管理任务。普通问答直接回复，需要执行的任务会先请你确认调用哪个专用助手。</p>
            <div class="capability-cards">
              <button class="capability-card" type="button" @click="prepare('当前有哪些未发布的 Skill？')"><el-icon><ChatDotRound /></el-icon><strong>普通对话</strong><span>查询、解释和诊断不会执行平台变更</span><small>直接回答 <el-icon><Right /></el-icon></small></button>
              <button class="capability-card" type="button" @click="prepare('安装这个已有 Skill：')"><el-icon><Document /></el-icon><strong>Skill 管理</strong><span>识别来源后，确认调用 Skill 安装助手</span><small>已接入 <el-icon><Right /></el-icon></small></button>
              <button class="capability-card" type="button" @click="prepare('调整采购分析 Agent 的 Skill 和可见角色')"><el-icon><Grid /></el-icon><strong>Agent 管理</strong><span>先展示职责、能力与权限变更摘要</span><small>已接入 <el-icon><Right /></el-icon></small></button>
              <button class="capability-card" type="button" @click="prepare('排空当前 Runtime，停止接收新任务')"><el-icon><Cpu /></el-icon><strong>平台运维</strong><span>先核对操作对象、当前状态和影响</span><small>已接入 <el-icon><Right /></el-icon></small></button>
            </div>
            <div class="assistant-boundary"><el-icon><Check /></el-icon><span>普通问答不需要执行确认；调用专用助手前必须确认；具体写入仍以结构化计划再次确认。</span></div>
          </div>
          <div v-else class="assistant-messages" role="log" aria-label="管理对话记录" aria-live="polite">
            <div v-for="run in assistant.current.runs" :key="run.id" class="assistant-run">
              <article v-for="message in assistant.current.messages.filter(item => item.runId === run.id)" :key="message.id" class="assistant-message" :class="message.role"><strong class="message-author">{{ message.role === 'user' ? '你' : '管理助手' }}</strong><AssistantMessageContent :text="message.text" /></article>
              <div class="run-status" role="status"><el-tag :type="run.status === 'failed' ? 'danger' : 'info'">{{ statuses[run.status] }}</el-tag><span v-if="run.error">{{ run.error }}</span><el-button v-if="auth.canManage && ['failed', 'cancelled'].includes(run.status)" link type="primary" :disabled="busy" @click="assistant.retry(run.id)">重试</el-button></div>
              <div v-if="proposalFor(run.id)" class="action-card delegation-card">
                <header><div><h3>识别到管理任务</h3><p>通用管理助手准备将这项工作交给专用助手。确认前不会启动任务。</p></div><el-tag :type="proposalFor(run.id)!.status === 'pending' && auth.canManage ? 'warning' : 'info'" effect="plain">{{ proposalFor(run.id)!.status === 'pending' ? auth.canManage ? '待确认' : '需要管理写权限' : proposalFor(run.id)!.status === 'confirmed' ? '已确认' : '已取消' }}</el-tag></header>
                <dl class="delegation-summary">
                  <div><dt>任务</dt><dd>{{ proposalFor(run.id)!.title }}</dd></div>
                  <div><dt>将调用</dt><dd><strong>{{ proposalFor(run.id)!.assistantName }}</strong><code>{{ proposalFor(run.id)!.purpose }}</code></dd></div>
                  <div><dt>管理员请求</dt><dd>{{ proposalFor(run.id)!.request }}</dd></div>
                  <div><dt>预计影响</dt><dd>{{ proposalFor(run.id)!.impact }}</dd></div>
                </dl>
                <footer v-if="proposalFor(run.id)!.status === 'pending'"><span>确认后将启动真实 DSH 专用助手；此时仍不执行具体写入</span><el-button v-if="auth.canManage" :disabled="busy" @click="cancelProposedTask(proposalFor(run.id)!.id)">取消</el-button><el-button v-if="auth.canManage" type="primary" :loading="busy" :disabled="run.status !== 'succeeded'" @click="confirmProposedTask(proposalFor(run.id)!.id, proposalFor(run.id)!.proposalSha256)">确认并调用</el-button></footer>
              </div>
              <div v-if="actionFor(run.id)" class="action-card">
                <header><div><h3>确认具体操作计划</h3><p>{{ actionFor(run.id)!.summary }}</p></div><el-tag :type="actionFor(run.id)!.status === 'failed' ? 'danger' : actionFor(run.id)!.status === 'pending' ? 'warning' : 'info'" effect="plain">{{ actionFor(run.id)!.status === 'pending' ? '待确认' : actionFor(run.id)!.status === 'executing' ? '执行中' : actionFor(run.id)!.status === 'executed' ? '已执行' : actionFor(run.id)!.status === 'cancelled' ? '已取消' : '执行失败' }}</el-tag></header>
                <div class="action-diff" role="table" aria-label="操作计划变更前后对比">
                  <div class="action-diff-row action-diff-header" role="row"><strong role="columnheader">字段</strong><strong role="columnheader">变更前</strong><strong role="columnheader">变更后</strong></div>
                  <div v-for="row in actionRows(actionFor(run.id)!)" :key="row.key" class="action-diff-row" role="row"><span role="cell">{{ row.key }}</span><span role="cell">{{ row.before }}</span><span role="cell">{{ row.after }}</span></div>
                </div>
                <p v-if="actionFor(run.id)!.resultSummary" class="action-plan-result">{{ actionFor(run.id)!.resultSummary }}</p>
                <footer v-if="actionFor(run.id)!.status === 'pending'"><span>只会执行上表列出的变更；状态变化后计划会失效</span><el-button v-if="auth.canManage" :disabled="busy" @click="cancelAction(actionFor(run.id)!.id)">取消计划</el-button><el-button v-if="auth.canManage" type="primary" :loading="busy" :disabled="run.status !== 'succeeded'" @click="confirmAction(actionFor(run.id)!)">确认执行计划</el-button></footer>
              </div>
              <div v-if="installationFor(run.id)" class="action-card">
                <header><div><h3>{{ installationFor(run.id)!.status === 'installed' ? installationFor(run.id)!.resultType === 'duplicate' ? 'Skill 已存在' : 'Skill 已安装' : installationFor(run.id)!.status === 'cancelled' ? '安装已取消' : '确认安装已有 Skill' }}</h3><p>安装结果以管理助手回复和此操作卡片为准，不自动发布或修改已有 Agent 引用。</p></div></header>
                <div v-if="installationFor(run.id)!.status === 'installed'" class="action-result" role="status"><span class="result-icon"><el-icon><Check /></el-icon></span><div><strong>{{ installedTitle(installationFor(run.id)!) }}</strong><p>{{ installedDescription(installationFor(run.id)!) }}</p></div><el-button type="primary" plain @click="router.push('/skills')">{{ installationFor(run.id)!.resultType === 'duplicate' ? '前往 Skill 管理查看' : '前往 Skill 管理验证并发布' }}</el-button></div>
                <SkillPackagePreview v-if="installationFor(run.id)!.status === 'pending' && installationFor(run.id)!.package" :source="installationFor(run.id)!.resolvedUrl ?? installationFor(run.id)!.source" :package="installationFor(run.id)!.package!" :plan="installationFor(run.id)!.plan" :resolved-ref="installationFor(run.id)!.resolvedRef ?? undefined" />
                <el-collapse v-else-if="installationFor(run.id)!.status === 'installed' && installationFor(run.id)!.package" class="installed-plan"><el-collapse-item title="查看已确认的安装计划" name="plan"><SkillPackagePreview :source="installationFor(run.id)!.resolvedUrl ?? installationFor(run.id)!.source" :package="installationFor(run.id)!.package!" :plan="installationFor(run.id)!.plan" :resolved-ref="installationFor(run.id)!.resolvedRef ?? undefined" /></el-collapse-item></el-collapse>
                <footer v-if="installationFor(run.id)!.status === 'pending' && auth.canManage"><span>一次确认根 Skill、全部依赖和权限摘要</span><el-button :disabled="busy" @click="assistant.cancel(run.id)">取消安装</el-button><el-button type="primary" :loading="busy" :disabled="run.status !== 'succeeded' || !installationFor(run.id)!.planSha256 || installationFor(run.id)!.compatibilityStatus === 'incompatible'" @click="confirmInstallation(run.id, installationFor(run.id)!.planSha256!)">确认安装计划</el-button></footer>
              </div>
            </div>
          </div>
        </div>
        <footer class="assistant-input-area">
          <template v-if="auth.canReadAdmin">
            <div class="source-shortcuts"><span>示例</span><el-button link type="primary" :disabled="pendingDecision" @click="prepare('当前有哪些未发布的 Skill？')">普通问答</el-button><el-button link type="primary" :disabled="pendingDecision" @click="prepare('https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines')">Skill 来源</el-button><el-button link type="primary" :disabled="pendingDecision" @click="prepare('调整采购分析 Agent 的可见角色')">Agent 变更</el-button><el-button link type="primary" :disabled="pendingDecision" @click="prepare('排空当前 Runtime，停止接收新任务')">运维操作</el-button></div>
            <form class="assistant-composer" @submit.prevent="send()"><el-input ref="composer" v-model="assistant.current.draft" type="textarea" :rows="3" resize="none" maxlength="20000" aria-label="管理需求" :disabled="pendingDecision" placeholder="描述问题或管理任务，助手会先判断是否需要调用专用助手…" @keydown.enter.exact.prevent="send" /><div><small>{{ pendingDecision ? '请先确认或取消待执行任务' : 'Enter 发送，Shift + Enter 换行' }}</small><el-button v-if="activeRun" type="danger" native-type="button" :icon="VideoPause" :loading="busy || activeRun.status === 'cancel_requested'" :disabled="activeRun.status === 'cancel_requested'" :aria-label="activeRun.status === 'cancel_requested' ? '正在停止处理' : '停止处理'" @click="stop">{{ activeRun.status === 'cancel_requested' ? '正在停止' : '停止' }}</el-button><el-button v-else type="primary" native-type="submit" :icon="Right" :loading="busy" :disabled="pendingDecision || !assistant.current.draft.trim()">发送</el-button></div></form>
          </template>
        </footer>
      </section>
    </div>
  </div>
</template>

<style scoped>
:global(body:has(.assistant-page)) { min-width: 0; }
.assistant-notice { display: flex; align-items: center; flex-wrap: wrap; gap: calc(var(--spacing-card) / 2); color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.assistant-workspace { display: flex; flex-direction: column; height: min(820px, calc(100vh - var(--dsh-topbar-height) - 90px)); min-height: 590px; }
.assistant-conversation { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; padding: 0; overflow: hidden; }
.conversation-header { display: flex; align-items: center; gap: var(--spacing-card); padding: var(--spacing-card) var(--spacing-section); border-bottom: 1px solid var(--color-border); }
.assistant-avatar { display: grid; place-items: center; width: calc(var(--spacing-section) * 2); height: calc(var(--spacing-section) * 2); border-radius: var(--radius-card); color: var(--color-primary); background: var(--color-primary-light); font-size: var(--font-size-heading); }
.conversation-header > div { flex: 1; }
.conversation-header small { display: block; color: var(--color-text-secondary); margin-top: calc(var(--spacing-card) / 4); }
.conversation-body { flex: 1; min-height: 0; overflow: auto; padding: var(--spacing-section); }
.assistant-welcome { padding: var(--spacing-section) 0; }
.assistant-welcome h2 { margin: 0; color: var(--color-text-heading); font-size: var(--font-size-heading); }
.assistant-welcome > p { margin: calc(var(--spacing-card) / 2) 0 var(--spacing-section); color: var(--color-text-secondary); }
.capability-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--spacing-card); }
.capability-card { display: flex; flex-direction: column; align-items: flex-start; gap: calc(var(--spacing-card) / 2); padding: var(--spacing-card); border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-bg-base); color: var(--color-text-heading); text-align: left; cursor: pointer; }
.capability-card:hover { border-color: var(--color-primary); background: var(--color-primary-light); }
.capability-card > .el-icon { color: var(--color-primary); font-size: var(--font-size-heading); margin-bottom: calc(var(--spacing-card) / 4); }
.capability-card strong { font-size: var(--font-size-body); }
.capability-card > span { flex: 1; font-size: var(--font-size-caption); color: var(--color-text-secondary); line-height: 1.7; }
.capability-card small { display: flex; align-items: center; gap: calc(var(--spacing-card) / 4); color: var(--color-primary); }
.assistant-boundary { display: flex; align-items: flex-start; gap: calc(var(--spacing-card) / 2); margin-top: var(--spacing-section); color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.assistant-messages { display: flex; flex-direction: column; gap: var(--spacing-section); }
.assistant-run { display: flex; flex-direction: column; gap: var(--spacing-card); }
.run-status { display: flex; align-items: center; gap: var(--spacing-card); flex-wrap: wrap; color: var(--color-text-secondary); }
.capability-card:disabled { cursor: default; opacity: .65; }
.assistant-message { min-width: 0; max-width: min(920px, 92%); padding: var(--spacing-card); border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-bg-page); }
.assistant-message.user { align-self: flex-end; max-width: 85%; padding: var(--spacing-card); border-radius: var(--radius-card); background: var(--color-primary-light); }
.assistant-message.assistant { align-self: flex-start; }
.message-author { display: block; margin-bottom: calc(var(--spacing-card) / 2); color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.query-results { border: 1px solid var(--color-border); border-radius: var(--radius-card); padding: var(--spacing-card); }
.result-label { color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.query-results dl { margin: 0; }
.query-results dl > div { display: flex; justify-content: space-between; flex-wrap: wrap; gap: calc(var(--spacing-card) / 2); padding-top: var(--spacing-card); }
.query-results dd { margin: 0; color: var(--color-text-secondary); }
.action-card { padding: var(--spacing-card); border: 1px solid var(--color-border); border-radius: var(--radius-card); }
.action-card > header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--spacing-card); margin-bottom: var(--spacing-card); }
.action-card h3 { margin: 0; color: var(--color-text-heading); font-size: var(--font-size-title); }
.action-card header p, .action-result p { margin: calc(var(--spacing-card) / 2) 0 0; color: var(--color-text-secondary); font-size: var(--font-size-caption); line-height: 1.7; }
.action-result { display: flex; align-items: center; flex-wrap: wrap; gap: var(--spacing-card); padding: var(--spacing-card); border-radius: var(--radius-button); background: var(--color-success-light); }
.action-result > div { flex: 1; min-width: 220px; }
.action-diff { overflow: hidden; border: 1px solid var(--color-border); border-radius: var(--radius-button); }
.action-diff-row { display: grid; grid-template-columns: minmax(120px, .7fr) repeat(2, minmax(180px, 1fr)); }
.action-diff-row > * { min-width: 0; padding: calc(var(--spacing-card) / 2); overflow-wrap: anywhere; border-top: 1px solid var(--color-border); }
.action-diff-row > * + * { border-left: 1px solid var(--color-border); }
.action-diff-row:first-child > * { border-top: 0; }
.action-diff-header { color: var(--color-text-secondary); background: var(--color-bg-page); font-size: var(--font-size-caption); }
.action-plan-result { margin: var(--spacing-card) 0 0; color: var(--color-text-secondary); }
.result-icon { display: grid; place-items: center; flex: 0 0 auto; width: calc(var(--spacing-section) * 2); height: calc(var(--spacing-section) * 2); border-radius: 50%; color: var(--color-success-strong); background: var(--color-bg-base); font-size: var(--font-size-heading); }
.installed-plan { margin-top: var(--spacing-card); }
.action-card footer { display: flex; justify-content: flex-end; align-items: center; flex-wrap: wrap; gap: calc(var(--spacing-card) / 2); border-top: 1px solid var(--color-border); padding-top: var(--spacing-card); margin-top: var(--spacing-card); }
.action-card footer span { margin-right: auto; color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.action-card footer .el-button + .el-button { margin-left: 0; }
.action-unavailable { color: var(--color-warning-strong); }
.delegation-card { border-color: var(--color-warning); background: var(--color-warning-light); }
.delegation-summary { display: grid; gap: calc(var(--spacing-card) / 2); margin: 0; }
.delegation-summary > div { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: var(--spacing-card); }
.delegation-summary dt { color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.delegation-summary dd { min-width: 0; margin: 0; color: var(--color-text-heading); line-height: 1.7; overflow-wrap: anywhere; }
.delegation-summary code { display: block; width: fit-content; margin-top: calc(var(--spacing-card) / 4); color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.assistant-input-area { padding: var(--spacing-card) var(--spacing-section); border-top: 1px solid var(--color-border); }
.prompt-suggestions { display: flex; flex-wrap: wrap; gap: calc(var(--spacing-card) / 2); margin-bottom: calc(var(--spacing-card) / 2); }
.prompt-suggestions button { border: 1px solid var(--color-border); border-radius: var(--radius-tag); padding: calc(var(--spacing-card) / 4) calc(var(--spacing-card) / 2); color: var(--color-text-secondary); background: var(--color-bg-base); font-size: var(--font-size-badge); cursor: pointer; text-align: left; }
.source-shortcuts { display: flex; align-items: center; gap: calc(var(--spacing-card) / 2); margin-bottom: calc(var(--spacing-card) / 2); font-size: var(--font-size-badge); color: var(--color-text-secondary); }
.source-shortcuts .el-button + .el-button { margin-left: 0; }
.assistant-composer { border: 1px solid var(--color-border); border-radius: var(--radius-card); padding: calc(var(--spacing-card) / 2); }
.assistant-composer:focus-within { border-color: var(--color-primary); }
.assistant-composer :deep(.el-textarea__inner) { box-shadow: none; }
.assistant-composer > div:last-child { display: flex; align-items: center; justify-content: space-between; padding: calc(var(--spacing-card) / 2); gap: var(--spacing-card); }
.assistant-composer small { color: var(--color-text-secondary); }
button:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
@media (max-width: 1180px) {
  .capability-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: calc(var(--spacing-card) / 2); }
  .capability-card { padding: calc(var(--spacing-card) / 2); }
}
@media (max-width: 600px) {
  .capability-cards { grid-template-columns: minmax(0, 1fr); }
  .assistant-welcome { padding: 0; }
  .action-card > header { flex-wrap: wrap; }
  .delegation-summary > div { grid-template-columns: minmax(0, 1fr); gap: calc(var(--spacing-card) / 4); }
  .action-diff-row { grid-template-columns: minmax(86px, .6fr) repeat(2, minmax(120px, 1fr)); }
  .assistant-input-area, .conversation-body, .conversation-header { padding: var(--spacing-card); }
  .assistant-composer > div:last-child { flex-wrap: wrap; }
}
</style>
