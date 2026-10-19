<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'

import AgentAccessPanel from '@/components/AgentAccessPanel.vue'
import AgentCapabilitySection from '@/components/agent-detail/AgentCapabilitySection.vue'
import AgentProfileSection from '@/components/agent-detail/AgentProfileSection.vue'
import AgentReleasePanel from '@/components/agent-detail/AgentReleasePanel.vue'
import { adminApi } from '@/api/client'
import { provideAgentDraftEditor, validateAgentDraft, type AgentDraftField } from '@/composables/use-agent-draft'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import type { AgentAccess } from '@/types/domain'
import { activeVersionOf, pendingVersionOf, type AgentDraftStep } from '@/utils/agent-status'

/**
 * 草稿编辑流程：按步骤完成版本内容（职责与人格、能力）、首次发布前的角色与权限，再验证与发布。
 * 与只读详情页分开，草稿保存状态只在这里出现。
 */
const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const contentStore = useContentStore()
const ready = ref(false)
const accessDrawerOpen = ref(false)
const releasePanel = ref<InstanceType<typeof AgentReleasePanel>>()
const audiencePanel = ref<InstanceType<typeof AgentAccessPanel>>()
const stepSaving = ref(false)
/** 从未发布的 Agent 的岗位权限快照，用于判断「角色与权限」是否已完成（可见角色与岗位角色必填）。 */
const accessSnapshot = ref<AgentAccess>()

const agentId = computed(() => String(route.params.agentId ?? ''))
const agent = computed(() => contentStore.agents.find(item => item.id === agentId.value))
const activeVersion = computed(() => activeVersionOf(agent.value))
const pendingVersion = computed(() => pendingVersionOf(agent.value, contentStore.agentVersions))
const loadFailed = computed(() => Boolean(contentStore.error) && !agent.value)
const canManage = computed(() => authStore.canManage)
const editor = provideAgentDraftEditor(agent, { canEdit: canManage })

const profileFields: AgentDraftField[] = ['name', 'description', 'welcomeMessage', 'systemPrompt', 'workInstructions', 'examplePrompts']
const capabilityFields: AgentDraftField[] = ['skills', 'mcpScope', 'timeoutSeconds', 'maxToolCalls', 'maxOutputBytes']
const draftErrors = computed(() => validateAgentDraft(editor.form))
const accessComplete = computed(() => Boolean(accessSnapshot.value?.visibleRoleIds.length && accessSnapshot.value.roleIds.length))

/** 「角色与权限」只在从未发布时作为一步出现；已发布 Agent 在详情页岗位权限中修改。 */
const steps = computed(() => {
  const list: Array<{ id: AgentDraftStep; label: string; hint: string; state: 'done' | 'todo' | 'error' | 'none' }> = [
    { id: 'profile', label: '职责与人格', hint: '名称、说明、SOUL.md 与示例问题',
      state: profileFields.some(field => draftErrors.value[field]) ? 'error' : 'done' },
    { id: 'capabilities', label: '能力', hint: 'Skill、MCP 与运行限制',
      state: capabilityFields.some(field => draftErrors.value[field]) ? 'error' : 'done' },
  ]
  if (!activeVersion.value) {
    list.push({ id: 'audience', label: '角色与权限', hint: '谁能使用它、它持有的岗位角色', state: accessComplete.value ? 'done' : 'todo' })
  }
  list.push({ id: 'release', label: '验证与发布', hint: '运行案例、判定并发布', state: 'none' })
  return list
})
const stateText: Record<string, string> = { done: '已完成', todo: '待设置', error: '需修正', none: '' }

const currentStep = computed<AgentDraftStep>(() => {
  const value = String(route.query.step ?? '')
  return steps.value.some(step => step.id === value) ? value as AgentDraftStep : 'profile'
})
const currentIndex = computed(() => steps.value.findIndex(step => step.id === currentStep.value))
const previousStep = computed(() => steps.value[currentIndex.value - 1])
const nextStep = computed(() => steps.value[currentIndex.value + 1])
const visitedSteps = ref(new Set<AgentDraftStep>())
watch(currentStep, step => visitedSteps.value.add(step), { immediate: true })

const editingLabel = computed(() => {
  const pending = pendingVersion.value
  const base = activeVersion.value ? `基于 v${activeVersion.value}` : '尚未发布'
  if (!pending) return `${base} · 修改后自动生成新草稿`
  if (pending.status === 'candidate') return `待发布 v${pending.version}（已冻结） · ${base} · 修改会生成新草稿`
  return `草稿 v${pending.version} · ${base}`
})

const saveStatus = computed(() => {
  switch (editor.state.value) {
    case 'pending': return { type: 'info', text: '有未保存的修改' }
    case 'saving': return { type: 'info', text: '保存中…' }
    case 'invalid': return { type: 'warning', text: '内容不完整，未保存' }
    case 'conflict': return { type: 'danger', text: '已被其他操作修改' }
    case 'error': return { type: 'danger', text: '保存失败' }
    default: return { type: 'success', text: editor.savedAt.value ? '已保存' : '草稿与服务端一致' }
  }
})

/** 读取失败时返回 false：不据此拦截，由服务端验证前检查兜底。 */
async function loadAccessSnapshot(): Promise<boolean> {
  if (activeVersion.value || !agentId.value) return true
  try {
    accessSnapshot.value = await adminApi.getAgentAccess(agentId.value)
    return true
  } catch {
    accessSnapshot.value = undefined
    return false
  }
}

function onAccessUpdated(value: AgentAccess) {
  accessSnapshot.value = value
  void contentStore.load(true)
}

/**
 * 「角色与权限」与其他步骤一样没有单独的保存按钮：离开这一步时保存，保存失败则停留在本步。
 * 向后前进时先检查必填（可见角色、岗位角色），返回上一步或退出时只保存、不拦截。
 */
async function saveAudience(forward: boolean): Promise<boolean> {
  const panel = audiencePanel.value
  if (currentStep.value !== 'audience' || !canManage.value || !panel) return true
  if (forward && !panel.validateRequired()) return false
  stepSaving.value = true
  try {
    return await panel.save({ confirm: false })
  } finally {
    stepSaving.value = false
  }
}

async function goToStep(step: AgentDraftStep) {
  if (step === currentStep.value) return
  const ids = steps.value.map(item => item.id)
  const forward = ids.indexOf(step) > ids.indexOf(currentStep.value)
  if (!await saveAudience(forward)) return
  // 从未发布的 Agent 必须先完成角色与权限，才能进入验证与发布。
  if (step === 'release' && currentStep.value !== 'audience' && canManage.value && !activeVersion.value) {
    const loaded = await loadAccessSnapshot()
    if (loaded && !accessComplete.value) {
      ElMessage.warning('请先在「角色与权限」中选择可见角色和岗位角色')
      await router.replace({ query: { ...route.query, step: 'audience' } })
      return
    }
  }
  await router.replace({ query: { ...route.query, step } })
}

function exitDraft() {
  void router.push({ name: 'agent-detail', params: { agentId: agentId.value } })
}

async function reloadDraft() {
  await contentStore.load(true)
  editor.reload()
}

async function reloadAgent() {
  contentStore.error = ''
  await contentStore.load(true)
}

function onAccessDrawerClosed() {
  void contentStore.load(true)
  void loadAccessSnapshot()
  releasePanel.value?.reload()
}

function onPublished(version: string) {
  ElMessage.success(`发布完成：v${version} 已成为当前版本`)
  void router.push({ name: 'agent-detail', params: { agentId: agentId.value }, query: { section: 'versions' } })
}

function warnBeforeUnload(event: BeforeUnloadEvent) {
  if (editor.hasUnsavedChanges.value) event.preventDefault()
}

/** 离开草稿流程或切换 Agent 前先保存；内容不合法时确认是否放弃。 */
async function guardLeave() {
  if (!await saveAudience(false)) return false
  await editor.flush()
  if (editor.state.value !== 'invalid' && editor.state.value !== 'error') return true
  try {
    await ElMessageBox.confirm(
      editor.state.value === 'invalid' ? '有内容不符合要求，离开后这些修改不会保存。' : '最近的修改保存失败，离开后不会保存。',
      '放弃未保存的修改？',
      { confirmButtonText: '放弃修改', cancelButtonText: '继续编辑', type: 'warning' },
    )
    return true
  } catch {
    return false
  }
}

onBeforeRouteLeave(guardLeave)
onBeforeRouteUpdate(async (to, from) => (to.params.agentId === from.params.agentId ? true : guardLeave()))

watch(currentStep, async (_next, previous) => {
  // 切到其他步骤（尤其是验证与发布）前先保存草稿，让检查与案例基于最新内容。
  if (previous === 'profile' || previous === 'capabilities') await editor.flush()
})

onMounted(async () => {
  window.addEventListener('beforeunload', warnBeforeUnload)
  await contentStore.load()
  await loadAccessSnapshot()
  ready.value = true
})
onBeforeUnmount(() => window.removeEventListener('beforeunload', warnBeforeUnload))
</script>

<template>
  <div class="ops-page agent-detail-page agent-draft-page">
    <el-alert v-if="contentStore.error" :title="contentStore.error" type="error" show-icon @close="contentStore.error = ''" />

    <section v-if="!ready || (contentStore.loading && !agent)" class="content-panel draft-placeholder">
      <el-skeleton :rows="6" animated />
    </section>

    <section v-else-if="loadFailed" class="content-panel draft-placeholder">
      <el-result icon="error" title="Agent 加载失败" :sub-title="contentStore.error || '管理数据暂时无法读取。'">
        <template #extra>
          <el-button type="primary" @click="reloadAgent">重试</el-button>
          <el-button @click="router.push('/agents')">返回 Agent 管理</el-button>
        </template>
      </el-result>
    </section>

    <section v-else-if="!agent" class="content-panel draft-placeholder">
      <el-result icon="warning" title="未找到 Agent" sub-title="该 Agent 可能已被移除。">
        <template #extra><el-button type="primary" @click="router.push('/agents')">返回 Agent 管理</el-button></template>
      </el-result>
    </section>

    <template v-else>
      <header class="content-panel draft-hero">
        <div class="draft-hero__title">
          <span class="draft-hero__eyebrow">{{ canManage ? '编辑草稿' : '查看待发布版本' }}</span>
          <h2>{{ agent.name }}</h2>
          <p data-testid="draft-version-label">{{ editingLabel }}</p>
        </div>
        <div class="draft-hero__actions">
          <span v-if="canManage" class="save-status" :class="`save-status--${saveStatus.type}`" data-testid="draft-save-status" role="status" aria-live="polite">{{ saveStatus.text }}</span>
          <el-button v-if="editor.state.value === 'conflict'" size="small" @click="reloadDraft">重新载入</el-button>
          <el-button data-action="exit-draft" @click="exitDraft">{{ canManage ? '退出编辑' : '返回详情' }}</el-button>
        </div>
      </header>
      <el-alert v-if="canManage && editor.message.value && (editor.state.value === 'conflict' || editor.state.value === 'error' || editor.state.value === 'invalid')" :type="editor.state.value === 'invalid' ? 'warning' : 'error'" :closable="false" show-icon :title="editor.message.value" />
      <el-alert v-if="authStore.isAuditor" type="info" show-icon :closable="false" title="当前为安全审计员视图，只能查看，不能修改。" />

      <div class="draft-layout">
        <nav class="content-panel draft-steps" aria-label="编辑步骤">
          <ol>
            <li v-for="(step, index) in steps" :key="step.id">
              <button
                type="button"
                class="draft-step"
                :class="[`draft-step--${step.state}`, { 'draft-step--current': step.id === currentStep }]"
                :aria-current="step.id === currentStep ? 'step' : undefined"
                :aria-label="`${index + 1}. ${step.label}${stateText[step.state] ? `，${stateText[step.state]}` : ''}`"
                @click="goToStep(step.id)"
              >
                <span class="draft-step__index" aria-hidden="true">{{ step.state === 'done' && step.id !== currentStep ? '✓' : index + 1 }}</span>
                <span class="draft-step__text">
                  <strong>{{ step.label }}</strong>
                  <small>{{ stateText[step.state] || step.hint }}</small>
                </span>
              </button>
            </li>
          </ol>
          <p class="draft-steps__note">职责、能力属于版本，验证并发布后才对员工生效。岗位权限、主动任务属于 Agent，在详情页修改立即生效。</p>
        </nav>

        <main class="draft-main">
          <div v-show="currentStep === 'profile'" class="content-panel draft-card"><AgentProfileSection /></div>
          <div v-show="currentStep === 'capabilities'" class="content-panel draft-card"><AgentCapabilitySection /></div>
          <div v-if="currentStep === 'audience'" class="content-panel draft-card">
            <section class="detail-section" aria-label="角色与权限">
              <header class="detail-section__head"><div><h3>角色与权限</h3><p>选择谁能使用它、它持有的岗位角色和可接触的数据范围，进入下一步时保存。发布后在详情页「岗位权限」调整。</p></div></header>
              <AgentAccessPanel ref="audiencePanel" :agent-id="agent.id" :can-manage="canManage" embedded @updated="onAccessUpdated" />
            </section>
          </div>
          <AgentReleasePanel
            v-if="visitedSteps.has('release')"
            v-show="currentStep === 'release'"
            ref="releasePanel"
            :agent-id="agent.id"
            :active="currentStep === 'release'"
            @open-access="accessDrawerOpen = true"
            @edit="goToStep('profile')"
            @published="onPublished"
          />

          <footer class="draft-footer">
            <el-button v-if="previousStep" data-action="previous-step" @click="goToStep(previousStep.id)">上一步：{{ previousStep.label }}</el-button>
            <span class="draft-footer__spacer" />
            <el-button v-if="nextStep" type="primary" :loading="stepSaving" data-action="next-step" @click="goToStep(nextStep.id)">下一步：{{ nextStep.label }}</el-button>
          </footer>
        </main>
      </div>

      <el-drawer v-model="accessDrawerOpen" title="岗位权限" size="min(720px, 100vw)" append-to-body @closed="onAccessDrawerClosed">
        <p class="drawer-intro">属于 Agent 而非版本，保存后立即生效，不需要重新验证；关闭后验证前检查会重新读取。</p>
        <AgentAccessPanel v-if="accessDrawerOpen" :agent-id="agent.id" :can-manage="canManage" @updated="contentStore.load(true)" />
      </el-drawer>
    </template>
  </div>
</template>

<style scoped>
.agent-draft-page { width: 100%; gap: 10px; }
.draft-placeholder { min-height: 320px; padding: 24px; }
.draft-hero { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 16px 18px; }
.draft-hero__title { min-width: 0; }
.draft-hero__eyebrow { color: var(--color-primary); font-size: var(--font-size-badge); font-weight: var(--font-weight-title); }
.draft-hero__title h2 { margin: 2px 0 0; overflow: hidden; color: var(--color-text-heading); font-size: var(--font-size-title); text-overflow: ellipsis; white-space: nowrap; }
.draft-hero__title p { margin: 6px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.draft-hero__actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.save-status { font-size: var(--font-size-badge); }
.save-status--success { color: var(--color-success); }
.save-status--info { color: var(--color-text-muted); }
.save-status--warning { color: var(--color-warning, var(--color-text-secondary)); }
.save-status--danger { color: var(--color-danger); }
.draft-layout { display: grid; grid-template-columns: 220px minmax(0, 1fr); align-items: start; gap: 10px; }
.draft-steps { position: sticky; top: 10px; padding: 12px; }
.draft-steps ol { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
.draft-step { display: flex; width: 100%; align-items: flex-start; gap: 10px; padding: 8px 10px; border: 0; border-radius: var(--radius-button); color: var(--color-text-primary); background: transparent; cursor: pointer; text-align: left; }
.draft-step:hover { background: var(--color-bg-subtle); }
.draft-step:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 1px; }
.draft-step--current { background: var(--color-primary-light); }
.draft-step__index { display: inline-grid; width: 22px; height: 22px; flex: 0 0 auto; place-items: center; border: 1px solid var(--color-border); border-radius: 50%; color: var(--color-text-secondary); font-size: var(--font-size-badge); font-weight: 600; }
.draft-step--current .draft-step__index { border-color: var(--color-primary); color: var(--color-bg-base); background: var(--color-primary); }
.draft-step--done:not(.draft-step--current) .draft-step__index { border-color: var(--color-success); color: var(--color-success); }
.draft-step--error .draft-step__text small { color: var(--color-danger); }
.draft-step--todo .draft-step__text small { color: var(--color-warning-strong, var(--color-text-secondary)); }
.draft-step__text { display: flex; min-width: 0; flex-direction: column; }
.draft-step__text strong { font-size: var(--font-size-caption); font-weight: var(--font-weight-title); }
.draft-step__text small { margin-top: 2px; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.draft-steps__note { margin: 12px 4px 0; padding-top: 10px; border-top: 1px solid var(--color-border); color: var(--color-text-muted); font-size: var(--font-size-badge); line-height: 1.55; }
.draft-main { min-width: 0; }
.draft-card { padding: 18px; }
.draft-footer { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.draft-footer__spacer { flex: 1; }
.drawer-intro { margin: 0 0 12px; color: var(--color-text-secondary); font-size: var(--font-size-caption); line-height: 1.6; }
@media (max-width: 860px) {
  .draft-layout { grid-template-columns: 1fr; }
  .draft-steps { position: static; }
  .draft-steps ol { grid-auto-flow: column; grid-auto-columns: minmax(120px, 1fr); overflow-x: auto; }
  .draft-steps__note { display: none; }
}
</style>
