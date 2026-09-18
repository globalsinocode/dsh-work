<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Search } from '@element-plus/icons-vue'

import { workbenchApi } from '@/api/client'
import type {
  TeamMemberRole,
  WorkspaceMember,
} from '@/types/domain'
import { notifyActionFailure } from '@/utils/feedback'
import { memberRoleCapabilities } from '@/utils/member-roles'

const props = withDefaults(
  defineProps<{
    open: boolean
    workspaceId: string
    workspaceName?: string
    /**
     * 当前操作人在该团队的员工角色。服务端契约尚未返回该字段（见 T6 报告
     * 缺口），父级无法判定时传 `null`，此时员工段只读、不渲染写入口。
     */
    currentUserRole?: TeamMemberRole | null
    /** 员工成员列表：需要 `GET /workspaces/:id/members`（T6 报告的后端缺口）。 */
    members?: WorkspaceMember[]
    /** 员工成员列表不可用时的说明（例如后端尚未提供列表接口）。 */
    membersWarning?: string
    /**
     * 空间是否已归档。归档属执行轨（3-T1/3-T2）：成员的**所有写入口**
     * 必须隐藏——服务端会 403，渲染出来只是让用户走进死路（design §2.7/§3）。
     * 例外：移除成员（紧急收权）与转交负责人仍可用，服务端显式 allowArchived。
     */
    archived?: boolean
  }>(),
  {
    workspaceName: '',
    currentUserRole: null,
    members: () => [],
    membersWarning: '',
    archived: false,
  },
)

const emit = defineEmits<{
  'update:open': [value: boolean]
  refresh: []
  'role-changed': []
}>()

const roleLabels: Record<TeamMemberRole, string> = {
  owner: '负责人',
  admin: '管理员',
  member: '成员',
  viewer: '只读成员',
}
const roleValues: TeamMemberRole[] = ['owner', 'admin', 'member', 'viewer']

const employeeSearch = ref<{
  open: boolean
  loading: boolean
  query: string
  items: Array<{ id: string; displayName: string; department: string }>
  nextCursor: string | null
}>({ open: false, loading: false, query: '', items: [], nextCursor: null })
const addingEmployee = ref('')

const isOwner = computed(() => props.currentUserRole === 'owner')
/**
 * 归档空间只保留治理动作：可移除成员、可转交负责人，其余写入口一律不渲染。
 * `canManageEmployees` 继续表示「有成员管理权限」，最终是否渲染写入口再与归档相与。
 */
const canManageEmployees = computed(() =>
  !props.archived && (isOwner.value || props.currentUserRole === 'admin'),
)
/**
 * 归档空间仍可移除成员（紧急收权）：`canRemove` 只依赖操作人角色与成员行，
 * 不受 `archived` 影响，因此移除按钮在归档态保持可见——这是刻意保留的治理例外。
 */
const ownerCount = computed(() => props.members.filter(member => member.role === 'owner').length)

/**
 * 严格照 plan 第 5 节权限矩阵推导员工段可写动作（实现见 utils/member-roles）：
 * 负责人可改全员；管理员只能改「成员／只读成员」，且不能改自己和其他管理员；
 * 最后负责人锁定。
 */
function editableRoles(member: WorkspaceMember): TeamMemberRole[] {
  return memberRoleCapabilities({
    actorRole: props.currentUserRole,
    member,
    ownerCount: ownerCount.value,
  }).editableRoles
}

/**
 * 当前操作人身份暂不可从服务端契约判定（见 T6 报告缺口）：无法确认「自己」
 * 是哪一行，因此管理员行一律按不可管理处理，绝不会误改或误移除自己。
 */
function isSelf(member: WorkspaceMember) {
  void member
  return false
}

/** 权限矩阵：负责人可移除全员；管理员只能移除「成员／只读成员」。 */
function canRemove(member: WorkspaceMember) {
  return memberRoleCapabilities({
    actorRole: props.currentUserRole,
    member,
    ownerCount: ownerCount.value,
  }).removable
}

function roleSelectValue(member: WorkspaceMember) {
  return roleValues.includes(member.role) ? member.role : 'member'
}

function isLastOwner(member: WorkspaceMember) {
  return memberRoleCapabilities({
    actorRole: props.currentUserRole,
    member,
    ownerCount: ownerCount.value,
  }).lastOwner
}

watch(() => props.members, () => {
  if (employeeSearch.value.open) void ensureEmployeeCandidates()
})

/** 已加入者按服务端口径排除，前端再按本地成员列表兜底去重。 */
async function ensureEmployeeCandidates(reset = true) {
  if (!canManageEmployees.value || !props.workspaceId) return
  if (reset) {
    employeeSearch.value.items = []
    employeeSearch.value.nextCursor = null
  }
  employeeSearch.value.loading = true
  try {
    const page = await workbenchApi.listMemberCandidates(props.workspaceId, {
      ...(employeeSearch.value.query ? { query: employeeSearch.value.query } : {}),
      ...(reset ? {} : employeeSearch.value.nextCursor ? { cursor: employeeSearch.value.nextCursor } : {}),
      limit: 10,
    })
    const joined = new Set(props.members.map(member => member.userId))
    const merged = reset ? page.items : [...employeeSearch.value.items, ...page.items]
    employeeSearch.value.items = merged.filter(item => !joined.has(item.id))
    employeeSearch.value.nextCursor = page.nextCursor
  } catch (error) {
    notifyActionFailure('搜索员工', '企业员工目录', error, '稍后重试；仍失败请联系管理员检查员工目录权限。')
  } finally {
    employeeSearch.value.loading = false
  }
}

let employeeSearchTimer: ReturnType<typeof setTimeout> | undefined
function onEmployeeSearchInput(value: string) {
  if (value === employeeSearch.value.query) return
  employeeSearch.value.query = value
  if (employeeSearchTimer) clearTimeout(employeeSearchTimer)
  employeeSearchTimer = setTimeout(() => void ensureEmployeeCandidates(), 300)
}

function openEmployeeSearch() {
  employeeSearch.value.open = true
  void ensureEmployeeCandidates()
}

async function addEmployee(candidateUserId: string) {
  if (addingEmployee.value) return
  addingEmployee.value = candidateUserId
  try {
    await workbenchApi.addWorkspaceMember(props.workspaceId, { userId: candidateUserId, role: 'member' })
    ElMessage.success('已添加员工成员')
    employeeSearch.value.open = false
    employeeSearch.value.query = ''
    emit('refresh')
  } catch (error) {
    notifyActionFailure('添加员工', `工作空间“${props.workspaceName}”`, error, '确认该员工在职、有应用访问资格且尚未加入本空间。')
  } finally {
    addingEmployee.value = ''
  }
}

async function changeMemberRole(member: WorkspaceMember, role: TeamMemberRole) {
  if (!editableRoles(member).includes(role) || role === member.role) return
  try {
    await workbenchApi.updateMemberRole(props.workspaceId, member.userId, { role })
    ElMessage.success(`已将“${member.displayName}”调整为${roleLabels[role]}`)
    emit('role-changed')
  } catch (error) {
    notifyActionFailure('调整角色', `成员“${member.displayName}”`, error, '确认你仍拥有该角色的任免权限后重试。')
  }
}

async function removeMember(member: WorkspaceMember) {
  if (!canRemove(member) || isLastOwner(member)) return
  try {
    await ElMessageBox.confirm(
      `移除后“${member.displayName}”立即失去该空间的后续访问；其已共享的贡献与作者归属保留，下载链接会重新鉴权。`,
      `移除成员“${member.displayName}”？`,
      { confirmButtonText: '移除成员', cancelButtonText: '取消', type: 'warning', confirmButtonClass: 'el-button--danger' },
    )
  } catch {
    return
  }
  try {
    await workbenchApi.removeWorkspaceMember(props.workspaceId, member.userId)
    ElMessage.success(`已移除“${member.displayName}”`)
    emit('refresh')
  } catch (error) {
    notifyActionFailure('移除成员', `成员“${member.displayName}”`, error, '确认你不是在移除最后一位负责人后重试。')
  }
}

function close() {
  emit('update:open', false)
}

onBeforeUnmount(() => {
  if (employeeSearchTimer) clearTimeout(employeeSearchTimer)
})

defineExpose({ ensureEmployeeCandidates })
</script>

<template>
  <el-dialog
    :model-value="open"
    class="member-dialog"
    title="管理成员"
    width="min(600px, calc(100vw - 32px))"
    :append-to-body="false"
    @update:model-value="emit('update:open', $event)"
  >
    <div class="member-dialog__body">
      <p class="member-dialog__hint">
        员工按负责人／管理员／成员／只读成员授权；Agent 成员请在「管理 Agent」中维护。
      </p>

      <section data-testid="member-section-employee" class="member-dialog__section">
        <header class="member-dialog__section-heading">
          <h3>员工</h3>
          <span>{{ members.length }} 位员工</span>
        </header>

        <p v-if="membersWarning" class="member-dialog__warning">{{ membersWarning }}</p>

        <div v-if="members.length" class="member-dialog__list">
          <article
            v-for="member in members"
            :key="member.userId"
            data-testid="member-row"
            class="member-dialog__row"
          >
            <span class="member-dialog__avatar">{{ Array.from(member.displayName)[0] ?? '成' }}</span>
            <div class="member-dialog__copy">
              <strong>{{ member.displayName }}</strong>
              <span v-if="member.department">· {{ member.department }}</span>
              <span v-if="isSelf(member)">本人</span>
            </div>

            <template v-if="canManageEmployees">
              <span v-if="isLastOwner(member)" data-testid="member-role-unique" class="member-dialog__role-unique">
                负责人（唯一）
              </span>
              <el-select
                v-else
                data-testid="member-role-select"
                class="member-dialog__role"
                :model-value="roleSelectValue(member)"
                :disabled="editableRoles(member).length === 0"
                :aria-label="`调整“${member.displayName}”的角色`"
                @change="changeMemberRole(member, $event)"
              >
                <el-option
                  v-for="role in roleValues"
                  :key="role"
                  :label="roleLabels[role]"
                  :value="role"
                  :disabled="!editableRoles(member).includes(role)"
                />
              </el-select>
            </template>

            <span
              v-else
              data-testid="member-role-readonly"
              class="member-dialog__role-readonly"
            >
              {{ roleLabels[member.role] }}
            </span>

            <!--
              移除成员不在 canManageEmployees 之内：归档空间的紧急撤权是刻意保留的
              治理例外（3-T1/3-T2 服务端显式 allowArchived），只由权限矩阵 canRemove 决定。
            -->
            <el-button
              v-if="canRemove(member) && !isLastOwner(member)"
              data-testid="member-remove"
              plain
              @click="removeMember(member)"
            >
              移除
            </el-button>
          </article>
        </div>

        <p v-else data-testid="member-empty" class="member-dialog__empty">尚未添加员工</p>

        <div v-if="canManageEmployees" class="member-dialog__add">
          <el-button data-testid="member-add-employee" :icon="Plus" @click="openEmployeeSearch">添加员工</el-button>
        </div>

        <div v-if="employeeSearch.open" class="member-dialog__picker">
          <el-input
            data-testid="member-candidate-search"
            :model-value="employeeSearch.query"
            :prefix-icon="Search"
            placeholder="输入姓名搜索企业员工"
            clearable
            @update:model-value="onEmployeeSearchInput"
          />
          <p class="member-dialog__picker-note">仅显示在职、有应用访问资格且尚未加入本空间的员工。</p>
          <div v-if="employeeSearch.items.length" class="member-dialog__picker-list">
            <article
              v-for="item in employeeSearch.items"
              :key="item.id"
              data-testid="member-candidate-row"
              class="member-dialog__picker-row"
            >
              <div class="member-dialog__copy">
                <strong>{{ item.displayName }}</strong>
                <span>{{ item.department }}</span>
              </div>
              <el-button :disabled="addingEmployee === item.id" @click="addEmployee(item.id)">加入</el-button>
            </article>
          </div>
          <p v-else-if="!employeeSearch.loading" class="member-dialog__empty">没有可添加的员工</p>
          <el-button
            v-if="employeeSearch.nextCursor"
            data-testid="member-candidate-more"
            text
            @click="ensureEmployeeCandidates(false)"
          >
            加载更多
          </el-button>
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

.member-dialog__avatar {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border-radius: 50%;
  color: #31443e;
  background: #d9ece3;
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

.member-dialog__role {
  width: 118px;
}

.member-dialog__role-unique,
.member-dialog__role-readonly {
  color: #6f756f;
  font-size: var(--dsh-font-size-micro);
}

.member-dialog__empty,
.member-dialog__warning,
.member-dialog__picker-note {
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

@media (max-width: 640px) {
  .member-dialog__row {
    grid-template-columns: 32px minmax(0, 1fr);
  }

  .member-dialog__role,
  .member-dialog__role-unique,
  .member-dialog__role-readonly {
    grid-column: 2 / -1;
  }
}
</style>
