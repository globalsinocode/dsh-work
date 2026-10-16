<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { StatusTag } from '@dsh-work/ui-core'
import { adminApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import type {
  AgentAccess,
  AgentReleaseOverview,
  AgentValidation,
  AgentVersionHistoryItem,
  ValidationCase,
  ValidationCaseSource,
  ValidationChecks,
} from '@/types/domain'

const props = defineProps<{
  agentId: string
}>()
const emit = defineEmits<{
  /** 切换到岗位权限分区。 */
  'open-access': []
  /** 切换到职责与人格分区编辑草稿。 */
  edit: []
}>()

const MAX_TEST_CASES = 20
const MAX_TEST_CASE_CHARS = 2000
const POLL_INTERVAL_MS = 2000

const sourceLabel: Record<ValidationCaseSource, string> = {
  example: '示例问题',
  routine: '主动任务',
  custom: '自定义问题',
}
const caseStatusLabel: Record<ValidationCase['status'], string> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '运行完成',
  failed: '运行失败',
  interrupted: '服务重启中断',
  cancelled: '已取消',
}
const checkLabels: Array<[keyof ValidationChecks, string]> = [
  ['runRecorded', '留下运行记录'],
  ['executionSucceeded', '执行成功'],
  ['outputNonEmpty', '回答非空'],
]

const authStore = useAuthStore()
const contentStore = useContentStore()

const agentId = computed(() => props.agentId)
const versions = ref<AgentVersionHistoryItem[]>([])
const versionsError = ref('')
const overview = ref<AgentReleaseOverview>()
const validation = ref<AgentValidation>()
const loadError = ref('')
const ready = ref(false)
const busy = ref('')
const publishedVersion = ref('')
const publishNote = ref('')

const access = ref<AgentAccess>()
const accessLoadError = ref('')

const prompts = ref<string[]>([])
const rejectingCaseId = ref('')
const rejectNote = ref('')
const changingVerdictId = ref('')

let pollTimer: ReturnType<typeof setTimeout> | undefined
let pollEpoch = 0

/** 只有最新的、未被取代且未发布的验证可以继续判定和发布。 */
const liveValidation = computed(() =>
  validation.value && (validation.value.status === 'running' || validation.value.status === 'completed')
    ? validation.value : undefined)
const working = computed(() => overview.value?.draft ?? null)
const checksPassed = computed(() => Boolean(overview.value?.checks.length) && overview.value!.checks.every(check => check.passed))
const failedChecks = computed(() => overview.value?.checks.filter(check => !check.passed) ?? [])
const promptsDirty = computed(() => {
  const saved = overview.value?.testCases.map(item => item.prompt) ?? []
  return saved.length !== prompts.value.length || saved.some((prompt, index) => prompt !== prompts.value[index])
})
const promptsValid = computed(() => prompts.value.length <= MAX_TEST_CASES
  && prompts.value.every(prompt => prompt.trim() && prompt.length <= MAX_TEST_CASE_CHARS))
const canStart = computed(() => authStore.canManage && Boolean(working.value) && checksPassed.value
  && !promptsDirty.value && busy.value === '')
const passedCount = computed(() => liveValidation.value?.cases.filter(item => item.verdict === 'passed').length ?? 0)
const finishedCount = computed(() => liveValidation.value?.cases
  .filter(item => item.status !== 'queued' && item.status !== 'running').length ?? 0)
const hasAudience = computed(() => Boolean(access.value?.visibleRoleIds.length))

function allChecksPassed(item: ValidationCase) {
  return Boolean(item.checks?.runRecorded && item.checks.executionSucceeded && item.checks.outputNonEmpty)
}

function caseFinished(item: ValidationCase) {
  return item.status !== 'queued' && item.status !== 'running'
}

function caseTone(item: ValidationCase) {
  if (item.status === 'succeeded') return 'succeeded'
  if (item.status === 'failed') return 'failed'
  if (item.status === 'interrupted') return 'interrupted'
  return item.status
}

function showError(cause: unknown, fallback: string) {
  ElMessage.error(cause instanceof Error ? cause.message : fallback)
}

function applyOverview(next: AgentReleaseOverview) {
  overview.value = next
  if (!promptsDirty.value || !prompts.value.length) prompts.value = next.testCases.map(item => item.prompt)
  if (next.validation) validation.value = next.validation
  else validation.value = undefined
  schedulePoll()
}

async function loadOverview() {
  try {
    const result = await adminApi.getAgentRelease(agentId.value)
    applyOverview(result.release)
    // 概览里的验证结果不做案例收敛；再读一次验证详情以拿到最新运行结果。
    if (liveValidation.value) await refreshValidation()
    loadError.value = ''
  } catch (cause) {
    loadError.value = cause instanceof Error ? cause.message : '无法读取验证与发布状态'
  }
}

async function loadAccess() {
  try {
    access.value = await adminApi.getAgentAccess(agentId.value)
    accessLoadError.value = ''
  } catch {
    access.value = undefined
    accessLoadError.value = '无法读取 Agent 岗位权限，请重新读取后再验证。'
  }
}

async function loadVersions() {
  try {
    versions.value = (await adminApi.getAgentVersionHistory(agentId.value)).items
    versionsError.value = ''
  } catch (cause) {
    versionsError.value = cause instanceof Error ? cause.message : '无法读取版本历史'
  }
}

/** 回滚只移动当前版本指针到曾发布的版本，不需要重新验证。 */
async function rollback(item: AgentVersionHistoryItem) {
  try {
    await ElMessageBox.confirm(
      `当前版本将切换为曾发布的 v${item.version}，只移动版本指针，不需要重新验证。启用/停用状态和进行中的草稿保持不变。`,
      `回滚到 v${item.version}？`,
      { confirmButtonText: '确认回滚', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  busy.value = `rollback:${item.id}`
  try {
    await contentStore.rollbackAgent(agentId.value, item.version)
    ElMessage.success(`已回滚到 v${item.version}，操作已写入审计`)
    await Promise.all([loadVersions(), loadOverview()])
  } catch (cause) {
    showError(cause, '回滚失败')
  } finally {
    busy.value = ''
  }
}

async function refreshValidation() {
  const current = validation.value
  if (!current) return
  try {
    validation.value = await adminApi.getAgentValidation(agentId.value, current.id)
  } catch (cause) {
    showError(cause, '验证进度读取失败')
  }
}

function stopPolling() {
  pollEpoch += 1
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = undefined
}

/** 案例在后台并行运行；运行中时定时读取验证详情，结束后停止。 */
function schedulePoll() {
  stopPolling()
  if (validation.value?.status !== 'running') return
  const epoch = pollEpoch
  pollTimer = setTimeout(async () => {
    if (epoch !== pollEpoch) return
    await refreshValidation()
    if (epoch !== pollEpoch) return
    if (validation.value?.status === 'running') schedulePoll()
    else await loadOverview()
  }, POLL_INTERVAL_MS)
}

watch(() => validation.value?.status, status => {
  if (status === 'running' && !pollTimer) schedulePoll()
})

function addPrompt() {
  if (prompts.value.length < MAX_TEST_CASES) prompts.value.push('')
}

function removePrompt(index: number) {
  prompts.value.splice(index, 1)
}

async function savePrompts() {
  if (!promptsValid.value) return
  busy.value = 'prompts'
  try {
    applyOverview(await adminApi.replaceAgentTestCases(agentId.value, prompts.value.map(prompt => prompt.trim())))
    prompts.value = overview.value?.testCases.map(item => item.prompt) ?? []
    ElMessage.success('自定义测试问题已保存，下一次验证生效')
  } catch (cause) {
    showError(cause, '自定义测试问题保存失败')
  } finally {
    busy.value = ''
  }
}

async function startValidation() {
  if (!canStart.value) return
  if (liveValidation.value) {
    try {
      await ElMessageBox.confirm(
        '当前验证的结果和判定将作废，未完成的案例会被取消。',
        '重新开始验证？',
        { confirmButtonText: '重新验证', cancelButtonText: '取消', type: 'warning' },
      )
    } catch {
      return
    }
  }
  busy.value = 'start'
  try {
    applyOverview(await adminApi.startAgentValidation(agentId.value))
    await contentStore.load(true)
    ElMessage.success('验证已开始，案例在后台运行')
  } catch (cause) {
    showError(cause, '验证启动失败')
  } finally {
    busy.value = ''
  }
}

async function rerunCase(item: ValidationCase) {
  const current = liveValidation.value
  if (!current) return
  busy.value = `rerun:${item.id}`
  try {
    validation.value = await adminApi.rerunAgentValidationCase(agentId.value, current.id, item.id)
    schedulePoll()
  } catch (cause) {
    showError(cause, '重跑失败')
  } finally {
    busy.value = ''
  }
}

function startReject(item: ValidationCase) {
  rejectingCaseId.value = item.id
  rejectNote.value = item.verdict === 'failed' ? item.verdictNote ?? '' : ''
}

function cancelReject() {
  rejectingCaseId.value = ''
  rejectNote.value = ''
}

async function judge(item: ValidationCase, verdict: 'passed' | 'failed') {
  const current = liveValidation.value
  if (!current) return
  if (verdict === 'failed' && !rejectNote.value.trim()) return
  busy.value = `verdict:${item.id}`
  try {
    validation.value = await adminApi.setAgentValidationVerdict(agentId.value, current.id, item.id, {
      verdict, ...(verdict === 'failed' ? { note: rejectNote.value.trim() } : {}),
    })
    cancelReject()
    changingVerdictId.value = ''
  } catch (cause) {
    showError(cause, '判定保存失败')
  } finally {
    busy.value = ''
  }
}

async function publish() {
  const current = liveValidation.value
  if (!current?.publishable) return
  busy.value = 'publish'
  try {
    const next = await adminApi.publishAgent(agentId.value, { validationId: current.id, note: publishNote.value.trim() })
    publishedVersion.value = current.version
    publishNote.value = ''
    applyOverview(next)
    await Promise.all([contentStore.load(true), loadVersions()])
  } catch (cause) {
    showError(cause, '发布失败')
    await loadOverview()
  } finally {
    busy.value = ''
  }
}

function formatTime(value: string | null) {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('zh-CN', { hour12: false }) : value
}

async function loadAll() {
  stopPolling()
  ready.value = false
  await Promise.all([loadAccess(), loadOverview(), loadVersions()])
  ready.value = true
}

watch(agentId, loadAll)
onMounted(loadAll)

onBeforeUnmount(stopPolling)
</script>

<template>
  <div class="release-panel">
    <section v-if="!ready" class="content-panel validation-card">
      <el-skeleton :rows="5" animated />
    </section>

    <section v-else-if="loadError && !overview" class="content-panel validation-card">
      <el-result icon="warning" title="无法读取验证与发布" :sub-title="loadError">
        <template #extra><el-button type="primary" @click="loadOverview">重新读取</el-button></template>
      </el-result>
    </section>

    <template v-else-if="overview">
      <el-alert v-if="publishedVersion" class="section-alert" type="success" show-icon :closable="false" title="发布完成" :description="`v${publishedVersion} 已成为当前版本；验证结果与判定已随版本保存，可在下方版本历史中回滚。`" />

      <section v-if="!working && !liveValidation" class="content-panel validation-card">
        <el-empty description="当前没有待发布的草稿；在职责与人格或能力中修改会生成新的草稿版本" :image-size="72">
          <el-button v-if="authStore.canManage" type="primary" data-action="edit-agent" @click="emit('edit')">编辑配置</el-button>
        </el-empty>
      </section>

      <template v-if="working || liveValidation">
        <section class="content-panel validation-card" aria-label="岗位权限摘要">
          <div class="card-head">
            <div class="card-head__title"><h3>岗位权限</h3><span>{{ access ? `${access.visibleRoleIds.length} 个可见角色 · ${access.roleIds.length} 个岗位角色 · ${access.dataScopes.length} 个数据范围` : '读取中' }}</span></div>
            <el-button v-if="authStore.canManage && access" size="small" data-action="edit-agent-access" @click="emit('open-access')">调整</el-button>
          </div>
          <p class="hint">岗位权限属于 Agent，修改立即生效，不需要重新验证；发布时会按最新权限复核。</p>
          <el-alert v-if="accessLoadError" type="error" :closable="false" :title="accessLoadError">
            <el-button link type="primary" @click="loadAccess">重新读取</el-button>
          </el-alert>
          <el-alert v-else-if="access && !hasAudience" type="warning" :closable="false" title="还没有设置可见角色" description="先在岗位权限中选择可以向它请求工作的员工角色，再开始验证。" />
        </section>

        <section v-if="working" class="content-panel validation-card" aria-label="验证前检查">
          <div class="card-head">
            <div class="card-head__title"><h3>验证前检查</h3><span>v{{ working.version }} · {{ overview.checks.length - failedChecks.length }}/{{ overview.checks.length }} 项通过</span></div>
          </div>
          <ul class="check-list">
            <li v-for="check in overview.checks" :key="check.id" :class="check.passed ? 'check-list__item--passed' : 'check-list__item--failed'">
              <span class="check-list__mark" aria-hidden="true">{{ check.passed ? '✓' : '✕' }}</span>
              <strong>{{ check.label }}</strong>
              <span>{{ check.detail }}</span>
            </li>
          </ul>
          <el-alert v-if="overview.usesMcp" class="section-alert" type="info" :closable="false" show-icon title="验证运行不调用 MCP 连接器" description="MCP 的上游权限由连接器凭据决定；发布时会复核连接范围，正式运行才会调用。" />
        </section>

        <section v-if="working" class="content-panel validation-card" aria-label="验证案例">
          <div class="card-head">
            <div class="card-head__title"><h3>验证案例</h3><span>示例问题、主动任务与自定义问题一起运行</span></div>
            <el-button
              v-if="authStore.canManage"
              type="primary"
              :loading="busy === 'start'"
              :disabled="!canStart"
              data-action="start-validation"
              @click="startValidation"
            >{{ liveValidation ? (overview.draftChanged ? '验证修改后的草稿' : '重新开始验证') : '开始验证' }}</el-button>
          </div>
          <el-alert v-if="overview.draftChanged" class="section-alert" type="warning" :closable="false" show-icon title="草稿已修改" :description="`下方结果属于 v${liveValidation?.version ?? overview.candidate?.version}，不能代表修改后的草稿；重新验证后才能发布新内容。`" />
          <el-alert v-if="failedChecks.length" class="section-alert" type="warning" :closable="false" show-icon :title="`验证前检查未通过：${failedChecks.map(check => check.label).join('、')}`" />
          <p v-if="promptsDirty" class="hint">自定义问题有未保存的修改，保存后才能开始验证。</p>

          <ol class="planned-cases" aria-label="本次将运行的案例">
            <li v-for="(item, index) in overview.plannedCases" :key="`${item.source}:${item.sourceRef ?? ''}:${index}`">
              <el-tag size="small" effect="plain">{{ sourceLabel[item.source] }}</el-tag>
              <span>{{ item.prompt }}</span>
            </li>
          </ol>
          <p v-if="!overview.plannedCases.length" class="hint">还没有可运行的案例：添加示例问题、主动任务或下面的自定义问题。</p>

          <div class="custom-prompts">
            <h4>自定义测试问题 <small class="hint">{{ prompts.length }}/{{ MAX_TEST_CASES }} · 属于 Agent，跨版本复用</small></h4>
            <div v-for="(_, index) in prompts" :key="index" class="custom-prompts__row">
              <el-input v-model="prompts[index]" type="textarea" :rows="2" :maxlength="MAX_TEST_CASE_CHARS" :disabled="!authStore.canManage" :aria-label="`自定义测试问题 ${index + 1}`" />
              <el-button v-if="authStore.canManage" text type="danger" @click="removePrompt(index)">删除</el-button>
            </div>
            <div v-if="authStore.canManage" class="custom-prompts__actions">
              <el-button size="small" :disabled="prompts.length >= MAX_TEST_CASES" @click="addPrompt">添加问题</el-button>
              <el-button size="small" type="primary" plain :loading="busy === 'prompts'" :disabled="!promptsDirty || !promptsValid" @click="savePrompts">保存测试问题</el-button>
            </div>
          </div>
        </section>

        <section v-if="liveValidation" class="content-panel validation-card" aria-label="验证结果">
          <div class="card-head">
            <div class="card-head__title">
              <h3>验证结果</h3>
              <span>v{{ liveValidation.version }} · {{ finishedCount }}/{{ liveValidation.cases.length }} 项运行结束 · {{ passedCount }} 项判定通过</span>
            </div>
            <StatusTag :status="liveValidation.status === 'running' ? 'running' : 'completed'" :label="liveValidation.status === 'running' ? '运行中' : '运行结束'" />
          </div>
          <p class="hint">每项需通过三项机器检查（留下运行记录、执行成功、回答非空），再由你判定是否符合预期。</p>

          <article v-for="item in liveValidation.cases" :key="item.id" class="case-item" :aria-label="`案例 ${item.position + 1}`">
            <header class="case-item__head">
              <span class="case-item__index">{{ item.position + 1 }}</span>
              <el-tag size="small" effect="plain">{{ sourceLabel[item.source] }}</el-tag>
              <StatusTag :status="caseTone(item)" :label="caseStatusLabel[item.status]" />
              <small v-if="item.runCount > 1" class="hint">第 {{ item.runCount }} 次运行</small>
              <el-tag v-if="item.verdict" size="small" :type="item.verdict === 'passed' ? 'success' : 'danger'">{{ item.verdict === 'passed' ? '判定通过' : '判定不通过' }}</el-tag>
            </header>
            <p class="case-item__prompt">{{ item.prompt }}</p>

            <template v-if="caseFinished(item)">
              <ul class="machine-checks" aria-label="机器检查">
                <li v-for="[key, label] in checkLabels" :key="key" :class="item.checks?.[key] ? 'machine-checks--passed' : 'machine-checks--failed'">{{ item.checks?.[key] ? '✓' : '✕' }} {{ label }}</li>
              </ul>
              <div v-if="item.output" class="case-item__output" role="region" :aria-label="`案例 ${item.position + 1} 的回答`" tabindex="0">{{ item.output }}</div>
              <p v-if="item.error" class="case-item__error">{{ item.error }}</p>
              <p v-if="item.verdict === 'failed' && item.verdictNote" class="case-item__note">不通过原因：{{ item.verdictNote }}</p>
              <details class="case-item__details">
                <summary>运行详情</summary>
                <dl class="meta-grid">
                  <div><dt>Run</dt><dd class="mono">{{ item.runId ?? '—' }}</dd></div>
                  <div><dt>Attempt</dt><dd class="mono">{{ item.attemptId ?? '—' }}</dd></div>
                  <div><dt>开始</dt><dd>{{ formatTime(item.startedAt) }}</dd></div>
                  <div><dt>结束</dt><dd>{{ formatTime(item.finishedAt) }}</dd></div>
                </dl>
              </details>

              <div v-if="authStore.canManage" class="case-item__actions" role="group" :aria-label="`案例 ${item.position + 1} 判定`">
                <template v-if="rejectingCaseId === item.id">
                  <el-input v-model="rejectNote" type="textarea" :rows="2" :maxlength="2000" show-word-limit placeholder="说明哪里不符合预期，修改配置后据此重新验证" :aria-label="`案例 ${item.position + 1} 不通过原因`" />
                  <div class="case-item__buttons">
                    <el-button type="danger" size="small" :loading="busy === `verdict:${item.id}`" :disabled="!rejectNote.trim()" @click="judge(item, 'failed')">确认不通过</el-button>
                    <el-button size="small" @click="cancelReject">取消</el-button>
                  </div>
                </template>
                <div v-else-if="!item.verdict || changingVerdictId === item.id" class="case-item__buttons">
                  <el-button type="success" size="small" :loading="busy === `verdict:${item.id}`" :disabled="!allChecksPassed(item)" @click="judge(item, 'passed')">通过</el-button>
                  <el-button type="danger" plain size="small" @click="startReject(item)">不通过</el-button>
                  <el-button size="small" :loading="busy === `rerun:${item.id}`" @click="rerunCase(item)">重跑本项</el-button>
                  <small v-if="!allChecksPassed(item)" class="hint">机器检查未全部通过，只能判为不通过或重跑。</small>
                </div>
                <div v-else class="case-item__buttons">
                  <el-button size="small" text type="primary" @click="changingVerdictId = item.id">修改判定</el-button>
                  <el-button size="small" :loading="busy === `rerun:${item.id}`" @click="rerunCase(item)">重跑本项</el-button>
                </div>
              </div>
            </template>
            <p v-else class="hint">{{ item.status === 'queued' ? '等待后台空闲名额…' : '正在运行，完成后自动刷新。' }}</p>
          </article>
        </section>

        <section v-if="liveValidation && authStore.canManage" class="content-panel validation-card" aria-label="确认发布">
          <div class="card-head"><div class="card-head__title"><h3>确认发布</h3><span>v{{ liveValidation.version }}</span></div></div>
          <p class="hint">全部案例判定通过后才能发布。发布时会按最新的岗位权限、工具绑定和连接范围再复核一次；发布只移动当前版本指针。</p>
          <el-input v-model="publishNote" type="textarea" :rows="2" :maxlength="2000" aria-label="发布说明" placeholder="发布说明（选填）" />
          <div class="publish-actions">
            <el-button type="primary" :loading="busy === 'publish'" :disabled="!liveValidation.publishable || busy !== ''" data-action="publish-agent" @click="publish">确认发布</el-button>
            <small v-if="!liveValidation.publishable" class="hint">还有 {{ liveValidation.cases.length - passedCount }} 项未判定通过。</small>
          </div>
        </section>
      </template>

      <section class="content-panel validation-card" aria-label="版本历史">
        <div class="card-head"><div class="card-head__title"><h3>版本历史</h3><span>回滚只移动当前版本指针，不需要重新验证</span></div></div>
        <el-alert v-if="versionsError" type="error" :closable="false" :title="versionsError">
          <el-button link type="primary" @click="loadVersions">重新读取</el-button>
        </el-alert>
        <el-table v-else class="data-table" :data="versions" empty-text="暂无版本记录">
          <el-table-column label="版本" width="120"><template #default="scope"><span class="mono">v{{ scope.row.version }}</span><small v-if="scope.row.active" class="current-version">当前</small></template></el-table-column>
          <el-table-column label="变更说明" min-width="200"><template #default="scope"><div class="version-summary"><strong>{{ scope.row.summary }}</strong><small>{{ scope.row.createdBy }} · {{ formatTime(scope.row.createdAt) }}</small></div></template></el-table-column>
          <el-table-column label="状态" width="100"><template #default="scope"><StatusTag :status="scope.row.status" /></template></el-table-column>
          <el-table-column label="发布" min-width="170"><template #default="scope"><small v-if="scope.row.publishedAt" class="hint">{{ scope.row.publishedBy }} · {{ formatTime(scope.row.publishedAt) }}</small><span v-else class="hint">—</span></template></el-table-column>
          <el-table-column label="操作" width="110">
            <template #default="scope">
              <el-button v-if="authStore.canManage && scope.row.publishedAt && !scope.row.active" link type="primary" :loading="busy === `rollback:${scope.row.id}`" :disabled="busy !== ''" data-action="rollback-agent" @click="rollback(scope.row)">回滚至此</el-button>
              <span v-else class="hint">—</span>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </template>
  </div>
</template>

<style scoped>
.release-panel { width: 100%; }
.validation-card { margin-bottom: 14px; padding: 18px; }
.current-version { display: inline-flex; margin-left: 5px; padding: 2px 5px; border-radius: var(--radius-tag); color: var(--color-primary); background: var(--color-primary-light); font-size: var(--font-size-micro); }
.version-summary { display: flex; flex-direction: column; }
.version-summary strong { color: var(--color-text-primary); font-size: var(--font-size-caption); font-weight: var(--font-weight-badge); }
.version-summary small { margin-top: 4px; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.card-head { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-bottom: 10px; }
.card-head h3 { margin: 2px 0 0; color: var(--color-text-heading); font-size: var(--font-size-body); }
.card-head__title { display: flex; align-items: baseline; flex-wrap: wrap; gap: 10px; min-width: 0; }
.card-head__title span { color: var(--color-text-muted); font-size: var(--font-size-badge); overflow-wrap: anywhere; }
.hint { margin: 6px 0 0; color: var(--color-text-muted); font-size: var(--font-size-badge); line-height: 1.55; }
.mono { font-family: monospace; }
.section-alert { margin: 10px 0; }
.check-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.check-list li { display: grid; grid-template-columns: 20px minmax(90px, auto) minmax(0, 1fr); align-items: baseline; gap: 8px; padding: 7px 10px; border-radius: var(--radius-button); background: var(--color-bg-subtle); font-size: var(--font-size-caption); }
.check-list li > span:last-child { color: var(--color-text-secondary); overflow-wrap: anywhere; }
.check-list__item--passed .check-list__mark { color: var(--color-success); }
.check-list__item--failed .check-list__mark { color: var(--color-danger); }
.planned-cases { display: grid; gap: 6px; margin: 12px 0 0; padding-left: 20px; }
.planned-cases li { font-size: var(--font-size-caption); line-height: 1.55; }
.planned-cases li .el-tag { margin-right: 8px; }
.custom-prompts { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--color-border); }
.custom-prompts h4 { margin: 0 0 8px; color: var(--color-text-heading); font-size: var(--font-size-caption); }
.custom-prompts__row { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 8px; }
.custom-prompts__actions { display: flex; flex-wrap: wrap; gap: 8px; }
.case-item { margin-top: 12px; padding: 12px 14px; border: 1px solid var(--color-border); border-radius: var(--radius-button); background: var(--color-bg-base); }
.case-item__head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.case-item__index { display: inline-grid; width: 22px; height: 22px; place-items: center; border-radius: 50%; color: var(--color-primary); background: var(--color-primary-light); font-size: var(--font-size-badge); font-weight: 600; }
.case-item__prompt { margin: 8px 0; color: var(--color-text-primary); font-size: var(--font-size-caption); line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.machine-checks { display: flex; flex-wrap: wrap; gap: 12px; margin: 0 0 8px; padding: 0; list-style: none; font-size: var(--font-size-badge); }
.machine-checks--passed { color: var(--color-success); }
.machine-checks--failed { color: var(--color-danger); }
.case-item__output { max-height: 260px; padding: 10px 12px; overflow: auto; border-radius: var(--radius-button); color: var(--color-text-primary); background: var(--color-bg-subtle); font-size: var(--font-size-caption); line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.case-item__error { margin: 8px 0 0; color: var(--color-danger); font-size: var(--font-size-badge); overflow-wrap: anywhere; }
.case-item__note { margin: 8px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.case-item__details { margin-top: 8px; font-size: var(--font-size-badge); }
.case-item__details summary { width: fit-content; cursor: pointer; color: var(--color-text-muted); }
.case-item__actions { display: grid; gap: 8px; margin-top: 10px; }
.case-item__buttons { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.meta-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 18px; margin: 6px 0 0; }
.meta-grid > div { padding: 6px 0; border-bottom: 1px solid var(--color-border); }
.meta-grid dt { color: var(--color-text-muted); }
.meta-grid dd { margin: 3px 0 0; overflow-wrap: anywhere; }
.publish-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
@media (max-width: 700px) {
  .check-list li { grid-template-columns: 20px minmax(0, 1fr); }
  .check-list li > span:last-child { grid-column: 2; }
  .meta-grid { grid-template-columns: 1fr; }
}
</style>
