<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  ArrowDown,
  ArrowLeft,
  Close,
  CopyDocument,
  DataLine,
  Document,
  Lock,
  RefreshRight,
  Share,
} from '@element-plus/icons-vue'

import { AssistantMessageContent, RunTimeline, StatusTag } from '@dsh-work/ui-core'
import { useContentStore } from '@/stores/content'
import { useTaskStore } from '@/stores/tasks'
import type { Artifact, TaskSource } from '@/types/domain'
import { TaskComposer } from '@dsh-work/workbench-components'
import { downloadArtifactFile, notifyActionFailure } from '@/utils/feedback'

const route = useRoute()
const router = useRouter()
const taskStore = useTaskStore()
const contentStore = useContentStore()

const detailsOpen = ref(false)
const conversationScroll = ref<HTMLElement>()
const showJumpToLatest = ref(false)
const stopping = ref(false)

const task = computed(() => taskStore.getTask(String(route.params.id)))
/**
 * 归档只读态（design §2.7 / 3-T1 执行轨）：运行所属团队空间归档后，续写（发送消息）
 * 与重试入口隐藏；内容、来源与成果下载保持可读。个人空间不会命中（AC-23）。
 */
const workspaceArchived = computed(() => {
  const workspace = contentStore.workspaces.find(item => item.id === task.value?.workspaceId)
  return workspace?.type === 'team' && workspace.status === 'archived'
})
const canStop = computed(() => Boolean(
  task.value && ['queued', 'running', 'awaiting_approval'].includes(task.value.status),
))
const canRetry = computed(() => task.value && ['failed', 'cancelled'].includes(task.value.status)
  && (task.value.error?.retryable ?? true))
const canFollowUp = computed(() => !workspaceArchived.value)
const currentStep = computed(() =>
  task.value?.steps.find((step) => ['running', 'awaiting_approval'].includes(step.status)),
)
const lastAssistantMessageId = computed(() =>
  [...(task.value?.messages ?? [])].reverse().find((message) => message.role === 'assistant')?.id,
)

const sourceTypeLabels: Record<TaskSource['type'], string> = {
  knowledge: '企业知识',
  erp: '业务系统',
  mes: '生产系统',
  file: '上传文件',
}

function goBack() {
  if (window.history.length > 1) router.back()
  else void router.push('/workbench')
}

function scrollToBottom(behavior: 'auto' | 'smooth' = 'smooth') {
  const target = conversationScroll.value
  if (!target) return
  target.scrollTo({ top: target.scrollHeight, behavior })
  showJumpToLatest.value = false
}

function onConversationScroll() {
  const target = conversationScroll.value
  if (!target) return
  showJumpToLatest.value = target.scrollHeight - target.scrollTop - target.clientHeight > 180
}

async function stopCurrentRun() {
  if (!task.value || stopping.value) return
  try {
    await ElMessageBox.confirm(
      '停止后会终止本轮运行尝试，已有对话和执行记录仍会保留。',
      '停止本轮执行？',
      {
        confirmButtonText: '停止本轮执行',
        cancelButtonText: '继续等待',
        type: 'warning',
      },
    )
    stopping.value = true
    await taskStore.cancelTask(task.value.id)
    ElMessage.success('本轮执行已停止，对话记录已保留')
  } catch {
    // User cancelled the confirmation.
  } finally {
    stopping.value = false
  }
}

async function retryRun() {
  if (!task.value || workspaceArchived.value) return
  try {
    await taskStore.retryTask(task.value.id)
    ElMessage.success('已创建新的运行尝试')
  } catch (error) {
    notifyActionFailure('重新执行', `运行 ${task.value.id}`, error, '刷新对话状态；确认本轮仍为失败或已停止后再重试。')
  }
}

function copyAnswer(content: string) {
  void navigator.clipboard.writeText(content)
  ElMessage.success('回答已复制')
}

function copyConversationLink() {
  void navigator.clipboard.writeText(window.location.href)
  ElMessage.success('对话链接已复制')
}

function download(item: Artifact) {
  void downloadArtifactFile(item)
}

async function submitFollowUp(payload: { prompt: string; files: File[]; workspaceId: string }) {
  if (!task.value || workspaceArchived.value) return
  try {
    const nextTask = await taskStore.sendMessage(task.value.id, payload.prompt, payload.files)
    if (nextTask) await router.replace(`/conversations/${nextTask.id}`)
    await nextTick(() => scrollToBottom())
  } catch (error) {
    notifyActionFailure('发送消息', `对话“${task.value.title}”`, error, '检查输入和附件后重试；已有对话内容不会丢失。')
  }
}

async function initializeConversation() {
  await taskStore.load()
  await nextTick()
  scrollToBottom('auto')
}

onMounted(initializeConversation)

watch(
  [() => route.params.id, () => task.value?.messages.length, () => task.value?.status],
  async () => {
    await nextTick()
    if (!showJumpToLatest.value) scrollToBottom('smooth')
  },
)
</script>

<template>
  <div class="conversation-page">
    <div v-if="taskStore.loading && !task" class="conversation-state">
      <el-skeleton :rows="8" animated />
    </div>

    <el-result
      v-else-if="!task"
      class="conversation-state"
      icon="warning"
      title="未找到对话"
      sub-title="该对话可能已被删除，或当前角色无权访问。"
    >
      <template #extra>
        <el-button type="primary" @click="router.push('/workbench')">返回工作台</el-button>
      </template>
    </el-result>

    <template v-else>
      <header class="conversation-header">
        <div class="conversation-header__left">
          <button type="button" class="conversation-header__back" aria-label="返回" @click="goBack">
            <el-icon><ArrowLeft /></el-icon>
          </button>
          <h1>{{ task.title }}</h1>
          <span v-if="task.skill" class="conversation-skill">
            <span>Skill</span>{{ task.skill.name }} · v{{ task.skill.version }}
          </span>
        </div>
        <div class="conversation-header__actions">
          <StatusTag :status="task.status" dot />
          <el-button text :icon="DataLine" @click="detailsOpen = true">
            <span class="header-action-label">对话详情</span>
          </el-button>
          <el-button
            v-if="canRetry && !workspaceArchived"
            text
            :icon="RefreshRight"
            aria-label="重新执行本轮"
            @click="retryRun"
          />
        </div>
      </header>

      <main
        ref="conversationScroll"
        class="conversation-scroll"
        aria-label="对话内容"
        @scroll.passive="onConversationScroll"
      >
        <div class="conversation-thread">
          <article
            v-for="message in task.messages"
            :key="message.id"
            class="conversation-message"
            :class="`conversation-message--${message.role}`"
          >
            <template v-if="message.role === 'user'">
              <div class="user-message">
                <p>{{ message.content }}</p>
                <time>{{ message.createdAt }}</time>
              </div>
            </template>

            <template v-else>
              <div class="assistant-identity">
                <span class="assistant-avatar">d</span>
                <div>
                  <strong>dsh-work</strong>
                  <span v-if="message.id === lastAssistantMessageId && task.status === 'succeeded'">
                    已完成{{ task.duration ? ` · ${task.duration}` : '' }}
                  </span>
                  <span v-else>{{ message.createdAt }}</span>
                </div>
              </div>

              <div class="assistant-answer">
                <AssistantMessageContent :text="message.content" />

                <div
                  v-if="message.id === lastAssistantMessageId && task.artifacts.length"
                  class="answer-artifacts"
                >
                  <button
                    v-for="artifact in task.artifacts"
                    :key="artifact.id"
                    type="button"
                    @click="download(artifact)"
                  >
                    <span><el-icon><Document /></el-icon></span>
                    <span>
                      <strong>{{ artifact.name }}</strong>
                      <small>{{ artifact.size }} · V{{ artifact.version }}</small>
                    </span>
                    <el-icon><ArrowDown /></el-icon>
                  </button>
                </div>

                <div class="assistant-actions">
                  <button type="button" aria-label="复制回答" @click="copyAnswer(message.content)">
                    <el-icon><CopyDocument /></el-icon>
                  </button>
                  <button
                    type="button"
                    aria-label="复制对话链接"
                    @click="copyConversationLink"
                  >
                    <el-icon><Share /></el-icon>
                  </button>
                  <span class="assistant-run-meta">
                    {{ task.tokenUsage ? `${task.tokenUsage.toLocaleString()} Token` : '自动' }}
                    · {{ task.agentVersion.split('@')[0] }}
                  </span>
                </div>
              </div>
            </template>
          </article>

          <article
            v-if="['queued', 'running'].includes(task.status)"
            class="conversation-message conversation-message--assistant conversation-message--working"
          >
            <div class="assistant-identity">
              <span class="assistant-avatar">d</span>
              <div>
                <strong>dsh-work</strong>
                <span>正在处理</span>
              </div>
            </div>
            <div class="working-answer">
              <span class="working-dots"><i></i><i></i><i></i></span>
              <span>{{ currentStep?.title ?? '正在准备回答' }}</span>
              <button type="button" @click="detailsOpen = true">查看执行过程</button>
            </div>
          </article>

          <section v-if="task.status === 'awaiting_approval'" class="conversation-notice approval-notice">
            <span class="conversation-notice__icon"><el-icon><Lock /></el-icon></span>
            <div>
              <strong>正在确认本轮工具权限</strong>
              <p>{{ task.approval?.reason ?? '服务端正在校验本轮工具、角色和数据范围。' }}</p>
              <dl>
                <div><dt>对象</dt><dd class="mono">{{ task.approval?.object ?? '受控工具' }}</dd></div>
                <div><dt>范围</dt><dd>{{ task.approval?.dataScope ?? '当前用户授权范围' }}</dd></div>
              </dl>
              <p>{{ task.approval?.nextStep ?? '确认结果会自动更新，无需重复提交。' }}</p>
            </div>
            <StatusTag status="awaiting_approval" label="自动确认中" />
          </section>

          <section v-if="task.error" class="conversation-notice error-notice">
            <span class="conversation-notice__icon"><el-icon><Close /></el-icon></span>
            <div>
              <strong>{{ task.error.message }}</strong>
              <dl>
                <div><dt>对象</dt><dd>{{ task.error.object }}</dd></div>
                <div><dt>原因</dt><dd>{{ task.error.reason }}</dd></div>
              </dl>
              <p><strong>下一步：</strong>{{ task.error.suggestion }}</p>
              <code>{{ task.error.code }}</code>
            </div>
            <el-button
              v-if="task.error.retryable && !workspaceArchived"
              type="primary"
              plain
              :icon="RefreshRight"
              @click="retryRun"
            >
              重新执行本轮
            </el-button>
          </section>

          <div class="conversation-end" aria-hidden="true"></div>
        </div>
      </main>

      <div class="conversation-composer-dock">
        <button
          v-if="showJumpToLatest"
          class="jump-latest"
          type="button"
          @click="scrollToBottom()"
        >
          回到最新消息
          <el-icon><ArrowDown /></el-icon>
        </button>
        <div class="conversation-composer-dock__inner">
          <TaskComposer
            v-if="canFollowUp"
            compact
            :running="canStop"
            :stopping="stopping"
            @submit="submitFollowUp"
            @stop="stopCurrentRun"
          />
          <p v-else data-testid="conversation-archived-notice" class="conversation-archived-notice">
            该空间已归档，仅保留有权限的只读查看与下载；无法续写或重试。
          </p>
          <p>AI 生成内容可能存在误差，重要业务结论请结合来源与企业制度确认。</p>
        </div>
      </div>

      <el-drawer
        v-model="detailsOpen"
        class="conversation-drawer"
        title="对话详情"
        size="420px"
      >
        <section class="drawer-section">
          <h2>当前执行</h2>
          <dl class="run-facts">
            <div><dt>工作空间</dt><dd>{{ task.workspaceName }}</dd></div>
            <div><dt>会话</dt><dd class="mono">{{ task.sessionId }}</dd></div>
            <div><dt>运行</dt><dd class="mono">{{ task.id }}</dd></div>
            <div><dt>Agent</dt><dd class="mono">{{ task.agentVersion }}</dd></div>
          </dl>
        </section>

        <section class="drawer-section">
          <h2>本轮执行步骤</h2>
          <RunTimeline :steps="task.steps" />
        </section>

        <section class="drawer-section">
          <h2>数据来源</h2>
          <div v-if="task.sources.length" class="source-list">
            <article v-for="source in task.sources" :key="source.id">
              <span>{{ sourceTypeLabels[source.type] }}</span>
              <strong>{{ source.title }}</strong>
              <small v-if="source.version || source.effectiveAt">
                <template v-if="source.version">v{{ source.version }}</template>
                <template v-if="source.effectiveAt"> · {{ source.effectiveAt }} 生效</template>
                <template v-if="source.dataScope"> · {{ source.dataScope }}</template>
                <template v-if="source.synthetic"> · 合成测试数据</template>
              </small>
              <p>{{ source.description }}</p>
            </article>
          </div>
          <el-empty v-else :image-size="56" description="本轮暂未产生来源记录" />
        </section>

        <section class="drawer-section">
          <h2>成果文件</h2>
          <div v-if="task.artifacts.length" class="drawer-artifacts">
            <button
              v-for="artifact in task.artifacts"
              :key="artifact.id"
              type="button"
              @click="download(artifact)"
            >
              <el-icon><Document /></el-icon>
              <span><strong>{{ artifact.name }}</strong><small>{{ artifact.size }}</small></span>
            </button>
          </div>
          <el-empty v-else :image-size="56" description="本轮暂未生成成果" />
        </section>
      </el-drawer>

    </template>
  </div>
</template>

<style scoped>
.conversation-page {
  position: relative;
  height: 100vh;
  overflow: hidden;
  color: #242624;
  background: #fff;
}

.conversation-state {
  max-width: 860px;
  margin: 0 auto;
  padding: 120px 28px;
}

.conversation-header {
  position: absolute;
  z-index: 12;
  top: 0;
  right: 0;
  left: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 64px;
  gap: 18px;
  padding: 0 22px;
  border-bottom: 1px solid rgb(234 235 232 / 75%);
  background: rgb(255 255 255 / 90%);
  backdrop-filter: blur(12px);
}

.conversation-header__left,
.conversation-header__actions {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}

.conversation-header__left h1 {
  margin: 0;
  overflow: hidden;
  color: #242624;
  font-size: var(--dsh-font-size-body);
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conversation-skill {
  display: inline-flex;
  max-width: 260px;
  align-items: center;
  gap: 5px;
  overflow: hidden;
  padding: 4px 8px;
  border: 1px solid #c9e6d9;
  border-radius: 999px;
  color: #23644f;
  background: #f0faf5;
  font-size: var(--dsh-font-size-micro);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conversation-skill span { color: #6d9586; }

.conversation-header__back {
  display: grid;
  width: 31px;
  height: 31px;
  flex: 0 0 auto;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: 8px;
  color: #686d68;
  background: transparent;
  cursor: pointer;
}

.conversation-header__back:hover {
  color: #222422;
  background: #f1f2f0;
}

.conversation-header__actions {
  flex: 0 0 auto;
}

.conversation-scroll {
  height: 100vh;
  padding: 94px 28px 226px;
  overflow-y: auto;
  scroll-behavior: smooth;
  scrollbar-gutter: stable;
}

.conversation-thread {
  width: min(100%, 920px);
  min-height: calc(100vh - 330px);
  margin: 0 auto;
}

.conversation-message {
  width: 100%;
}

.conversation-message + .conversation-message {
  margin-top: 30px;
}

.conversation-message--user {
  display: flex;
  justify-content: flex-end;
  padding-left: 20%;
}

.user-message {
  max-width: 72%;
  color: #303330;
  text-align: right;
}

.user-message p {
  margin: 0;
  padding: 10px 14px;
  border-radius: 14px 14px 4px 14px;
  background: #f1f2f0;
  font-size: var(--dsh-font-size-body);
  line-height: 1.65;
  text-align: left;
  white-space: pre-wrap;
}

.user-message time {
  display: block;
  margin-top: 5px;
  color: #a0a39f;
  font-size: var(--dsh-font-size-micro);
}

.assistant-identity {
  display: flex;
  align-items: center;
  gap: 9px;
}

.assistant-avatar {
  display: grid;
  width: 25px;
  height: 25px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 8px;
  color: #fff;
  background: #3e5f55;
  font-size: var(--dsh-font-size-body);
  font-weight: 750;
}

.assistant-identity > div {
  display: flex;
  flex-direction: column;
}

.assistant-identity strong {
  color: #292c29;
  font-size: var(--dsh-font-size-caption);
  font-weight: 650;
}

.assistant-identity span:not(.assistant-avatar) {
  margin-top: 2px;
  color: #9a9e9a;
  font-size: var(--dsh-font-size-micro);
}

.working-answer {
  margin: 13px 0 0 34px;
}

.assistant-answer {
  margin: 12px 0 0 34px;
  padding: 16px 18px 12px;
  border: 1px solid #e8ebe8;
  border-radius: 14px;
  background: #fcfdfc;
}

.assistant-answer :deep(.assistant-message-content) {
  color: #303430;
}

.assistant-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  min-height: 31px;
  margin-top: 15px;
  padding-top: 8px;
  border-top: 1px solid #edf0ed;
  color: #888d88;
}

.assistant-actions button {
  display: grid;
  width: 27px;
  height: 27px;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: 7px;
  color: #7e837e;
  background: transparent;
  cursor: pointer;
}

.assistant-actions button:hover {
  color: #175e4d;
  background: #eff6f3;
}

.assistant-run-meta {
  margin-left: 7px;
  color: #949994;
  font-size: var(--dsh-font-size-micro);
}

.answer-artifacts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}

.answer-artifacts button {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) 16px;
  align-items: center;
  min-width: 230px;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid #e2e4e1;
  border-radius: 10px;
  color: #4c514c;
  background: #fafbfa;
  cursor: pointer;
  text-align: left;
}

.answer-artifacts button:hover {
  border-color: #bdcbc5;
  background: #f5f8f6;
}

.answer-artifacts button > span:first-child {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border-radius: 8px;
  color: #356858;
  background: #eaf4f0;
}

.answer-artifacts button > span:nth-child(2) {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.answer-artifacts strong {
  overflow: hidden;
  font-size: var(--dsh-font-size-badge);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.answer-artifacts small {
  margin-top: 3px;
  color: #939793;
  font-size: var(--dsh-font-size-micro);
}

.working-answer {
  display: flex;
  align-items: center;
  min-height: 42px;
  gap: 10px;
  color: #6e746f;
  font-size: var(--dsh-font-size-caption);
}

.working-answer > button {
  margin-left: auto;
  padding: 0;
  border: 0;
  color: #34705f;
  background: transparent;
  cursor: pointer;
  font-size: var(--dsh-font-size-badge);
}

.working-dots {
  display: flex;
  gap: 3px;
}

.working-dots i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #67a997;
  animation: working-pulse 1s ease-in-out infinite;
}

.working-dots i:nth-child(2) {
  animation-delay: 120ms;
}

.working-dots i:nth-child(3) {
  animation-delay: 240ms;
}

@keyframes working-pulse {
  0%,
  100% {
    transform: translateY(0);
    opacity: 0.4;
  }

  50% {
    transform: translateY(-3px);
    opacity: 1;
  }
}

.conversation-notice {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  align-items: start;
  gap: 12px;
  margin: 36px 0 0 34px;
  padding: 14px;
  border: 1px solid #efd7b1;
  border-radius: 12px;
  background: #fff9ef;
}

.conversation-notice__icon {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 9px;
  color: #9e5b12;
  background: #ffedcf;
}

.conversation-notice strong {
  font-size: var(--dsh-font-size-caption);
}

.conversation-notice p {
  margin: 5px 0 0;
  color: #767069;
  font-size: var(--dsh-font-size-badge);
  line-height: 1.6;
}

.conversation-notice dl {
  display: flex;
  gap: 20px;
  margin: 9px 0 0;
}

.conversation-notice dl div {
  display: flex;
  gap: 6px;
}

.conversation-notice dt,
.conversation-notice dd {
  margin: 0;
  font-size: var(--dsh-font-size-micro);
}

.conversation-notice dt {
  color: #9b8a74;
}

.conversation-notice__actions {
  display: flex;
  gap: 7px;
}

.error-notice {
  border-color: #efc8cc;
  background: #fff5f6;
}

.error-notice .conversation-notice__icon {
  color: #a92e3c;
  background: #ffe2e5;
}

.error-notice code {
  display: inline-block;
  margin-top: 7px;
  color: #9b3c47;
  font-size: var(--dsh-font-size-micro);
}

.conversation-end {
  height: 12px;
}

.conversation-composer-dock {
  position: absolute;
  z-index: 11;
  right: 0;
  bottom: 0;
  left: 0;
  padding: 48px 28px 13px;
  background: linear-gradient(to bottom, rgb(255 255 255 / 0%), #fff 31%, #fff 100%);
  pointer-events: none;
}

.conversation-composer-dock__inner {
  width: min(100%, 920px);
  margin: 0 auto;
  pointer-events: auto;
}

.conversation-composer-dock__inner > p {
  margin: 7px 0 0;
  color: #aaada9;
  font-size: var(--dsh-font-size-micro);
  text-align: center;
}

/* 归档只读态：以提示替代续写输入，避免提交后才被服务端拒绝（design §2.7）。 */
.conversation-composer-dock__inner > p.conversation-archived-notice {
  margin-top: 0;
  padding: 12px 16px;
  border: 1px solid #f0d9b5;
  border-radius: 12px;
  color: #8a5a1e;
  background: #fdf6ec;
  font-size: var(--dsh-font-size-caption);
}

.conversation-composer-dock :deep(.composer__surface) {
  border-color: #dedfdd;
  border-radius: 15px;
  box-shadow: 0 9px 28px rgb(28 31 28 / 7%);
}

.conversation-composer-dock :deep(.composer__input) {
  min-height: 76px;
  font-size: var(--dsh-font-size-body);
}

.jump-latest {
  display: flex;
  align-items: center;
  width: max-content;
  min-height: 29px;
  gap: 5px;
  margin: 0 auto 9px;
  padding: 0 10px;
  border: 1px solid #dedfdd;
  border-radius: 999px;
  color: #626762;
  background: #fff;
  box-shadow: 0 5px 16px rgb(25 30 26 / 7%);
  cursor: pointer;
  font-size: var(--dsh-font-size-micro);
  pointer-events: auto;
}

.drawer-section + .drawer-section {
  margin-top: 28px;
}

.drawer-section h2 {
  margin: 0 0 12px;
  color: #272a27;
  font-size: var(--dsh-font-size-body);
}

.run-facts {
  margin: 0;
  padding: 3px 12px;
  border: 1px solid #e5e7e4;
  border-radius: 10px;
  background: #fafbfa;
}

.run-facts div {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  padding: 10px 0;
  border-bottom: 1px solid #eceeeb;
}

.run-facts div:last-child {
  border-bottom: 0;
}

.run-facts dt,
.run-facts dd {
  margin: 0;
  font-size: var(--dsh-font-size-badge);
}

.run-facts dt {
  color: #8a8f8a;
}

.run-facts dd {
  color: #424742;
  text-align: right;
}

.source-list {
  display: grid;
  gap: 8px;
}

.source-list article {
  padding: 11px;
  border: 1px solid #e5e7e4;
  border-radius: 9px;
}

.source-list article > span {
  color: #4c806f;
  font-size: var(--dsh-font-size-micro);
  font-weight: 650;
}

.source-list strong {
  display: block;
  margin-top: 4px;
  color: #343834;
  font-size: var(--dsh-font-size-badge);
}

.source-list small {
  display: block;
  margin-top: 4px;
  color: var(--color-text-muted);
  font-size: var(--font-size-badge);
  line-height: 1.5;
}

.source-list p {
  margin: 5px 0 0;
  color: #828782;
  font-size: var(--dsh-font-size-micro);
  line-height: 1.5;
}

.drawer-artifacts {
  display: grid;
  gap: 8px;
}

.drawer-artifacts button {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px;
  border: 1px solid #e5e7e4;
  border-radius: 9px;
  color: #48695e;
  background: #fff;
  cursor: pointer;
  text-align: left;
}

.drawer-artifacts button > span {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
}

.drawer-artifacts strong {
  overflow: hidden;
  color: #343834;
  font-size: var(--dsh-font-size-badge);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drawer-artifacts small {
  margin-top: 3px;
  color: #929692;
  font-size: var(--dsh-font-size-micro);
}

@media (max-width: 720px) {
  .conversation-header {
    min-height: 58px;
    padding: 0 10px 0 52px;
  }

  .conversation-header__back {
    display: none;
  }

  .conversation-header__actions {
    gap: 0;
  }

  .conversation-header__actions .status-tag,
  .header-action-label {
    display: none;
  }

  .conversation-scroll {
    padding: 78px 14px 218px;
  }

  .conversation-message--user {
    padding-left: 12%;
  }

  .user-message {
    max-width: 88%;
  }

  .assistant-answer,
  .working-answer {
    margin-left: 0;
  }

  .assistant-answer {
    padding: 14px 14px 10px;
  }

  .assistant-answer :deep(.assistant-message-content) {
    font-size: var(--dsh-font-size-caption);
  }

  .conversation-notice {
    grid-template-columns: 30px minmax(0, 1fr);
    margin-left: 0;
  }

  .conversation-notice__actions,
  .conversation-notice > .el-button {
    grid-column: 1 / -1;
    justify-self: end;
  }

  .conversation-notice dl {
    flex-direction: column;
    gap: 5px;
  }

  .conversation-composer-dock {
    padding: 40px 10px 9px;
  }

  .conversation-composer-dock :deep(.composer__input) {
    min-height: 70px;
  }

  .assistant-run-meta {
    display: none;
  }

  .answer-artifacts button {
    width: 100%;
  }
}
</style>
