<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { Refresh, Search, UserFilled } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { adminApi } from '@/api/client'
import { useListPagination } from '@/composables/use-list-pagination'
import { useAuthStore } from '@/stores/auth'
import type {
  DirectorySyncState,
  IdentityRoleSummary,
  IdentityUserPage,
  IdentityUserSummary,
  LocalPermissionDefinition,
} from '@/types/domain'

const authStore = useAuthStore()
const users = ref<IdentityUserSummary[]>([])
const roles = ref<IdentityRoleSummary[]>([])
const permissionDefinitions = ref<LocalPermissionDefinition[]>([])
const directoryState = ref<DirectorySyncState>()
const loading = ref(false)
const saving = ref(false)
const syncing = ref(false)
const error = ref('')
const query = ref('')
const statusFilter = ref<'all' | 'active' | 'disabled'>('all')
const currentPage = ref(1)
const userPageSize = 20
const userTotal = ref(0)
const userSummary = ref({ synchronized: 0, active: 0, authorized: 0 })
const activeTab = ref<'users' | 'roles'>('users')
const selectedUser = ref<IdentityUserSummary>()
const userDrawerOpen = ref(false)
const selectedRoleId = ref('')
const userScopes = ref<string[]>([])
const roleDialogOpen = ref(false)
const editingRole = ref<IdentityRoleSummary>()
const roleForm = reactive({
  code: '',
  name: '',
  description: '',
  status: 'active' as 'active' | 'disabled',
  permissions: [] as string[],
  dataScopes: [] as string[],
})

const assignableRoles = computed(() => roles.value.filter(role => (
  role.status === 'active'
  && !selectedUser.value?.roles.some(assigned => assigned.id === role.id)
)))
const groupedPermissions = computed(() => {
  const groups = new Map<string, LocalPermissionDefinition[]>()
  for (const permission of permissionDefinitions.value) {
    groups.set(permission.category, [...(groups.get(permission.category) ?? []), permission])
  }
  return [...groups.entries()].map(([category, items]) => ({ category, items }))
})
const { currentPage: rolePage, pagedItems: pagedRoles } = useListPagination(roles)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [nextUsers, nextRoles, nextPermissions, nextState] = await Promise.all([
      adminApi.getIdentityUsers(userListRequest()),
      adminApi.getIdentityRoles(),
      adminApi.getLocalPermissions(),
      adminApi.getDirectorySyncState(),
    ])
    applyUserPage(nextUsers)
    roles.value = nextRoles
    permissionDefinitions.value = nextPermissions
    directoryState.value = nextState
    refreshSelectedUser()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '身份与权限数据加载失败'
  } finally {
    loading.value = false
  }
}

async function synchronize(full = false) {
  if (!authStore.canManageIdentity) return
  if (full) {
    const confirmed = await ElMessageBox.confirm(
      '全量同步会从目录起点重新读取所有员工，但不会覆盖 dsh-work 中已配置的角色和数据范围。是否继续？',
      '确认全量同步',
      { type: 'warning', confirmButtonText: '开始全量同步' },
    ).then(() => true).catch(() => false)
    if (!confirmed) return
  }
  syncing.value = true
  error.value = ''
  try {
    directoryState.value = await adminApi.synchronizeDirectory(full)
    await load()
    ElMessage.success(`员工目录同步完成，共处理 ${directoryState.value?.synchronizedUsers ?? 0} 条变更`)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '员工目录同步失败'
  } finally {
    syncing.value = false
  }
}

function handleSyncCommand(command: string | number | object) {
  void synchronize(String(command) === 'full')
}

function openUser(user: IdentityUserSummary) {
  selectedUser.value = user
  selectedRoleId.value = ''
  userScopes.value = [...user.dataScopes]
  userDrawerOpen.value = true
}

async function grantRole() {
  if (!selectedUser.value || !selectedRoleId.value || !authStore.canManageIdentity) return
  saving.value = true
  try {
    const user = await adminApi.grantIdentityRole(selectedUser.value.id, { roleId: selectedRoleId.value })
    replaceUser(user)
    selectedRoleId.value = ''
    await refreshRoles()
    ElMessage.success('角色已分配，新的本地权限立即生效')
  } catch (cause) {
    showMutationError(cause, '角色分配失败')
  } finally {
    saving.value = false
  }
}

async function revokeRole(role: IdentityUserSummary['roles'][number]) {
  if (!selectedUser.value || !authStore.canManageIdentity) return
  const confirmed = await ElMessageBox.confirm(
    `确定从 ${selectedUser.value.name} 移除“${role.name}”角色？相关 Session 会立即按新权限重新计算。`,
    '移除角色',
    { type: 'warning', confirmButtonText: '移除角色' },
  ).then(() => true).catch(() => false)
  if (!confirmed) return
  saving.value = true
  try {
    const user = await adminApi.revokeIdentityRole(selectedUser.value.id, role.id)
    replaceUser(user)
    await refreshRoles()
    ElMessage.success('角色已移除')
  } catch (cause) {
    showMutationError(cause, '角色移除失败')
  } finally {
    saving.value = false
  }
}

async function saveUserScopes() {
  if (!selectedUser.value || !authStore.canManageIdentity) return
  saving.value = true
  try {
    const user = await adminApi.replaceIdentityUserScopes(selectedUser.value.id, userScopes.value)
    replaceUser(user)
    ElMessage.success('用户数据范围已保存')
  } catch (cause) {
    showMutationError(cause, '数据范围保存失败')
  } finally {
    saving.value = false
  }
}

async function revokeSessions() {
  if (!selectedUser.value || !authStore.canManageIdentity) return
  const confirmed = await ElMessageBox.confirm(
    `将撤销 ${selectedUser.value.name} 的全部登录 Session，需要重新登录。是否继续？`,
    '撤销登录 Session',
    { type: 'warning', confirmButtonText: '撤销 Session' },
  ).then(() => true).catch(() => false)
  if (!confirmed) return
  saving.value = true
  try {
    const result = await adminApi.revokeIdentityUserSessions(selectedUser.value.id)
    selectedUser.value.activeSessionCount = 0
    const target = users.value.find(user => user.id === selectedUser.value?.id)
    if (target) target.activeSessionCount = 0
    ElMessage.success(`已撤销 ${result.revokedSessions} 个 Session`)
  } catch (cause) {
    showMutationError(cause, 'Session 撤销失败')
  } finally {
    saving.value = false
  }
}

function openCreateRole() {
  editingRole.value = undefined
  Object.assign(roleForm, {
    code: '', name: '', description: '', status: 'active', permissions: [], dataScopes: [],
  })
  roleDialogOpen.value = true
}

function openEditRole(role: IdentityRoleSummary) {
  editingRole.value = role
  Object.assign(roleForm, {
    code: role.code,
    name: role.name,
    description: role.description,
    status: role.status,
    permissions: [...role.permissions],
    dataScopes: [...role.dataScopes],
  })
  roleDialogOpen.value = true
}

async function saveRole() {
  if (!authStore.canManageIdentity || !roleForm.name.trim()) return
  saving.value = true
  try {
    if (editingRole.value) {
      await adminApi.updateIdentityRole(editingRole.value.id, {
        name: roleForm.name,
        description: roleForm.description,
        status: roleForm.status,
        permissions: roleForm.permissions,
        dataScopes: roleForm.dataScopes,
      })
    } else {
      await adminApi.createIdentityRole({
        code: roleForm.code,
        name: roleForm.name,
        description: roleForm.description,
        permissions: roleForm.permissions,
        dataScopes: roleForm.dataScopes,
      })
    }
    await Promise.all([refreshRoles(), refreshUsers()])
    roleDialogOpen.value = false
    ElMessage.success(editingRole.value ? '角色配置已保存' : '角色已创建')
  } catch (cause) {
    showMutationError(cause, '角色保存失败')
  } finally {
    saving.value = false
  }
}

async function refreshUsers() {
  applyUserPage(await adminApi.getIdentityUsers(userListRequest()))
  refreshSelectedUser()
}

async function reloadUsers(resetPage = false) {
  if (resetPage) currentPage.value = 1
  loading.value = true
  error.value = ''
  try {
    await refreshUsers()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '员工列表加载失败'
  } finally {
    loading.value = false
  }
}

function userListRequest() {
  return {
    query: query.value.trim(),
    status: statusFilter.value,
    page: currentPage.value,
    pageSize: userPageSize,
  }
}

function applyUserPage(result: IdentityUserPage) {
  users.value = result.items
  userTotal.value = result.total
  currentPage.value = result.page
  userSummary.value = result.summary
}

function changeUserPage(page: number) {
  currentPage.value = page
  void reloadUsers()
}

async function refreshRoles() {
  roles.value = await adminApi.getIdentityRoles()
}

function replaceUser(user: IdentityUserSummary) {
  const index = users.value.findIndex(item => item.id === user.id)
  if (index >= 0) users.value[index] = user
  selectedUser.value = user
  userScopes.value = [...user.dataScopes]
}

function refreshSelectedUser() {
  if (!selectedUser.value) return
  selectedUser.value = users.value.find(user => user.id === selectedUser.value?.id)
  if (selectedUser.value) userScopes.value = [...selectedUser.value.dataScopes]
}

function formatDate(value: string | null | undefined) {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('zh-CN', { hour12: false }) : '—'
}

function showMutationError(cause: unknown, fallback: string) {
  const message = cause instanceof Error ? cause.message : fallback
  error.value = message
  ElMessage.error(message)
}

onMounted(() => void load())
</script>

<template>
  <div class="ops-page identity-page">
    <el-alert
      v-if="error"
      :title="error"
      type="error"
      show-icon
      @close="error = ''"
    />
    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="AI Hub 仅提供登录身份和员工资料；角色、功能权限、数据范围与 Session 撤销全部由 dsh-work 管理。"
    />

    <section class="identity-summary">
      <article class="metric-card">
        <div class="metric-label">已同步员工</div>
        <div class="metric-value">{{ userSummary.synchronized }}</div>
        <div class="metric-detail">{{ userSummary.active }} 个 AI Hub 有效账号</div>
      </article>
      <article class="metric-card">
        <div class="metric-label">已授权员工</div>
        <div class="metric-value">{{ userSummary.authorized }}</div>
        <div class="metric-detail">至少具有一个本地角色</div>
      </article>
      <article class="metric-card">
        <div class="metric-label">本地角色</div>
        <div class="metric-value">{{ roles.length }}</div>
        <div class="metric-detail">{{ roles.filter(role => role.status === 'active').length }} 个启用</div>
      </article>
      <article class="metric-card sync-card">
        <div class="sync-card__copy">
          <div class="metric-label">员工目录</div>
          <strong>{{ directoryState?.applicationId ?? 'dsh-work' }} · {{ directoryState?.environment ?? '—' }}</strong>
          <span>最近成功：{{ formatDate(directoryState?.lastSucceededAt) }}</span>
          <span v-if="directoryState?.lastError" class="sync-card__error">{{ directoryState.lastError }}</span>
        </div>
        <div class="sync-card__actions">
          <el-tag :type="directoryState?.status === 'failed' ? 'danger' : directoryState?.status === 'running' ? 'warning' : 'success'" effect="plain">
            {{ directoryState?.status === 'failed' ? '失败' : directoryState?.status === 'running' ? '同步中' : '就绪' }}
          </el-tag>
          <el-dropdown v-if="authStore.canManageIdentity" trigger="click" @command="handleSyncCommand">
            <el-button type="primary" :icon="Refresh" :loading="syncing">同步员工</el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="incremental">增量同步</el-dropdown-item>
                <el-dropdown-item command="full" divided>重新全量同步</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </article>
    </section>

    <el-tabs v-model="activeTab" class="identity-tabs">
      <el-tab-pane label="员工授权" name="users">
        <section class="content-panel filter-panel">
          <div class="filter-bar">
            <el-input v-model="query" :prefix-icon="Search" clearable placeholder="搜索姓名、邮箱、员工标识或部门" @keyup.enter="reloadUsers(true)" @clear="reloadUsers(true)" />
            <el-select v-model="statusFilter" aria-label="筛选员工状态" @change="reloadUsers(true)">
              <el-option label="全部状态" value="all" />
              <el-option label="有效" value="active" />
              <el-option label="已停用" value="disabled" />
            </el-select>
            <el-button :icon="Search" @click="reloadUsers(true)">查询</el-button>
            <span class="filter-bar__meta">{{ userTotal }} 名员工</span>
          </div>
        </section>
        <section class="content-panel content-panel--flush">
          <el-table v-loading="loading" class="data-table" :data="users" empty-text="暂无匹配的已同步员工">
            <el-table-column label="员工" min-width="220">
              <template #default="scope">
                <div class="user-cell">
                  <span class="user-cell__avatar">{{ [...scope.row.name][0] ?? '用' }}</span>
                  <span><strong>{{ scope.row.name }}</strong><small>{{ scope.row.email ?? scope.row.externalUserId ?? '本地账号' }}</small></span>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="department" label="组织 / 部门" min-width="160" />
            <el-table-column label="本地角色" min-width="250">
              <template #default="scope">
                <div v-if="scope.row.roles.length" class="tag-list"><el-tag v-for="role in scope.row.roles" :key="role.id" effect="plain" :type="role.status === 'active' ? 'primary' : 'info'">{{ role.name }}</el-tag></div>
                <span v-else class="empty-value">尚未授权</span>
              </template>
            </el-table-column>
            <el-table-column label="账号状态" width="105"><template #default="scope"><el-tag :type="scope.row.status === 'active' ? 'success' : 'info'" effect="plain">{{ scope.row.status === 'active' ? '有效' : '已停用' }}</el-tag></template></el-table-column>
            <el-table-column label="活动 Session" width="115" align="center"><template #default="scope">{{ scope.row.activeSessionCount }}</template></el-table-column>
            <el-table-column label="目录同步" width="175"><template #default="scope">{{ formatDate(scope.row.directorySyncedAt) }}</template></el-table-column>
            <el-table-column label="操作" width="95" fixed="right"><template #default="scope"><el-button link type="primary" :icon="UserFilled" @click="openUser(scope.row)">{{ authStore.canManageIdentity ? '配置' : '查看' }}</el-button></template></el-table-column>
          </el-table>
          <div class="table-footer identity-pagination">
            <span>第 {{ currentPage }} 页，共 {{ userTotal }} 名员工</span>
            <el-pagination
              v-model:current-page="currentPage"
              background
              layout="prev, pager, next"
              :total="userTotal"
              :page-size="userPageSize"
              @current-change="changeUserPage"
            />
          </div>
        </section>
      </el-tab-pane>

      <el-tab-pane label="角色与权限" name="roles">
        <section class="content-panel role-toolbar">
          <div><strong>本地角色</strong><span>角色权限不发布到 AI Hub，变更后由服务端立即重新计算。</span></div>
          <el-button v-if="authStore.canManageIdentity" type="primary" @click="openCreateRole">新建角色</el-button>
        </section>
        <section class="content-panel content-panel--flush">
          <el-table v-loading="loading" class="data-table" :data="pagedRoles" empty-text="暂无角色">
            <el-table-column label="角色" min-width="210"><template #default="scope"><div class="role-cell"><strong>{{ scope.row.name }}</strong><code>{{ scope.row.code }}</code></div></template></el-table-column>
            <el-table-column label="功能权限" min-width="300"><template #default="scope"><div class="tag-list"><el-tag v-for="permission in scope.row.permissions" :key="permission" effect="plain">{{ permission }}</el-tag><span v-if="!scope.row.permissions.length" class="empty-value">未配置</span></div></template></el-table-column>
            <el-table-column label="数据范围" min-width="230"><template #default="scope"><span class="scope-copy">{{ scope.row.dataScopes.join('、') || '未配置' }}</span></template></el-table-column>
            <el-table-column prop="userCount" label="有效员工" width="100" align="center" />
            <el-table-column label="状态" width="90"><template #default="scope"><el-tag :type="scope.row.status === 'active' ? 'success' : 'info'" effect="plain">{{ scope.row.status === 'active' ? '启用' : '停用' }}</el-tag></template></el-table-column>
            <el-table-column label="操作" width="95" fixed="right"><template #default="scope"><el-button link type="primary" @click="openEditRole(scope.row)">{{ authStore.canManageIdentity ? '配置' : '查看' }}</el-button></template></el-table-column>
          </el-table>
          <div class="table-footer identity-pagination">
            <span>第 {{ rolePage }} 页，共 {{ roles.length }} 个角色</span>
            <el-pagination
              v-model:current-page="rolePage"
              background
              layout="prev, pager, next"
              :total="roles.length"
              :page-size="10"
            />
          </div>
        </section>
      </el-tab-pane>
    </el-tabs>

    <el-drawer v-model="userDrawerOpen" size="min(680px, 100vw)" title="员工授权配置">
      <template v-if="selectedUser">
        <section class="user-detail-hero">
          <span class="user-detail-hero__avatar">{{ [...selectedUser.name][0] ?? '用' }}</span>
          <div><h2>{{ selectedUser.name }}</h2><p>{{ selectedUser.email ?? '未提供邮箱' }} · {{ selectedUser.department }}</p></div>
          <el-tag :type="selectedUser.status === 'active' ? 'success' : 'info'" effect="plain">{{ selectedUser.status === 'active' ? 'AI Hub 有效' : 'AI Hub 已停用' }}</el-tag>
        </section>
        <el-alert v-if="selectedUser.status === 'disabled'" type="warning" :closable="false" show-icon title="该员工已在 AI Hub 停用，所有登录 Session 已撤销；本地授权配置会保留，便于审计或恢复。" />

        <section class="drawer-section">
          <div class="drawer-section__heading"><div><strong>角色</strong><span>决定可用功能和角色数据范围</span></div></div>
          <div class="assigned-roles">
            <div v-for="role in selectedUser.roles" :key="role.id" class="assigned-role">
              <span><strong>{{ role.name }}</strong><code>{{ role.code }}</code></span>
              <el-button v-if="authStore.canManageIdentity" link type="danger" :disabled="saving" @click="revokeRole(role)">移除</el-button>
            </div>
            <el-empty v-if="!selectedUser.roles.length" :image-size="56" description="尚未分配本地角色" />
          </div>
          <div v-if="authStore.canManageIdentity" class="inline-form">
            <el-select v-model="selectedRoleId" filterable placeholder="选择要分配的角色"><el-option v-for="role in assignableRoles" :key="role.id" :label="role.name" :value="role.id" /></el-select>
            <el-button type="primary" :loading="saving" :disabled="!selectedRoleId" @click="grantRole">分配角色</el-button>
          </div>
        </section>

        <section class="drawer-section">
          <div class="drawer-section__heading"><div><strong>用户数据范围</strong><span>与角色数据范围合并，不覆盖角色授权</span></div></div>
          <el-select v-model="userScopes" multiple filterable allow-create default-first-option :disabled="!authStore.canManageIdentity" placeholder="例如 region:east"><el-option v-for="scope in userScopes" :key="scope" :label="scope" :value="scope" /></el-select>
          <div v-if="authStore.canManageIdentity" class="drawer-section__actions"><el-button type="primary" :loading="saving" @click="saveUserScopes">保存数据范围</el-button></div>
        </section>

        <section class="drawer-section">
          <div class="drawer-section__heading"><div><strong>登录 Session</strong><span>{{ selectedUser.activeSessionCount }} 个有效 Session · 最近活动 {{ formatDate(selectedUser.lastSeenAt) }}</span></div></div>
          <el-button v-if="authStore.canManageIdentity" type="danger" plain :disabled="selectedUser.activeSessionCount === 0 || saving" @click="revokeSessions">撤销全部 Session</el-button>
        </section>
      </template>
    </el-drawer>

    <el-dialog v-model="roleDialogOpen" :title="editingRole ? `${authStore.canManageIdentity ? '配置' : '查看'}角色：${editingRole.name}` : '新建角色'" width="min(760px, calc(100vw - 32px))">
      <el-form label-position="top" :disabled="!authStore.canManageIdentity">
        <div class="form-grid">
          <el-form-item label="角色编码" required><el-input v-model="roleForm.code" :disabled="Boolean(editingRole)" placeholder="例如 knowledge_reviewer" /></el-form-item>
          <el-form-item label="角色名称" required><el-input v-model="roleForm.name" /></el-form-item>
        </div>
        <el-form-item label="角色说明"><el-input v-model="roleForm.description" type="textarea" :rows="2" maxlength="500" show-word-limit /></el-form-item>
        <el-form-item label="状态"><el-radio-group v-model="roleForm.status" :disabled="editingRole?.id === 'role-platform-admin'"><el-radio value="active">启用</el-radio><el-radio value="disabled">停用</el-radio></el-radio-group></el-form-item>
        <el-form-item label="功能权限">
          <div class="permission-groups">
            <section v-for="group in groupedPermissions" :key="group.category"><strong>{{ group.category }}</strong><el-checkbox-group v-model="roleForm.permissions"><el-checkbox v-for="permission in group.items" :key="permission.code" :value="permission.code" :disabled="editingRole?.id === 'role-platform-admin' && permission.code === 'admin:*'"><span>{{ permission.name }}</span><small>{{ permission.code }}</small></el-checkbox></el-checkbox-group></section>
          </div>
        </el-form-item>
        <el-form-item label="角色数据范围"><el-select v-model="roleForm.dataScopes" multiple filterable allow-create default-first-option placeholder="例如 department:supply-chain"><el-option v-for="scope in roleForm.dataScopes" :key="scope" :label="scope" :value="scope" /></el-select></el-form-item>
      </el-form>
      <template #footer><el-button @click="roleDialogOpen = false">{{ authStore.canManageIdentity ? '取消' : '关闭' }}</el-button><el-button v-if="authStore.canManageIdentity" type="primary" :loading="saving" :disabled="!roleForm.name.trim() || (!editingRole && !roleForm.code.trim())" @click="saveRole">{{ editingRole ? '保存角色' : '创建角色' }}</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.identity-summary { display: grid; grid-template-columns: repeat(3, minmax(150px, 1fr)) minmax(300px, 1.6fr); gap: var(--spacing-section); }
.sync-card { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
.sync-card__copy { display: flex; min-width: 0; flex-direction: column; }
.sync-card__copy strong { margin-top: 5px; color: var(--color-text-heading); font-size: var(--font-size-caption); }
.sync-card__copy span { margin-top: 5px; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.sync-card__copy .sync-card__error { color: var(--color-danger); }
.sync-card__actions { display: flex; flex: 0 0 auto; align-items: center; gap: 10px; }
.identity-tabs { width: 100%; }
.filter-bar .el-input { width: 340px; }
.filter-bar .el-select { width: 140px; }
.identity-pagination { justify-content: space-between; padding: 14px var(--spacing-card); }
.user-cell { display: flex; min-width: 0; align-items: center; gap: 10px; }
.user-cell__avatar, .user-detail-hero__avatar { display: grid; flex: 0 0 auto; place-items: center; border-radius: 50%; color: var(--color-primary); background: var(--color-primary-light); font-weight: var(--font-weight-title); }
.user-cell__avatar { width: 34px; height: 34px; }
.user-cell > span:last-child, .role-cell { display: flex; min-width: 0; flex-direction: column; }
.user-cell strong, .role-cell strong { color: var(--color-text-heading); font-size: var(--font-size-caption); }
.user-cell small, .role-cell code { margin-top: 3px; overflow: hidden; color: var(--color-text-muted); font-size: var(--font-size-badge); text-overflow: ellipsis; white-space: nowrap; }
.tag-list { display: flex; flex-wrap: wrap; gap: 5px; }
.empty-value, .scope-copy { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.role-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.role-toolbar > div { display: flex; flex-direction: column; }
.role-toolbar strong { color: var(--color-text-heading); }
.role-toolbar span { margin-top: 4px; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.user-detail-hero { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 14px; padding: var(--spacing-card); border-radius: var(--radius-card); background: var(--color-bg-subtle); }
.user-detail-hero__avatar { width: 48px; height: 48px; font-size: var(--font-size-heading); }
.user-detail-hero h2 { margin: 0; color: var(--color-text-heading); font-size: var(--font-size-title); }
.user-detail-hero p { margin: 5px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.drawer-section { margin-top: 22px; padding-top: 20px; border-top: 1px solid var(--color-border); }
.drawer-section__heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.drawer-section__heading > div { display: flex; flex-direction: column; }
.drawer-section__heading strong { color: var(--color-text-heading); }
.drawer-section__heading span { margin-top: 3px; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.assigned-roles { display: grid; gap: 8px; }
.assigned-role { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-tag); }
.assigned-role > span { display: flex; flex-direction: column; }
.assigned-role strong { color: var(--color-text-primary); font-size: var(--font-size-caption); }
.assigned-role code { margin-top: 3px; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.inline-form { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
.inline-form .el-select, .drawer-section > .el-select, .el-dialog .el-select { width: 100%; }
.inline-form .el-select { flex: 1; }
.drawer-section__actions { display: flex; justify-content: flex-end; margin-top: 12px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.permission-groups { display: grid; width: 100%; gap: 12px; }
.permission-groups section { padding: 12px; border: 1px solid var(--color-border); border-radius: var(--radius-tag); }
.permission-groups section > strong { display: block; margin-bottom: 8px; color: var(--color-text-heading); font-size: var(--font-size-caption); }
.permission-groups :deep(.el-checkbox-group) { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px 14px; }
.permission-groups :deep(.el-checkbox) { height: auto; margin: 0; align-items: flex-start; }
.permission-groups :deep(.el-checkbox__label) { display: flex; min-width: 0; flex-direction: column; line-height: 1.4; }
.permission-groups small { color: var(--color-text-muted); font-size: var(--font-size-micro); }
@media (max-width: 1100px) { .identity-summary { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 700px) { .identity-summary { grid-template-columns: 1fr; } .sync-card, .role-toolbar { align-items: stretch; flex-direction: column; } .sync-card__actions { justify-content: space-between; } .filter-bar, .filter-bar .el-input, .filter-bar .el-select { width: 100%; } .form-grid, .permission-groups :deep(.el-checkbox-group) { grid-template-columns: 1fr; } .user-detail-hero { grid-template-columns: auto 1fr; } .user-detail-hero > .el-tag { grid-column: 1 / -1; justify-self: start; } }
</style>
