<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ChatDotRound, Check, Cpu, Document, Grid, Right, VideoPause } from '@element-plus/icons-vue'
import { useRoute, useRouter } from 'vue-router'
import { AssistantMessageContent } from '@dsh-work/ui-core'
import SkillPackagePreview from '@/components/SkillPackagePreview.vue'
import { useAdminAssistantStore } from '@/stores/admin-assistant'
import { useAuthStore } from '@/stores/auth'
import type { SkillInstallation } from '@/types/assistant'

const auth = useAuthStore()
const assistant = useAdminAssistantStore()
const route = useRoute()
const router = useRouter()
const composer = ref<{ focus: () => void }>()
const messageList = ref<HTMLElement>()
const busy = computed(() => assistant.busyIds.includes(assistant.selectedId))
const activeRun = computed(() => [...assistant.current.runs].reverse().find(run => ['queued', 'running', 'cancel_requested'].includes(run.status)))
const statuses: Record<string, string> = { queued: '等待执行', running: '正在检查来源与包内容', cancel_requested: '正在取消', succeeded: '处理完成', failed: '处理失败', cancelled: '已取消' }
const installationFor = (runId: string) => assistant.current.installations.find(item => item.runId === runId)
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
  await assistant.send()
  if (assistant.current.saved && route.query.conversation !== assistant.selectedId) await router.replace({ path: '/assistant', query: { conversation: assistant.selectedId } })
  await nextTick()
  messageList.value?.scrollTo({ top: messageList.value.scrollHeight, behavior: 'smooth' })
}
async function stop() {
  if (!activeRun.value || activeRun.value.status === 'cancel_requested') return
  await assistant.cancel(activeRun.value.id)
}
async function confirmInstallation(runId: string, planSha256: string) {
  await assistant.confirm(runId, planSha256)
  await nextTick()
  messageList.value?.scrollTo({ top: messageList.value.scrollHeight, behavior: 'smooth' })
}
</script>

<template>
  <div class="ops-page assistant-page">
    <div class="assistant-notice"><el-tag type="success" effect="plain">Skill 安装</el-tag><span>安装已有 Skill，先检查来源与包内容，确认后保存待验证版本。Agent 管理与运维对话暂未接入。</span></div>
    <el-alert v-if="assistant.error" :title="assistant.error" type="error" show-icon :closable="false"><el-button link type="primary" @click="assistant.current.saved ? assistant.refresh() : assistant.load()">重新连接</el-button></el-alert>
    <div class="assistant-workspace">
      <section class="content-panel assistant-conversation" aria-label="管理助手对话" :aria-busy="busy || assistant.active">
        <header class="conversation-header"><span class="assistant-avatar"><el-icon><ChatDotRound /></el-icon></span><div><strong>统一管理入口</strong><small>Skill 安装</small></div><el-tag type="info" effect="plain">{{ assistant.active ? '处理中' : '变更需确认' }}</el-tag></header>
        <div ref="messageList" class="conversation-body" v-loading="assistant.loading">
          <div v-if="!assistant.current.messages.length" class="assistant-welcome">
            <h2>今天要处理什么管理工作？</h2><p>提供已有 Skill 的来源，查看真实包信息后确认安装。</p>
            <div class="capability-cards">
              <button class="capability-card" type="button" :disabled="!auth.canManage" @click="prepare('安装这个已有 Skill：')"><el-icon><Document /></el-icon><strong>Skill 管理</strong><span>支持 HTTPS、GitHub 和已适配的 npx / curl 命令</span><small>安装已有 Skill <el-icon><Right /></el-icon></small></button>
              <button class="capability-card" type="button" disabled><el-icon><Grid /></el-icon><strong>Agent 管理</strong><span>查询配置，准备能力与权限变更</span><small>尚未接入</small></button>
              <button class="capability-card" type="button" disabled><el-icon><Cpu /></el-icon><strong>平台运维</strong><span>检查系统健康，处理运行与调度问题</span><small>尚未接入</small></button>
            </div>
            <div class="assistant-boundary"><el-icon><Check /></el-icon><span>仅安装已有内容，不通过对话编写 Skill。安装成功后仍需验证和发布。</span></div>
          </div>
          <div v-else class="assistant-messages" role="log" aria-label="管理对话记录" aria-live="polite">
            <div v-for="run in assistant.current.runs" :key="run.id" class="assistant-run">
              <article v-for="message in assistant.current.messages.filter(item => item.runId === run.id)" :key="message.id" class="assistant-message" :class="message.role"><strong class="message-author">{{ message.role === 'user' ? '你' : '管理助手' }}</strong><AssistantMessageContent :text="message.text" /></article>
              <div class="run-status" role="status"><el-tag :type="run.status === 'failed' ? 'danger' : 'info'">{{ statuses[run.status] }}</el-tag><span v-if="run.error">{{ run.error }}</span><el-button v-if="auth.canManage && ['failed', 'cancelled'].includes(run.status)" link type="primary" :disabled="busy" @click="assistant.retry(run.id)">重试</el-button></div>
              <div v-if="installationFor(run.id)" class="action-card">
                <header><div><h3>{{ installationFor(run.id)!.status === 'installed' ? installationFor(run.id)!.resultType === 'duplicate' ? 'Skill 已存在' : 'Skill 已安装' : installationFor(run.id)!.status === 'cancelled' ? '安装已取消' : '确认安装已有 Skill' }}</h3><p>安装结果以管理助手回复和此操作卡片为准，不自动发布或修改已有 Agent 引用。</p></div></header>
                <div v-if="installationFor(run.id)!.status === 'installed'" class="action-result" role="status"><span class="result-icon"><el-icon><Check /></el-icon></span><div><strong>{{ installedTitle(installationFor(run.id)!) }}</strong><p>{{ installedDescription(installationFor(run.id)!) }}</p></div><el-button type="primary" plain @click="router.push('/capabilities')">{{ installationFor(run.id)!.resultType === 'duplicate' ? '前往 Skill 中心查看' : '前往 Skill 中心验证并发布' }}</el-button></div>
                <SkillPackagePreview v-if="installationFor(run.id)!.status === 'pending' && installationFor(run.id)!.package" :source="installationFor(run.id)!.resolvedUrl ?? installationFor(run.id)!.source" :package="installationFor(run.id)!.package!" :plan="installationFor(run.id)!.plan" :resolved-ref="installationFor(run.id)!.resolvedRef ?? undefined" />
                <el-collapse v-else-if="installationFor(run.id)!.status === 'installed' && installationFor(run.id)!.package" class="installed-plan"><el-collapse-item title="查看已确认的安装计划" name="plan"><SkillPackagePreview :source="installationFor(run.id)!.resolvedUrl ?? installationFor(run.id)!.source" :package="installationFor(run.id)!.package!" :plan="installationFor(run.id)!.plan" :resolved-ref="installationFor(run.id)!.resolvedRef ?? undefined" /></el-collapse-item></el-collapse>
                <footer v-if="installationFor(run.id)!.status === 'pending' && auth.canManage"><span>一次确认根 Skill、全部依赖和权限摘要</span><el-button :disabled="busy" @click="assistant.cancel(run.id)">取消安装</el-button><el-button type="primary" :loading="busy" :disabled="run.status !== 'succeeded' || !installationFor(run.id)!.planSha256 || installationFor(run.id)!.compatibilityStatus === 'incompatible'" @click="confirmInstallation(run.id, installationFor(run.id)!.planSha256!)">确认安装计划</el-button></footer>
              </div>
            </div>
          </div>
        </div>
        <footer class="assistant-input-area">
          <template v-if="auth.canManage">
            <div class="source-shortcuts"><span>输入形式</span><el-button link type="primary" @click="prepare('https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines')">外部链接</el-button><el-button link type="primary" @click="prepare('npx skills add vercel-labs/agent-skills --skill web-design-guidelines')">npx</el-button><el-button link type="primary" @click="prepare('curl -L https://raw.githubusercontent.com/vercel-labs/agent-skills/main/skills/web-design-guidelines/SKILL.md')">curl</el-button></div>
            <form class="assistant-composer" @submit.prevent="send()"><el-input ref="composer" v-model="assistant.current.draft" type="textarea" :rows="3" resize="none" maxlength="20000" aria-label="管理需求" placeholder="粘贴已有 Skill 的链接或受支持的安装命令…" @keydown.ctrl.enter.prevent="send" @keydown.meta.enter.prevent="send" /><div><small>Ctrl / ⌘ + Enter 发送</small><el-button v-if="activeRun" type="danger" native-type="button" :icon="VideoPause" :loading="busy || activeRun.status === 'cancel_requested'" :disabled="activeRun.status === 'cancel_requested'" :aria-label="activeRun.status === 'cancel_requested' ? '正在停止处理' : '停止处理'" @click="stop">{{ activeRun.status === 'cancel_requested' ? '正在停止' : '停止' }}</el-button><el-button v-else type="primary" native-type="submit" :icon="Right" :loading="busy" :disabled="!assistant.current.draft.trim()">发送</el-button></div></form>
          </template>
          <p v-else>当前为只读权限，可查看已有对话，不能发送安装请求或确认变更。</p>
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
.capability-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--spacing-card); }
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
.result-icon { display: grid; place-items: center; flex: 0 0 auto; width: calc(var(--spacing-section) * 2); height: calc(var(--spacing-section) * 2); border-radius: 50%; color: var(--color-success-strong); background: var(--color-bg-base); font-size: var(--font-size-heading); }
.installed-plan { margin-top: var(--spacing-card); }
.action-card footer { display: flex; justify-content: flex-end; align-items: center; flex-wrap: wrap; gap: calc(var(--spacing-card) / 2); border-top: 1px solid var(--color-border); padding-top: var(--spacing-card); margin-top: var(--spacing-card); }
.action-card footer span { margin-right: auto; color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.action-card footer .el-button + .el-button { margin-left: 0; }
.action-unavailable { color: var(--color-warning-strong); }
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
  .capability-cards { gap: calc(var(--spacing-card) / 2); }
  .capability-card { padding: calc(var(--spacing-card) / 2); }
}
@media (max-width: 600px) {
  .capability-cards { grid-template-columns: minmax(0, 1fr); }
  .assistant-welcome { padding: 0; }
  .action-card > header { flex-wrap: wrap; }
  .assistant-input-area, .conversation-body, .conversation-header { padding: var(--spacing-card); }
  .assistant-composer > div:last-child { flex-wrap: wrap; }
}
</style>
