<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh, View } from '@element-plus/icons-vue'

import { StatusTag } from '@dsh-work/ui-core'
import { adminApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import type { IdentityRoleSummary, SkillSubmissionReviewDetail, SkillSubmissionReviewItem, SkillTestRunProgress } from '@/types/domain'

/**
 * 管理员审核员工 Skill 提交（Skill 创建专家方案 4.4）：看提交内容与严格试运行结果，
 * 通过时选择可见范围并发布，或填写原因拒绝。试运行由管理员在详情中发起，记在本人名下。
 */
const emit = defineEmits<{ count: [value: number]; published: [] }>()

const authStore = useAuthStore()
const items = ref<SkillSubmissionReviewItem[]>([])
const loading = ref(false)
const loadError = ref('')

const detailOpen = ref(false)
const detail = ref<SkillSubmissionReviewDetail | null>(null)
const detailLoading = ref(false)
const fileTab = ref('SKILL.md')
const fileContent = ref('')
const fileLoading = ref(false)
const trialProgress = ref<SkillTestRunProgress | null>(null)
const trialStarting = ref(false)
let pollTimer: ReturnType<typeof setTimeout> | undefined
let pollEpoch = 0

const approveOpen = ref(false)
const approving = ref(false)
const roleOptions = ref<IdentityRoleSummary[]>([])
const approveForm = reactive({ scope: 'all' as 'all' | 'roles', roleIds: [] as string[] })
const rejectOpen = ref(false)
const rejecting = ref(false)
const rejectNote = ref('')

const sourceLabels: Record<SkillSubmissionReviewItem['source'], string> = { conversation: '对话创建', zip: 'ZIP', link: '链接' }
const trialLabels: Record<SkillSubmissionReviewItem['trial']['status'], string> = {
  not_started: '未试运行', running: '试运行中', unconfirmed: '已结束，待查看', passed: '已通过', failed: '未通过',
}
const trialTagStatus: Record<SkillSubmissionReviewItem['trial']['status'], string> = {
  not_started: 'pending', running: 'running', unconfirmed: 'waiting', passed: 'succeeded', failed: 'failed',
}

const scriptFiles = computed(() => detail.value?.files.filter(file => file.script) ?? [])
const otherFiles = computed(() => detail.value?.files.filter(file => !file.script && file.path !== 'SKILL.md') ?? [])
const trialActive = computed(() => ['queued', 'running', 'waiting', 'cancel_requested'].includes(trialProgress.value?.status ?? ''))
const trialStatus = computed<SkillSubmissionReviewItem['trial']['status']>(() => {
  const progress = trialProgress.value
  if (progress) return progress.status === 'passed' ? 'passed' : progress.status === 'failed' || progress.status === 'cancelled' ? 'failed' : 'running'
  return detail.value?.trial.status ?? 'not_started'
})
const approveBlockedReason = computed(() => {
  if (!detail.value) return ''
  if (detail.value.compatibility.status === 'incompatible') return '包校验未通过，不能发布'
  if (trialStatus.value === 'passed') return ''
  if (trialStatus.value === 'running') return '严格试运行进行中，通过后才能发布'
  if (trialStatus.value === 'failed') return '严格试运行未通过，不能发布'
  // 结果只能由发起试运行的管理员查看后记录；其他管理员需要重新试运行。
  if (trialStatus.value === 'unconfirmed') return '上一次试运行已结束，结果待发起的管理员查看；也可以重新试运行'
  return '先完成一次严格试运行，通过后才能发布'
})
const approveInvalid = computed(() => approveForm.scope === 'roles' && !approveForm.roleIds.length)
const currentVisibility = computed(() => {
  if (!detail.value?.publishedSkillId) return ''
  const roles = detail.value.publishedVisibleRoleIds
  return roles ? roles.map(id => roleOptions.value.find(role => role.id === id)?.name ?? id).join('、') : '全员'
})

function formatTime(value: string) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    items.value = await adminApi.getSkillSubmissions()
    emit('count', items.value.length)
  } catch (cause) {
    loadError.value = cause instanceof Error ? cause.message : '待审核列表加载失败'
  } finally {
    loading.value = false
  }
}

async function openDetail(item: SkillSubmissionReviewItem) {
  stopPolling()
  trialProgress.value = null
  detail.value = null
  detailOpen.value = true
  detailLoading.value = true
  try {
    detail.value = await adminApi.getSkillSubmission(item.id)
    fileContent.value = ''
    // 切换页签由监听加载；已在 SKILL.md 时监听不会触发，直接加载。
    if (fileTab.value === 'SKILL.md') await loadFile('SKILL.md')
    else fileTab.value = 'SKILL.md'
    // 本人发起且尚未记录结果的试运行：继续查询进度。
    if (detail.value.trial.runId && ['running', 'unconfirmed'].includes(detail.value.trial.status)) void pollTrial(detail.value.trial.runId)
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '提交详情加载失败')
    detailOpen.value = false
  } finally {
    detailLoading.value = false
  }
}

let fileEpoch = 0
async function loadFile(path: string) {
  if (!detail.value) return
  // 只采用最后一次请求的结果，避免快速切换页签时较慢的旧响应覆盖当前文件。
  const epoch = ++fileEpoch
  fileLoading.value = true
  try {
    const file = await adminApi.getSkillSubmissionFile(detail.value.id, detail.value.versionId, path)
    if (epoch === fileEpoch) fileContent.value = file.content
  } catch (cause) {
    if (epoch !== fileEpoch) return
    fileContent.value = ''
    ElMessage.error(cause instanceof Error ? cause.message : '文件读取失败')
  } finally {
    if (epoch === fileEpoch) fileLoading.value = false
  }
}
watch(fileTab, path => { if (detailOpen.value) void loadFile(path) })

async function startTrial() {
  if (!detail.value) return
  trialStarting.value = true
  try {
    const progress = await adminApi.startSkillSubmissionTestRun(detail.value.id, detail.value.versionId)
    trialProgress.value = progress
    if (['queued', 'running', 'waiting', 'cancel_requested'].includes(progress.status)) void pollTrial(progress.runId)
    else await refreshDetail()
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '严格试运行启动失败')
  } finally {
    trialStarting.value = false
  }
}

async function pollTrial(runId: string) {
  const epoch = ++pollEpoch
  const submissionId = detail.value?.id
  if (!submissionId) return
  try {
    const progress = await adminApi.getSkillSubmissionTestRun(submissionId, runId)
    if (epoch !== pollEpoch) return
    trialProgress.value = progress
    if (['queued', 'running', 'waiting', 'cancel_requested'].includes(progress.status)) {
      pollTimer = setTimeout(() => void pollTrial(runId), 2000)
      return
    }
    await refreshDetail()
  } catch {
    // 他人发起的试运行查不到进度：保留列表给出的状态，管理员可重新试运行。
    if (epoch === pollEpoch) trialProgress.value = null
  }
}

function stopPolling() {
  pollEpoch++
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = undefined
}

async function refreshDetail() {
  if (!detail.value) return
  const updated = await adminApi.getSkillSubmission(detail.value.id)
  detail.value = updated
  const index = items.value.findIndex(item => item.id === updated.id)
  if (index >= 0) items.value[index] = { ...items.value[index]!, trial: updated.trial }
}

async function openApprove() {
  // 已发布 Skill 的修订默认沿用当前可见范围，避免一次确认就放宽到全员。
  const current = detail.value?.publishedSkillId ? detail.value.publishedVisibleRoleIds ?? null : null
  approveForm.scope = current ? 'roles' : 'all'
  approveForm.roleIds = [...(current ?? [])]
  approveOpen.value = true
  if (!roleOptions.value.length) {
    try { roleOptions.value = (await adminApi.getIdentityRoles()).filter(role => role.status !== 'disabled') } catch { roleOptions.value = [] }
  }
}

async function confirmApprove() {
  if (!detail.value || approveInvalid.value) return
  approving.value = true
  try {
    await adminApi.approveSkillSubmission(detail.value.id, {
      versionId: detail.value.versionId,
      visibleRoleIds: approveForm.scope === 'all' ? null : [...approveForm.roleIds],
    })
    ElMessage.success(`“${detail.value.name}”已发布，提交人会在草稿卡片上看到结果`)
    approveOpen.value = false
    detailOpen.value = false
    emit('published')
    await load()
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '发布失败')
  } finally {
    approving.value = false
  }
}

function openReject() {
  rejectNote.value = ''
  rejectOpen.value = true
}

async function confirmReject() {
  if (!detail.value || !rejectNote.value.trim()) return
  rejecting.value = true
  try {
    await adminApi.rejectSkillSubmission(detail.value.id, { versionId: detail.value.versionId, note: rejectNote.value.trim() })
    ElMessage.success('已拒绝，提交人会在草稿卡片上看到原因')
    rejectOpen.value = false
    detailOpen.value = false
    await load()
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '拒绝失败')
  } finally {
    rejecting.value = false
  }
}

watch(detailOpen, open => { if (!open) stopPolling() })
onMounted(load)
onUnmounted(stopPolling)
defineExpose({ load })
</script>

<template>
  <section class="content-panel content-panel--flush submission-review" aria-label="待审核的 Skill 提交">
    <div class="submission-review__toolbar">
      <p>员工经 Skill 创建专家提交的 Skill。通过前须完成一次严格试运行；通过时选择可见范围。</p>
      <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
    </div>
    <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" show-icon />
    <el-table class="data-table" v-loading="loading" :data="items" empty-text="暂无待审核的 Skill 提交">
      <el-table-column label="Skill" min-width="280">
        <template #default="scope">
          <div class="submission-review__name">
            <strong>{{ scope.row.name }}</strong>
            <small v-if="scope.row.publishedSkillId">已发布 Skill 的修订</small>
            <p>{{ scope.row.description }}</p>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="提交人" min-width="120"><template #default="scope">{{ scope.row.submitter.displayName }}</template></el-table-column>
      <el-table-column label="来源" width="100"><template #default="scope">{{ sourceLabels[scope.row.source as SkillSubmissionReviewItem['source']] }}</template></el-table-column>
      <el-table-column label="内容" width="110"><template #default="scope">{{ scope.row.scriptCount ? `含 ${scope.row.scriptCount} 个脚本` : '纯指令' }}</template></el-table-column>
      <el-table-column label="试运行" width="140">
        <template #default="scope"><StatusTag :status="trialTagStatus[scope.row.trial.status as SkillSubmissionReviewItem['trial']['status']]" :label="trialLabels[scope.row.trial.status as SkillSubmissionReviewItem['trial']['status']]" dot /></template>
      </el-table-column>
      <el-table-column label="提交时间" width="130"><template #default="scope">{{ formatTime(scope.row.submittedAt) }}</template></el-table-column>
      <el-table-column label="操作" width="100" fixed="right">
        <template #default="scope"><el-button link type="primary" :icon="View" :aria-label="`审核 ${scope.row.name}`" @click="openDetail(scope.row)">审核</el-button></template>
      </el-table-column>
    </el-table>

    <el-drawer v-model="detailOpen" size="min(720px, 100vw)" :title="detail ? `审核：${detail.name}` : '审核 Skill 提交'">
      <div v-if="detailLoading" v-loading="true" class="submission-review__loading" />
      <template v-else-if="detail">
        <dl class="submission-review__rows">
          <div><dt>提交人</dt><dd>{{ detail.submitter.displayName }}</dd></div>
          <div><dt>来源</dt><dd>{{ sourceLabels[detail.source] }}{{ detail.sessionId ? `（会话 ${detail.sessionId}）` : '' }}</dd></div>
          <div><dt>版本</dt><dd>第 {{ detail.versionNumber }} 版{{ detail.publishedSkillId ? '，已发布 Skill 的修订' : '' }}</dd></div>
          <div><dt>提交时间</dt><dd>{{ formatTime(detail.submittedAt) }}</dd></div>
          <div><dt>说明</dt><dd>{{ detail.description }}</dd></div>
          <div>
            <dt>包校验</dt>
            <dd>
              {{ detail.compatibility.status === 'incompatible' ? '未通过' : detail.compatibility.status === 'needs_review' ? '通过，有需注意的事项' : '通过' }}
              <ul v-if="detail.compatibility.issues.length" class="submission-review__issues">
                <li v-for="issue in detail.compatibility.issues" :key="issue.code + issue.message">{{ issue.message }}</li>
              </ul>
            </dd>
          </div>
        </dl>

        <section class="submission-review__section" aria-labelledby="submission-content-title">
          <h3 id="submission-content-title">提交内容</h3>
          <el-tabs v-model="fileTab">
            <el-tab-pane label="SKILL.md" name="SKILL.md" />
            <el-tab-pane v-for="file in scriptFiles" :key="file.path" :label="`脚本：${file.path}`" :name="file.path" />
            <el-tab-pane v-for="file in otherFiles" :key="file.path" :label="file.path" :name="file.path" />
          </el-tabs>
          <pre v-loading="fileLoading" class="submission-review__file" :aria-label="`${fileTab} 内容`">{{ fileContent }}</pre>
        </section>

        <section class="submission-review__section" aria-labelledby="submission-trial-title">
          <div class="submission-review__section-head">
            <h3 id="submission-trial-title">严格试运行</h3>
            <StatusTag :status="trialTagStatus[trialStatus]" :label="trialLabels[trialStatus]" dot />
          </div>
          <p class="submission-review__hint">要求 Skill 留下激活证据，每个 Python 入口在沙箱中退出码为 0。试运行记在你的名下。</p>
          <div v-if="trialProgress" class="skill-test-progress" aria-live="polite">
            <article v-for="step in trialProgress.steps" :key="step.id" :class="`is-${step.status}`">
              <div><strong>{{ step.title }}</strong><p>{{ step.description }}</p></div>
            </article>
          </div>
          <pre v-if="!trialActive && (trialProgress?.resultSummary ?? detail.trial.resultSummary)" class="submission-review__file">{{ trialProgress?.resultSummary ?? detail.trial.resultSummary }}</pre>
          <el-button v-if="authStore.canManage && !trialActive && detail.compatibility.status !== 'incompatible'" :loading="trialStarting" @click="startTrial">
            {{ trialStatus === 'not_started' ? '开始试运行' : '重新试运行' }}
          </el-button>
        </section>
      </template>
      <template v-if="detail && authStore.canManage" #footer>
        <span v-if="approveBlockedReason" class="submission-review__blocked" role="note">{{ approveBlockedReason }}</span>
        <el-button @click="openReject">拒绝</el-button>
        <el-button type="primary" :disabled="Boolean(approveBlockedReason)" @click="openApprove">通过并发布</el-button>
      </template>
    </el-drawer>

    <el-dialog v-model="approveOpen" title="通过并发布" width="min(520px, calc(100vw - 32px))" destroy-on-close>
      <p class="submission-review__hint">选择哪些员工能在 Skill 广场选用这个 Skill，发布后可在 Skill 详情中调整。</p>
      <p v-if="currentVisibility" class="submission-review__hint">这是已发布 Skill 的修订，当前可见范围：{{ currentVisibility }}。</p>
      <el-radio-group v-model="approveForm.scope" aria-label="可见范围">
        <el-radio value="all">全员</el-radio>
        <el-radio value="roles">指定角色</el-radio>
      </el-radio-group>
      <el-checkbox-group v-if="approveForm.scope === 'roles'" v-model="approveForm.roleIds" class="submission-review__roles" aria-label="可见角色">
        <el-checkbox v-for="role in roleOptions" :key="role.id" :value="role.id">{{ role.name }}</el-checkbox>
      </el-checkbox-group>
      <p v-if="approveInvalid" class="submission-review__blocked" role="note">请至少选择一个角色</p>
      <template #footer>
        <el-button @click="approveOpen = false">取消</el-button>
        <el-button type="primary" :disabled="approveInvalid" :loading="approving" @click="confirmApprove">确认发布</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="rejectOpen" title="拒绝提交" width="min(520px, calc(100vw - 32px))" destroy-on-close>
      <el-input v-model="rejectNote" type="textarea" :rows="4" maxlength="500" show-word-limit placeholder="提交人会在草稿卡片上看到原因，并可在原对话中继续修改" aria-label="拒绝原因" />
      <template #footer>
        <el-button @click="rejectOpen = false">取消</el-button>
        <el-button type="danger" :disabled="!rejectNote.trim()" :loading="rejecting" @click="confirmReject">确认拒绝</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.submission-review__toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 20px; }
.submission-review__toolbar p { margin: 0; color: var(--dsh-color-muted); font-size: var(--dsh-font-size-caption); }
.submission-review__name strong { display: block; }
.submission-review__name small { color: var(--dsh-color-brand); font-size: var(--dsh-font-size-caption); }
.submission-review__name p { margin: 4px 0 0; color: var(--dsh-color-muted); font-size: var(--dsh-font-size-caption); }
.submission-review__loading { min-height: 200px; }
.submission-review__rows { display: grid; gap: 10px; margin: 0; }
.submission-review__rows > div { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 12px; }
.submission-review__rows dt { color: var(--dsh-color-muted); font-size: var(--dsh-font-size-caption); }
.submission-review__rows dd { margin: 0; overflow-wrap: anywhere; }
.submission-review__section { margin-top: 20px; }
.submission-review__section h3 { margin: 0 0 8px; font-size: var(--dsh-font-size-body); }
.submission-review__section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.submission-review__hint { margin: 0 0 12px; color: var(--dsh-color-muted); font-size: var(--dsh-font-size-caption); }
.submission-review__file { max-height: 360px; margin: 0 0 12px; padding: 12px; overflow: auto; border-radius: var(--dsh-radius-sm); background: var(--dsh-color-canvas); font-size: var(--dsh-font-size-caption); white-space: pre-wrap; word-break: break-word; }
.submission-review__issues { margin: 4px 0 0; padding-left: 18px; }
.submission-review__blocked { margin-right: auto; color: var(--dsh-color-muted); font-size: var(--dsh-font-size-caption); }
.submission-review__roles { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 12px; }
:deep(.el-drawer__footer) { display: flex; align-items: center; gap: 8px; }
</style>
