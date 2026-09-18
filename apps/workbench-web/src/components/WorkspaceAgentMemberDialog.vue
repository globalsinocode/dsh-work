<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Cpu, Plus, Search } from '@element-plus/icons-vue'

import { workbenchApi } from '@/api/client'
import type {
  AgentCandidate,
  TeamMemberRole,
  WorkspaceAgentMember,
} from '@/types/domain'
import { notifyActionFailure } from '@/utils/feedback'

const props = withDefaults(
  defineProps<{
    open: boolean
    workspaceId: string
    workspaceName?: string
    /**
     * 当前操作人在该团队的员工角色；无法判定时传 null。
     * Agent 的添加/停用/启用/升级/移出全部要求负责人（与服务端一致），
     * 非负责人只读名册——写入口不渲染而不是点了才被拒。
     */
    currentUserRole?: TeamMemberRole | null
    /** Agent 成员列表：优先由本组件按 `loadAgentMembers` 通过既有 T4 接口加载。 */
    agentMembers?: WorkspaceAgentMember[]
    loadAgentMembers?: boolean
    /**
     * 空间是否已归档。归档属执行轨（3-T1/3-T2）：Agent 的**所有写入口**
     * 隐藏——服务端会 403，渲染出来只是让用户走进死路（design §2.7/§3）。
     */
    archived?: boolean
  }>(),
  {
    workspaceName: '',
    currentUserRole: null,
    agentMembers: () => [],
    loadAgentMembers: true,
    archived: false,
  },
)

const emit = defineEmits<{
  'update:open': [value: boolean]
  refresh: []
  'start-conversation': [agentMemberId: string]
}>()

const loadingAgents = ref(false)
const loadAgentError = ref('')

const candidate = ref<{
  open: boolean
  loading: boolean
  query: string
  items: AgentCandidate[]
  nextCursor: string | null
  selected: AgentCandidate | null
}>({ open: false, loading: false, query: '', items: [], nextCursor: null, selected: null })
const addingAgent = ref(false)

const agentMemberList = ref<WorkspaceAgentMember[]>(props.agentMembers)

const isOwner = computed(() => props.currentUserRole === 'owner')

async function refreshAgentMembers() {
  if (!props.loadAgentMembers || !props.workspaceId) return
  loadingAgents.value = true
  loadAgentError.value = ''
  try {
    agentMemberList.value = await workbenchApi.listWorkspaceAgentMembers(props.workspaceId)
  } catch (error) {
    notifyActionFailure('加载 Agent 成员', `工作空间“${props.workspaceName}”`, error, '重新打开弹窗或稍后刷新页面重试。')
    loadAgentError.value = error instanceof Error ? error.message : '加载失败'
  } finally {
    loadingAgents.value = false
  }
}

watch(() => props.agentMembers, (value) => {
  if (!props.loadAgentMembers) agentMemberList.value = value
})

watch(() => props.open, (open) => {
  if (open && props.loadAgentMembers) void refreshAgentMembers()
  if (!open) {
    candidate.value.open = false
    candidate.value.selected = null
  }
}, { immediate: true })

function openAgentSearch() {
  candidate.value.open = true
  candidate.value.selected = null
  void searchAgentCandidates('')
}

let agentSearchTimer: ReturnType<typeof setTimeout> | undefined
function onAgentSearchInput(value: string) {
  if (value === candidate.value.query) return
  candidate.value.query = value
  if (agentSearchTimer) clearTimeout(agentSearchTimer)
  agentSearchTimer = setTimeout(() => void searchAgentCandidates(value), 300)
}

async function searchAgentCandidates(query: string) {
  if (!isOwner.value) return
  candidate.value.loading = true
  try {
    const page = await workbenchApi.listWorkspaceAgentCandidates(props.workspaceId, {
      ...(query ? { query } : {}),
      limit: 10,
    })
    candidate.value.items = page.items
    candidate.value.nextCursor = page.nextCursor
  } catch (error) {
    notifyActionFailure('搜索 Agent', '平台已发布 Agent', error, '确认当前为负责人且平台允许该 Agent 加入本空间。')
  } finally {
    candidate.value.loading = false
  }
}

function selectAgentCandidate(item: AgentCandidate) {
  candidate.value.selected = item
}

async function confirmAddAgent() {
  const selected = candidate.value.selected
  if (!selected || addingAgent.value) return
  addingAgent.value = true
  try {
    await workbenchApi.addWorkspaceAgentMember(props.workspaceId, { agentId: selected.agentId })
    ElMessage.success(`已加入 Agent“${selected.name}”`)
    candidate.value.open = false
    candidate.value.selected = null
    emit('refresh')
    if (props.loadAgentMembers) await refreshAgentMembers()
  } catch (error) {
    notifyActionFailure('添加 Agent 成员', `Agent“${selected.name}”`, error, '确认该 Agent 已发布、允许加入且 Skill／Tool 依赖完整。')
  } finally {
    addingAgent.value = false
  }
}

const agentActionCopy: Record<'disable' | 'enable' | 'upgrade' | 'remove', { label: string; confirm: string }> = {
  disable: { label: '停用', confirm: '停用后阻止该 Agent 的后续启动、续写与重试；排队与在途运行按既有取消链路收敛，历史消息与成果保留。' },
  enable: { label: '重新启用', confirm: '重新启用后成员可以再次使用该 Agent 发起新对话；既有会话仍固定原版本。' },
  upgrade: { label: '升级', confirm: '升级只影响新会话的默认版本；既有 Session、Run 与 Attempt 保持原快照。' },
  remove: { label: '移出', confirm: '移出后阻止后续启动、续写与重试；排队与在途运行按既有取消链路收敛，历史消息与成果保留。' },
}

async function runAgentAction(member: WorkspaceAgentMember, action: 'disable' | 'enable' | 'upgrade' | 'remove') {
  if (!member.allowedActions.includes(action)) return
  try {
    await ElMessageBox.confirm(
      agentActionCopy[action].confirm,
      `${agentActionCopy[action].label} Agent“${member.name}”？`,
      { confirmButtonText: agentActionCopy[action].label, cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  try {
    if (action === 'remove') await workbenchApi.removeWorkspaceAgentMember(props.workspaceId, member.id)
    else await workbenchApi.updateWorkspaceAgentMember(props.workspaceId, member.id, { action })
    ElMessage.success(`已${agentActionCopy[action].label}“${member.name}”`)
    emit('refresh')
    if (props.loadAgentMembers) await refreshAgentMembers()
  } catch (error) {
    notifyActionFailure(`${agentActionCopy[action].label} Agent`, `Agent“${member.name}”`, error, '刷新成员列表确认当前状态后重试。')
  }
}

function startConversation(member: WorkspaceAgentMember) {
  if (!member.allowedActions.includes('start_conversation')) return
  emit('start-conversation', member.id)
}

function agentStatusLabel(member: WorkspaceAgentMember) {
  if (member.status !== 'available') return '已停用'
  return member.unavailableReason ? '不可用' : '可用'
}

function agentStatusTone(member: WorkspaceAgentMember) {
  if (member.status !== 'available') return 'neutral'
  return member.unavailableReason ? 'danger' : 'success'
}

function close() {
  emit('update:open', false)
}

onBeforeUnmount(() => {
  if (agentSearchTimer) clearTimeout(agentSearchTimer)
})
</script>

<template>
  <el-dialog
    :model-value="open"
    class="member-dialog"
    title="管理 Agent"
    width="min(600px, calc(100vw - 32px))"
    :append-to-body="false"
    @update:model-value="emit('update:open', $event)"
  >
    <div class="member-dialog__body">
      <p class="member-dialog__hint">
        Agent 成员只按关联版本与可用状态呈现；添加与生命周期操作限负责人。
      </p>

      <section data-testid="member-section-agent" class="member-dialog__section">
        <header class="member-dialog__section-heading">
          <h3>Agent</h3>
          <span>{{ agentMemberList.length }} 个 Agent</span>
        </header>

        <div v-if="agentMemberList.length" class="member-dialog__list">
          <article
            v-for="member in agentMemberList"
            :key="member.id"
            data-testid="agent-member-row"
            class="member-dialog__row"
          >
            <span class="member-dialog__agent-icon"><el-icon><Cpu /></el-icon></span>
            <div class="member-dialog__copy">
              <strong>{{ member.name }}</strong>
              <span>{{ member.description }}</span>
            </div>
            <el-tooltip
              :content="member.unavailableReason || agentStatusLabel(member)"
              placement="top"
            >
              <span
                data-testid="agent-status-tooltip"
                class="member-dialog__status"
                :class="`member-dialog__status--${agentStatusTone(member)}`"
                :aria-label="`Agent 状态：${agentStatusLabel(member)}`"
              />
            </el-tooltip>
            <div class="member-dialog__actions">
              <el-button
                v-if="!archived && member.allowedActions.includes('start_conversation')"
                data-testid="agent-start-conversation"
                plain
                @click="startConversation(member)"
              >
                开始对话
              </el-button>
              <el-button
                v-if="!archived && member.allowedActions.includes('disable')"
                data-testid="agent-action-disable"
                plain
                @click="runAgentAction(member, 'disable')"
              >
                停用
              </el-button>
              <el-button
                v-if="!archived && member.allowedActions.includes('enable')"
                data-testid="agent-action-enable"
                plain
                @click="runAgentAction(member, 'enable')"
              >
                重新启用
              </el-button>
              <el-button
                v-if="!archived && member.allowedActions.includes('upgrade')"
                data-testid="agent-action-upgrade"
                plain
                @click="runAgentAction(member, 'upgrade')"
              >
                升级
              </el-button>
              <el-button
                v-if="!archived && member.allowedActions.includes('remove')"
                data-testid="agent-action-remove"
                plain
                @click="runAgentAction(member, 'remove')"
              >
                移出
              </el-button>
            </div>
          </article>
        </div>

        <p v-else data-testid="agent-empty" class="member-dialog__empty">
          <span>尚未加入 Agent</span>
          <small v-if="isOwner">从平台已发布且允许加入本空间的 Agent 中选择，确认职责与依赖后加入。</small>
          <small v-else>请联系负责人添加可用的 Agent。</small>
        </p>

        <p v-if="loadAgentError" class="member-dialog__warning">{{ loadAgentError }}</p>

        <div v-if="isOwner && !archived" class="member-dialog__add">
          <el-button data-testid="member-add-agent" :icon="Plus" :loading="loadingAgents" @click="openAgentSearch">
            添加 Agent
          </el-button>
        </div>

        <div v-if="candidate.open" class="member-dialog__picker">
          <el-input
            data-testid="member-agent-search"
            :model-value="candidate.query"
            :prefix-icon="Search"
            placeholder="输入名称搜索平台已发布 Agent"
            clearable
            @update:model-value="onAgentSearchInput"
          />
          <div v-if="candidate.items.length" class="member-dialog__picker-list">
            <article
              v-for="item in candidate.items"
              :key="item.agentId"
              data-testid="agent-candidate-row"
              class="member-dialog__picker-row"
            >
              <div class="member-dialog__copy">
                <strong>{{ item.name }}</strong>
                <span>{{ item.description }} · 固定版本 {{ item.activeVersion }}</span>
              </div>
              <el-button @click="selectAgentCandidate(item)">查看详情</el-button>
            </article>
          </div>
          <p v-else-if="!candidate.loading" class="member-dialog__empty">没有可加入的 Agent</p>

          <div v-if="candidate.selected" data-testid="agent-candidate-detail" class="member-dialog__detail">
            <h4>{{ candidate.selected.name }}</h4>
            <dl>
              <div>
                <dt>职责</dt>
                <dd>{{ candidate.selected.description || '—' }}</dd>
              </div>
              <div>
                <dt>关联技能</dt>
                <dd>{{ candidate.selected.skillNames?.join('、') || '详情待平台补充' }}</dd>
              </div>
              <div>
                <dt>所需工具</dt>
                <dd>{{ candidate.selected.toolNames?.join('、') || '详情待平台补充' }}</dd>
              </div>
              <div>
                <dt>数据范围</dt>
                <dd>{{ candidate.selected.dataScope || '详情待平台补充' }}</dd>
              </div>
            </dl>
            <el-button
              type="primary"
              data-testid="agent-candidate-confirm"
              :loading="addingAgent"
              @click="confirmAddAgent"
            >
              确认加入
            </el-button>
          </div>
        </div>
      </section>

      <footer class="member-dialog__footer">
        <el-button data-testid="member-dialog-close" @click="close">关闭</el-button>
      </footer>
    </div>
  </el-dialog>
</template>

<style scoped>
.member-dialog__footer {
  display: flex;
  justify-content: flex-end;
  padding-top: 4px;
}

.member-dialog__body {
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-height: 62vh;
  overflow-y: auto;
}

.member-dialog__hint {
  margin: 0;
  color: #8b918c;
  font-size: var(--dsh-font-size-micro);
  line-height: 1.6;
}

.member-dialog__section {
  padding: 13px;
  border: 1px solid #e6e8e5;
  border-radius: 11px;
  background: #fff;
}

.member-dialog__section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.member-dialog__section-heading h3 {
  margin: 0;
  color: #303430;
  font-size: var(--dsh-font-size-caption);
  font-weight: 650;
}

.member-dialog__section-heading span {
  color: #9ba09c;
  font-size: var(--dsh-font-size-micro);
}

.member-dialog__list {
  margin-top: 9px;
}

.member-dialog__row {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  min-height: 54px;
  padding: 7px 0;
  border-bottom: 1px solid #eef0ed;
}

.member-dialog__row:last-child {
  border-bottom: 0;
}

.member-dialog__agent-icon {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border-radius: 9px;
  color: #176750;
  background: #e8f5f0;
  font-size: var(--dsh-font-size-badge);
  font-weight: 650;
}

.member-dialog__copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.member-dialog__copy strong {
  overflow: hidden;
  color: #303530;
  font-size: var(--dsh-font-size-caption);
  font-weight: 630;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.member-dialog__copy span {
  margin-top: 3px;
  overflow: hidden;
  color: #909691;
  font-size: var(--dsh-font-size-micro);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.member-dialog__status {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #c3c8c4;
}

.member-dialog__status--success {
  background: #2e8b70;
}

/* 第三态「不可用」（available + 原因）：红点区分「已停用」的灰点。 */
.member-dialog__status--danger {
  background: var(--dsh-color-danger);
}

.member-dialog__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.member-dialog__empty,
.member-dialog__warning {
  margin: 9px 0 0;
  color: #909691;
  font-size: var(--dsh-font-size-micro);
  line-height: 1.6;
}

.member-dialog__empty {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.member-dialog__warning {
  color: #a4642a;
}

.member-dialog__add {
  margin-top: 10px;
}

.member-dialog__picker {
  margin-top: 10px;
  padding: 10px;
  border: 1px dashed #d7ded9;
  border-radius: 10px;
  background: #fafbf9;
}

.member-dialog__picker-list {
  margin-top: 8px;
}

.member-dialog__picker-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 0;
  border-bottom: 1px solid #eef0ed;
}

.member-dialog__picker-row:last-child {
  border-bottom: 0;
}

.member-dialog__detail {
  margin-top: 10px;
  padding: 11px;
  border: 1px solid #dfe7e2;
  border-radius: 10px;
  background: #fff;
}

.member-dialog__detail h4 {
  margin: 0 0 8px;
  color: #24443a;
  font-size: var(--dsh-font-size-caption);
  font-weight: 650;
}

.member-dialog__detail dl {
  margin: 0 0 10px;
}

.member-dialog__detail dl > div {
  display: grid;
  grid-template-columns: 74px minmax(0, 1fr);
  gap: 8px;
  padding: 5px 0;
}

.member-dialog__detail dt {
  color: #969b97;
  font-size: var(--dsh-font-size-micro);
}

.member-dialog__detail dd {
  margin: 0;
  color: #454a46;
  font-size: var(--dsh-font-size-micro);
  line-height: 1.55;
}

@media (max-width: 640px) {
  .member-dialog__row {
    grid-template-columns: 32px minmax(0, 1fr);
  }

  .member-dialog__actions {
    grid-column: 2 / -1;
  }
}
</style>
