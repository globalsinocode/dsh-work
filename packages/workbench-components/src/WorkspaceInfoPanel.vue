<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { ArrowDown, ArrowRight, Cpu, FolderOpened, Lock, Setting, UserFilled } from '@element-plus/icons-vue'

import { StatusTag } from '@dsh-work/ui-core'
import { describeWorkspaceActivity, type WorkspaceActivityKind } from './workspace-activity'

// 桌面右栏与移动抽屉可能同时存在实例；组件级唯一 id 让 aria-controls 指向自己的面板。
const membersPanelId = useId()
const agentsPanelId = useId()

type TeamMemberRole = 'owner' | 'admin' | 'member' | 'viewer'

interface WorkspaceInfo {
  name: string
  description: string
  type: 'personal' | 'team'
  memberCount: number
  owner: string
  members: string[]
  /** 服务端返回的团队归档状态（3-T2 起 `/workspaces` 恒返回）。 */
  status?: 'active' | 'archived'
}

interface WorkspaceAgentMemberInfo {
  id: string
  name: string
  description?: string
  status: 'available' | 'disabled'
  /**
   * 「不可用」第三态的具体原因（5-T1）：status 仍为 available，但版本失效／平台
   * 未授权／Runtime 不可用时由服务端给出；status 为 disabled 时恒为 null。
   */
  unavailableReason?: string | null
}

/**
 * 右栏「最近动态」摘要项（TW-08 / design §2.9）。由宿主加载并传入，面板自身不发
 * 请求；`fileName` 由宿主从文件列表解析，解析不到时不传（显示中性占位）。
 */
interface WorkspaceActivityInfo {
  id: string
  kind: WorkspaceActivityKind
  actorDisplayName: string
  safeMetadata: Record<string, unknown>
  fileName?: string
  /** 相对时间或日期。 */
  time: string
  /** 原始 ISO 时间，供 `<time datetime>` 使用。 */
  occurredAt?: string
}

/**
 * 右栏「空间用量」摘要（TW-09 / design §2.10）。只接收合计的三个展示字段；
 * 面板自身不发请求，角色门禁与加载由宿主负责（AC-30）。
 */
interface WorkspaceUsageSummaryInfo {
  callCount: number
  totalTokens: number
  /** 其中平台估算（非 DSH 上报）的次数；> 0 时明示。 */
  estimatedCount: number
}

const props = withDefaults(
  defineProps<{
    workspace: WorkspaceInfo
    dataScopes: string[]
    collapsible?: boolean
    /** 当前操作人在该团队的员工角色；无法判定时传 null，团队写入口不渲染。 */
    currentUserRole?: TeamMemberRole | null
    /** Agent 成员摘要：由宿主按既有 T4 接口加载后传入，面板自身不发请求。 */
    agentMembers?: WorkspaceAgentMemberInfo[]
    /** 最近动态摘要（最多 3 条）：由宿主加载后传入。 */
    activityItems?: WorkspaceActivityInfo[]
    /** 摘要首屏加载中。 */
    activityLoading?: boolean
    /** 摘要加载失败：就地显示错误与「重试」，不清空面板其它区块。 */
    activityError?: boolean
    /** 未读/静音状态加载失败：仍给「重试」，不把「加载失败」伪装成「没有未读」。 */
    notificationError?: boolean
    /** 服务端未读计数。 */
    unreadCount?: number
    /** 调用者本人是否关闭了该空间的提醒。 */
    muted?: boolean
    /** 是否渲染「空间用量」区块（仅团队 + 负责人/管理员；宿主判定，面板不发请求）。 */
    canViewUsage?: boolean
    /** 用量摘要（totals 的三个展示字段）：由宿主加载后传入。 */
    usageSummary?: WorkspaceUsageSummaryInfo | null
    /** 用量摘要加载中。 */
    usageLoading?: boolean
    /** 用量摘要加载失败：就地错误 + 「重试」，绝不渲染成零消耗。 */
    usageError?: boolean
    /**
     * 紧凑模式（项目任务详情的右栏）：面板标题由宿主指定，只保留成员与最近动态的一行摘要；
     * 空间概况、成员列表、Agent 列表、用量、设置与页脚不渲染。
     */
    compact?: boolean
    /** 面板标题；缺省为“工作空间信息”。 */
    title?: string
  }>(),
  {
    compact: false,
    title: '工作空间信息',
    collapsible: false,
    currentUserRole: null,
    agentMembers: () => [],
    activityItems: () => [],
    activityLoading: false,
    activityError: false,
    notificationError: false,
    unreadCount: 0,
    muted: false,
    canViewUsage: false,
    usageSummary: null,
    usageLoading: false,
    usageError: false,
  },
)

const emit = defineEmits<{
  collapse: []
  'manage-members': []
  /**
   * 打开「管理 Agent」弹窗（负责人-only，与服务端写轨一致）：Agent 的添加与
   * 生命周期操作全部限 owner，admin/member 在名册上已可读，不再给空入口。
   */
  'manage-agents': []
  'open-settings': []
  /** 打开「查看全部」动态抽屉；携带触发元素用于关闭后恢复焦点（design §4）。 */
  'view-all-activity': [event?: MouseEvent]
  'mark-activity-read': []
  'toggle-activity-mute': []
  'retry-activity': []
  /** 打开「空间用量」详情；携带触发元素用于关闭后恢复焦点（design §4）。 */
  'view-usage-detail': [event?: MouseEvent]
  /** 用量摘要加载失败后的原地重试。 */
  'retry-usage': []
}>()

/** 摘要固定只展示最新 3 条（服务端以 `limit=3` 取数，这里再兜一层）。 */
const visibleActivity = computed(() => props.activityItems.slice(0, 3))
/**
 * 静音后按服务端口径把未读视为 0：即使服务端仍返回数字也不显示徽标，但动态
 * 列表一条都不过滤（TW-08「关闭提醒仍可在动态里看到」）。
 */
const effectiveUnread = computed(() => {
  if (props.muted) return 0
  const count = props.unreadCount
  // 越界值（负数/小数/1e9/NaN）不得变成「-5 条未读」「2.5 条未读」这类文案。
  return Number.isFinite(count) && count >= 1 ? Math.floor(count) : 0
})

/**
 * 项目空间 S2：成员与 Agent 区块可收起。收起状态只是本浏览器的偏好，读写失败时按展开处理。
 */
type CollapsibleSection = 'members' | 'agents'
const collapsedSections = ref<Record<CollapsibleSection, boolean>>({
  members: readSectionCollapsed('members'),
  agents: readSectionCollapsed('agents'),
})

function sectionStorageKey(section: CollapsibleSection) {
  return `dsh-work.workspace-panel.${section}.collapsed`
}

function readSectionCollapsed(section: CollapsibleSection) {
  try {
    return window.localStorage.getItem(sectionStorageKey(section)) === '1'
  } catch {
    return false
  }
}

function toggleSection(section: CollapsibleSection) {
  const next = !collapsedSections.value[section]
  collapsedSections.value = { ...collapsedSections.value, [section]: next }
  try {
    window.localStorage.setItem(sectionStorageKey(section), next ? '1' : '0')
  } catch {
    // 偏好未能保存不影响当前展示。
  }
}

function memberInitial(name: string) {
  return Array.from(name)[0] ?? '成'
}

function agentStatusLabel(agent: WorkspaceAgentMemberInfo) {
  if (agent.status !== 'available') return '已停用'
  return agent.unavailableReason ? '不可用' : '可用'
}

/** 第三态用红色状态点（design §2.6/§3）：可用绿／已停用灰／不可用红。 */
function agentStatusTone(agent: WorkspaceAgentMemberInfo) {
  if (agent.status !== 'available') return 'neutral'
  return agent.unavailableReason ? 'danger' : 'available'
}

/** tooltip 优先展示不可用原因；可用/停用时回落到状态文案。 */
function agentStatusTooltip(agent: WorkspaceAgentMemberInfo) {
  return agent.unavailableReason || agentStatusLabel(agent)
}

/** 只用 kind + safeMetadata + 演员名 +（可选）文件名生成描述，绝不使用 id 当名称。 */
function activityDescription(item: WorkspaceActivityInfo) {
  return describeWorkspaceActivity({
    kind: item.kind,
    actorDisplayName: item.actorDisplayName,
    safeMetadata: item.safeMetadata,
    fileName: item.fileName,
  })
}

/**
 * 用量计数一律规范化：越界值（负数/小数/NaN/1e9）不得渲染成「-5 次调用」或
 * 「NaN tokens」。只保留非负整数（小数向下取整，沿用未读徽标的既有口径）。
 */
function normalizeUsageCount(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : 0
}

const usageCallCount = computed(() => normalizeUsageCount(props.usageSummary?.callCount))
const usageTotalTokens = computed(() => normalizeUsageCount(props.usageSummary?.totalTokens))
const usageEstimatedCount = computed(() => normalizeUsageCount(props.usageSummary?.estimatedCount))
</script>

<template>
  <div class="workspace-info-panel">
    <header class="workspace-info-panel__header">
      <strong>{{ title }}</strong>
      <button
        v-if="collapsible"
        class="workspace-info-panel__collapse"
        type="button"
        aria-label="收起工作空间信息"
        @click="emit('collapse')"
      >
        <el-icon><ArrowRight /></el-icon>
      </button>
    </header>

    <!-- 宿主放在面板标题之下、空间概况之前的卡片（如项目简报）。 -->
    <slot name="lead" />

    <section v-if="!compact" class="workspace-info-panel__card workspace-info-panel__overview">
    <div class="workspace-info-panel__hero">
      <div class="workspace-info-panel__status">
        <span class="workspace-info-panel__folder"><el-icon><FolderOpened /></el-icon></span>
        <span class="workspace-info-panel__tags">
          <StatusTag status="neutral" :label="workspace.type === 'personal' ? '个人工作空间' : '项目空间'" />
          <StatusTag
            v-if="workspace.type === 'team' && workspace.status === 'archived'"
            data-testid="panel-archived-tag"
            status="warning"
            label="已归档"
          />
        </span>
      </div>
      <h2>{{ workspace.name }}</h2>
      <p>{{ workspace.description }}</p>
    </div>

    <dl class="workspace-info-panel__facts">
      <div>
        <dt>{{ workspace.type === 'personal' ? '空间归属' : '负责人' }}</dt>
        <dd>{{ workspace.type === 'personal' ? '仅你本人' : workspace.owner }}</dd>
      </div>
      <div>
        <dt>我的访问</dt>
        <dd>{{ workspace.type === 'personal' ? '本人 · 可发起对话' : '空间成员 · 可发起对话' }}</dd>
      </div>
      <div>
        <dt>企业数据范围</dt>
        <dd>{{ dataScopes.length ? dataScopes.join('、') : '按企业身份注入' }}</dd>
      </div>
    </dl>

    <div class="workspace-info-panel__permission-note">
      <el-icon><Lock /></el-icon>
      <span v-if="workspace.type === 'personal'">此处发起的对话自动归入你的个人空间，仅你可以访问；企业数据仍按当前身份权限提供。</span>
      <span v-else>此处发起的对话自动归入当前空间；工作空间只能收窄权限，不能扩大你的企业数据范围。</span>
    </div>
    </section>

    <section v-if="workspace.type === 'team'" class="workspace-info-panel__card workspace-info-panel__section">
      <div class="workspace-info-panel__section-heading">
        <div>
          <h3>
            <template v-if="compact">成员</template>
            <button
              v-else
              class="workspace-info-panel__toggle"
              type="button"
              data-testid="panel-members-toggle"
              :aria-expanded="!collapsedSections.members"
              :aria-controls="membersPanelId"
              @click="toggleSection('members')"
            >
              <el-icon class="workspace-info-panel__chevron" :class="{ 'is-collapsed': collapsedSections.members }"><ArrowDown /></el-icon>
              成员
            </button>
          </h3>
          <span data-testid="panel-employee-count">{{ workspace.memberCount }} 位员工<template v-if="compact"> · {{ agentMembers.length }} 个 Agent</template></span>
        </div>
        <button
          v-if="currentUserRole === 'owner' || currentUserRole === 'admin'"
          data-testid="panel-manage-members"
          class="workspace-info-panel__link"
          type="button"
          @click="emit('manage-members')"
        >
          管理成员
        </button>
      </div>

      <div
        v-if="!compact"
        v-show="!collapsedSections.members"
        :id="membersPanelId"
        data-testid="panel-employee-section"
        class="workspace-member-list"
        :aria-label="`${workspace.name}员工成员`"
      >
        <span
          v-for="(member, index) in workspace.members.slice(0, 5)"
          :key="member"
          class="workspace-member"
          :style="{ '--member-index': index }"
          :title="member"
        >
          {{ memberInitial(member) }}
        </span>
        <span v-if="workspace.memberCount > workspace.members.slice(0, 5).length" class="workspace-member workspace-member--more">
          +{{ workspace.memberCount - workspace.members.slice(0, 5).length }}
        </span>
        <span class="workspace-member-list__names">{{ workspace.members.join('、') }}</span>
      </div>
    </section>

    <section
      v-if="workspace.type === 'team' && !compact"
      data-testid="panel-agent-section"
      class="workspace-info-panel__card workspace-info-panel__section"
    >
      <div class="workspace-info-panel__section-heading">
        <div>
          <h3>
            <button
              class="workspace-info-panel__toggle"
              type="button"
              data-testid="panel-agents-toggle"
              :aria-expanded="!collapsedSections.agents"
              :aria-controls="agentsPanelId"
              @click="toggleSection('agents')"
            >
              <el-icon class="workspace-info-panel__chevron" :class="{ 'is-collapsed': collapsedSections.agents }"><ArrowDown /></el-icon>
              Agent
            </button>
          </h3>
          <span data-testid="panel-agent-count">{{ agentMembers.length }} 个 Agent</span>
        </div>
        <!-- 归档空间不允许 Agent 变更，弹窗只剩只读列表（右栏已展示），因此不给入口；成员管理保留移除与转交等治理动作。 -->
        <button
          v-if="currentUserRole === 'owner' && workspace.status !== 'archived'"
          data-testid="panel-manage-agents"
          class="workspace-info-panel__link"
          type="button"
          @click="emit('manage-agents')"
        >
          管理 Agent
        </button>
      </div>
      <div v-show="!collapsedSections.agents" :id="agentsPanelId">
      <div v-if="agentMembers.length" class="workspace-agent-list">
        <article
          v-for="agent in agentMembers"
          :key="agent.id"
          data-testid="panel-agent-row"
          class="workspace-agent"
        >
          <span class="workspace-agent__icon"><el-icon><Cpu /></el-icon></span>
          <strong>{{ agent.name }}</strong>
          <el-tooltip :content="agentStatusTooltip(agent)" placement="top">
            <span
              data-testid="panel-agent-status"
              class="workspace-agent__status"
              :class="`workspace-agent__status--${agentStatusTone(agent)}`"
              :aria-label="`Agent 状态：${agentStatusLabel(agent)}`"
            />
          </el-tooltip>
        </article>
      </div>
      <p v-else class="workspace-info-panel__empty">尚未加入 Agent</p>
      <!-- 项目空间 S2：项目档案员是平台内置的系统运行，每个项目空间都有，不占 Agent 名额、不可移除。 -->
      <div class="workspace-agent-list">
        <article data-testid="panel-archivist-row" class="workspace-agent workspace-agent--system">
          <span class="workspace-agent__icon"><el-icon><Cpu /></el-icon></span>
          <strong>项目档案员</strong>
          <span class="workspace-agent__system">系统</span>
        </article>
      </div>
      </div>
    </section>

    <section
      v-if="canViewUsage && workspace.type === 'team' && !compact"
      data-testid="panel-usage-section"
      class="workspace-info-panel__card workspace-info-panel__section"
    >
      <div class="workspace-info-panel__section-heading">
        <div>
          <h3>空间用量</h3>
        </div>
        <button
          data-testid="panel-usage-view-detail"
          class="workspace-info-panel__link"
          type="button"
          @click="emit('view-usage-detail', $event)"
        >
          查看详情
        </button>
      </div>

      <el-skeleton
        v-if="usageLoading && !usageSummary && !usageError"
        data-testid="panel-usage-skeleton"
        class="workspace-info-panel__usage-skeleton"
        :rows="2"
        animated
      />

      <div
        v-else-if="usageError"
        data-testid="panel-usage-error"
        class="workspace-info-panel__usage-error"
      >
        <span>用量加载失败</span>
        <button
          data-testid="panel-usage-retry"
          class="workspace-info-panel__link"
          type="button"
          @click="emit('retry-usage')"
        >
          重试
        </button>
      </div>

      <template v-else-if="usageSummary">
        <p data-testid="panel-usage-summary" class="workspace-info-panel__usage-summary">
          近 7 天 {{ usageCallCount }} 次调用 · {{ usageTotalTokens }} tokens
        </p>
        <p
          v-if="usageEstimatedCount > 0"
          data-testid="panel-usage-estimated"
          class="workspace-info-panel__usage-estimated"
        >
          其中 {{ usageEstimatedCount }} 次为估算值
        </p>
      </template>
    </section>

    <section
      v-if="workspace.type === 'team'"
      data-testid="panel-activity-section"
      class="workspace-info-panel__card workspace-info-panel__section"
    >
      <div class="workspace-info-panel__section-heading">
        <div>
          <h3>最近动态</h3>
          <span
            v-if="effectiveUnread > 0"
            data-testid="panel-activity-unread"
            class="workspace-info-panel__unread"
            role="status"
            aria-live="polite"
          >{{ effectiveUnread }} 条未读</span>
          <span v-else-if="muted" class="workspace-info-panel__muted-note">已关闭提醒</span>
        </div>
        <button
          data-testid="panel-activity-view-all"
          class="workspace-info-panel__link"
          type="button"
          @click="emit('view-all-activity', $event)"
        >
          查看全部
        </button>
      </div>

      <div v-if="!compact" class="workspace-info-panel__activity-actions">
        <button
          v-if="effectiveUnread > 0"
          data-testid="panel-activity-mark-read"
          class="workspace-info-panel__link"
          type="button"
          @click="emit('mark-activity-read')"
        >
          标记全部已读
        </button>
        <button
          data-testid="panel-activity-mute"
          class="workspace-info-panel__link"
          type="button"
          @click="emit('toggle-activity-mute')"
        >
          {{ muted ? '恢复提醒' : '关闭提醒' }}
        </button>
      </div>

      <el-skeleton
        v-if="!compact && activityLoading && !activityItems.length"
        class="workspace-info-panel__activity-skeleton"
        :rows="3"
        animated
      />

      <div
        v-if="activityError || notificationError"
        data-testid="panel-activity-error"
        class="workspace-info-panel__activity-error"
      >
        <span>{{ activityError ? '动态加载失败' : '提醒状态加载失败' }}</span>
        <button
          data-testid="panel-activity-retry"
          class="workspace-info-panel__link"
          type="button"
          @click="emit('retry-activity')"
        >
          重试
        </button>
      </div>

      <ul v-if="!compact && visibleActivity.length" class="workspace-activity-list">
        <li
          v-for="item in visibleActivity"
          :key="item.id"
          data-testid="panel-activity-row"
          class="workspace-activity"
        >
          <span class="workspace-activity__text">{{ activityDescription(item) }}</span>
          <time class="workspace-activity__time" :datetime="item.occurredAt">{{ item.time }}</time>
        </li>
      </ul>

      <p
        v-else-if="!compact && !activityLoading && !activityError && !notificationError"
        data-testid="panel-activity-empty"
        class="workspace-info-panel__empty"
      >
        暂无项目动态
      </p>
    </section>

    <div v-if="!compact && workspace.type === 'team' && currentUserRole === 'owner'" class="workspace-info-panel__settings">
      <el-button data-testid="panel-workspace-settings" plain :icon="Setting" @click="emit('open-settings')">
        空间设置
      </el-button>
    </div>

    <footer v-if="!compact" class="workspace-info-panel__footer">
      <el-icon><UserFilled /></el-icon>
      <span v-if="workspace.type === 'personal'">系统已为你创建唯一的默认个人空间</span>
      <span v-else-if="workspace.status === 'archived'">该空间已归档，仅保留有权限的只读查看与下载；恢复入口由负责人操作。</span>
      <span v-else>项目空间用于同事与 Agent 协同完成项目</span>
    </footer>
  </div>
</template>

<style scoped>
/* “项目配置”式右栏：顶部标题 + 收起按钮，下方是一列独立卡片。 */
.workspace-info-panel {
  display: flex;
  height: 100%;
  flex-direction: column;
  gap: 12px;
  padding: 18px 16px 24px;
  overflow-y: auto;
  color: #2c302d;
  background: #fff;
}

.workspace-info-panel > * {
  flex: 0 0 auto;
}

.workspace-info-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 4px 6px;
}

.workspace-info-panel__header strong {
  color: #1d201e;
  font-size: var(--dsh-font-size-section);
  font-weight: 680;
}

.workspace-info-panel__card {
  padding: 16px 18px;
  border: 1px solid #ebecee;
  border-radius: 14px;
  background: #fff;
}

.workspace-info-panel__collapse {
  display: grid;
  width: 30px;
  height: 30px;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: 8px;
  color: #747a75;
  background: transparent;
  cursor: pointer;
}

.workspace-info-panel__collapse:hover {
  color: #202420;
  background: #eceeeb;
}

.workspace-info-panel__hero {
  padding: 0 0 14px;
}

.workspace-info-panel__tags {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.workspace-info-panel__status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.workspace-info-panel__folder {
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  border-radius: 10px;
  color: #176750;
  background: #e8f5f0;
  font-size: var(--dsh-font-size-section);
}

.workspace-info-panel__hero h2 {
  margin: 12px 0 0;
  color: #202320;
  font-size: var(--dsh-font-size-section);
  font-weight: 680;
  letter-spacing: -0.025em;
}

.workspace-info-panel__hero p {
  margin: 7px 0 0;
  color: #747a75;
  font-size: var(--dsh-font-size-caption);
  line-height: 1.65;
}

.workspace-info-panel__facts {
  margin: 0;
  padding: 0;
  border-top: 1px solid #eef0ed;
}

.workspace-info-panel__facts div {
  display: grid;
  grid-template-columns: 86px minmax(0, 1fr);
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid #eef0ed;
}

.workspace-info-panel__facts div:last-child {
  border-bottom: 0;
}

.workspace-info-panel__facts dt {
  color: #969b97;
  font-size: var(--dsh-font-size-badge);
}

.workspace-info-panel__facts dd {
  margin: 0;
  color: #454a46;
  font-size: var(--dsh-font-size-badge);
  line-height: 1.5;
  text-align: right;
}

.workspace-info-panel__permission-note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 10px;
  padding: 10px;
  border-radius: 9px;
  color: #517066;
  background: #edf6f2;
  font-size: var(--dsh-font-size-micro);
  line-height: 1.55;
}

.workspace-info-panel__permission-note .el-icon {
  flex: 0 0 auto;
  margin-top: 1px;
}

.workspace-info-panel__section {
  margin: 0;
}

.workspace-info-panel__section-heading,
.workspace-info-panel__section-heading > div {
  display: flex;
  align-items: center;
}

.workspace-info-panel__section-heading {
  justify-content: space-between;
  min-height: 29px;
  gap: 10px;
}

.workspace-info-panel__section-heading > div {
  gap: 7px;
}

.workspace-info-panel__section-heading h3 {
  margin: 0;
  color: #1d201e;
  font-size: var(--dsh-font-size-title);
  font-weight: 680;
}

.workspace-info-panel__section-heading span {
  color: #9ba09c;
  font-size: var(--dsh-font-size-micro);
}

.workspace-member-list {
  display: flex;
  min-width: 0;
  align-items: center;
  margin-top: 10px;
}

.workspace-member {
  display: grid;
  width: 29px;
  height: 29px;
  flex: 0 0 auto;
  margin-left: -5px;
  place-items: center;
  border: 2px solid #fff;
  border-radius: 50%;
  color: #31443e;
  background: hsl(calc(155 + var(--member-index, 0) * 13) 40% 86%);
  font-size: var(--dsh-font-size-badge);
  font-weight: 650;
}

.workspace-member:first-child {
  margin-left: 0;
}

.workspace-member--more {
  color: var(--dsh-color-muted);
  background: var(--dsh-color-canvas);
}

.workspace-member-list__names {
  min-width: 0;
  margin-left: 9px;
  overflow: hidden;
  color: var(--dsh-color-muted);
  font-size: var(--dsh-font-size-micro);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-info-panel__link {
  padding: 0;
  border: 0;
  color: #2a7a63;
  background: transparent;
  cursor: pointer;
  font-size: var(--dsh-font-size-micro);
  font-weight: 650;
}

.workspace-info-panel__link:hover {
  color: #1c5c49;
  text-decoration: underline;
}

.workspace-agent-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-top: 10px;
}

.workspace-agent {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr) 5px;
  align-items: center;
  gap: 8px;
}

.workspace-agent--system {
  grid-template-columns: 26px minmax(0, 1fr) auto;
}

.workspace-agent__system {
  padding: 0 6px;
  border-radius: 999px;
  color: #6f756f;
  background: #e9ebe8;
  font-size: var(--dsh-font-size-micro);
  line-height: 18px;
}

.workspace-info-panel__toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 28px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.workspace-info-panel__toggle:focus-visible {
  outline: 2px solid var(--dsh-color-brand);
  outline-offset: 2px;
  border-radius: 4px;
}

.workspace-info-panel__chevron {
  color: var(--dsh-color-subtle);
  transition: transform 0.15s ease;
}

.workspace-info-panel__chevron.is-collapsed {
  transform: rotate(-90deg);
}

.workspace-agent__icon {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border-radius: 7px;
  color: #176750;
  background: #e8f5f0;
  font-size: var(--dsh-font-size-badge);
}

.workspace-agent strong {
  overflow: hidden;
  color: #3b403c;
  font-size: var(--dsh-font-size-micro);
  font-weight: 620;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-agent__status {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #c3c8c4;
}

.workspace-agent__status--available {
  background: #2e8b70;
}

/* 第三态「不可用」（available + 原因）：红点，tooltip 展示具体原因。 */
.workspace-agent__status--danger {
  background: var(--dsh-color-danger);
}

.workspace-info-panel__empty {
  margin: 10px 0 0;
  color: #9ba09c;
  font-size: var(--dsh-font-size-micro);
}

/* 最近动态：未读徽标、已读／静音入口与摘要列表（design §2.9）。 */
.workspace-info-panel__section-heading .workspace-info-panel__unread {
  padding: 1px 6px;
  border-radius: 999px;
  color: #1c5c49;
  background: #e8f4ef;
  font-weight: 650;
}

.workspace-info-panel__activity-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}

.workspace-info-panel__activity-skeleton {
  margin-top: 8px;
  padding: 2px;
}

.workspace-info-panel__activity-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 10px;
  padding: 9px 10px;
  border-radius: 9px;
  color: #a04b52;
  background: #fdf1f2;
  font-size: var(--dsh-font-size-micro);
}

.workspace-activity-list {
  display: flex;
  flex-direction: column;
  gap: 9px;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}

.workspace-activity {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.workspace-activity__text {
  color: #454a46;
  font-size: var(--dsh-font-size-micro);
  line-height: 1.55;
  /* 文件名来自服务端数据，可能极长；必须就地折行，不能撑破右栏。 */
  overflow-wrap: anywhere;
  word-break: break-word;
}

.workspace-activity__time {
  color: #9ba09c;
  font-size: var(--dsh-font-size-micro);
}

/* 空间用量摘要（design §2.10）：只展示 token 与调用次数，界面上不出现任何金额字段。 */
.workspace-info-panel__usage-skeleton {
  margin-top: 8px;
  padding: 2px;
}

.workspace-info-panel__usage-summary {
  margin: 10px 0 0;
  color: #3b403c;
  font-size: var(--dsh-font-size-micro);
  font-weight: 620;
  line-height: 1.55;
}

.workspace-info-panel__usage-estimated {
  margin: 4px 0 0;
  color: #7d827d;
  font-size: var(--dsh-font-size-micro);
  line-height: 1.55;
}

.workspace-info-panel__usage-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 10px;
  padding: 9px 10px;
  border-radius: 9px;
  color: #a04b52;
  background: #fdf1f2;
  font-size: var(--dsh-font-size-micro);
}

.workspace-info-panel__settings {
  display: flex;
  justify-content: flex-end;
}

.workspace-info-panel__footer {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin-top: 4px;
  padding: 12px 4px 0;
  border-top: 1px solid #e5e8e4;
  color: #969b97;
  font-size: var(--dsh-font-size-micro);
  line-height: 1.5;
}

.workspace-info-panel__footer .el-icon {
  flex: 0 0 auto;
  margin-top: 1px;
}
</style>
