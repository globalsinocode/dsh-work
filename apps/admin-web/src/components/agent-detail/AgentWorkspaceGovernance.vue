<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { StatusTag } from '@dsh-work/ui-core'
import { useListPagination } from '@/composables/use-list-pagination'
import { useContentStore } from '@/stores/content'
import type { AgentDefinition } from '@/types/domain'

const props = defineProps<{ agent: AgentDefinition; canManage: boolean }>()

const contentStore = useContentStore()
const saving = ref(false)
const loading = ref(false)
const loadError = ref('')
const joinedWorkspaces = computed(() => contentStore.agentJoinedWorkspaces[props.agent.id] ?? [])
const { currentPage, pagedItems } = useListPagination(joinedWorkspaces, { resetOn: () => props.agent.id })

async function load() {
  loading.value = true
  try {
    await contentStore.loadAgentJoinedWorkspaces(props.agent.id)
    loadError.value = ''
  } catch (cause) {
    loadError.value = cause instanceof Error ? cause.message : '无法读取已加入空间'
  } finally {
    loading.value = false
  }
}

/** 关闭后该 Agent 不再出现在团队空间「添加 Agent」候选，也不能被加入；已加入的空间与既有授权不受影响。 */
async function toggle(next: boolean) {
  try {
    await ElMessageBox.confirm(
      next
        ? '开启后该 Agent 会重新出现在团队空间的「添加 Agent」搜索结果中。'
        : '关闭后该 Agent 不再出现在团队空间的「添加 Agent」搜索结果中，也不能被加入；已加入的成员关联与既有授权不受影响。',
      `${next ? '开启' : '关闭'}「允许加入团队空间」“${props.agent.name}”？`,
      { confirmButtonText: `确认${next ? '开启' : '关闭'}`, cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  saving.value = true
  try {
    await contentStore.setAgentWorkspaceJoin(props.agent.id, next)
    ElMessage.success(`已${next ? '开启' : '关闭'}「允许加入团队空间」，操作已写入审计`)
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '修改失败')
  } finally {
    saving.value = false
  }
}

function formatTime(value: string) {
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('zh-CN', { hour12: false }) : value
}

watch(() => props.agent.id, load)
onMounted(load)
</script>

<template>
  <section class="content-panel workspace-governance" aria-label="团队空间">
    <div class="governance-row">
      <div>
        <strong>允许加入团队空间</strong>
        <p>关闭后该 Agent 不再出现在团队空间的「添加 Agent」搜索结果中，也不能被加入；已加入的空间、成员关联与既有授权不受影响。</p>
      </div>
      <el-switch
        v-if="canManage"
        :model-value="agent.allowWorkspaceJoin"
        :loading="saving"
        active-text="允许"
        inactive-text="禁止"
        data-action="toggle-agent-workspace-join"
        @change="(value: string | number | boolean) => toggle(value === true)"
      />
      <StatusTag v-else :status="agent.allowWorkspaceJoin ? 'published' : 'disabled'" :label="agent.allowWorkspaceJoin ? '允许加入' : '禁止加入'" />
    </div>
    <h3>已加入空间 <span class="tab-count">{{ joinedWorkspaces.length }}</span></h3>
    <el-alert v-if="loadError" type="error" :closable="false" :title="loadError">
      <el-button link type="primary" @click="load">重新读取</el-button>
    </el-alert>
    <el-table v-else v-loading="loading" class="data-table" :data="pagedItems" empty-text="该 Agent 尚未加入任何团队空间">
      <el-table-column prop="workspaceName" label="空间" min-width="180" />
      <el-table-column label="固定版本" width="100"><template #default="scope"><span class="mono">v{{ scope.row.version }}</span></template></el-table-column>
      <el-table-column label="成员状态" width="110"><template #default="scope"><StatusTag :status="scope.row.memberStatus === 'available' ? 'published' : 'disabled'" :label="scope.row.memberStatus === 'available' ? '可用' : '已停用'" /></template></el-table-column>
      <el-table-column prop="addedBy" label="加入人" min-width="120" />
      <el-table-column label="加入时间" width="165"><template #default="scope">{{ formatTime(scope.row.createdAt) }}</template></el-table-column>
    </el-table>
    <el-pagination v-model:current-page="currentPage" class="list-pagination" background hide-on-single-page layout="prev, pager, next" :total="joinedWorkspaces.length" :page-size="10" />
  </section>
</template>

<style scoped>
.workspace-governance { margin-top: 14px; padding: 18px; }
.workspace-governance h3 { margin: 16px 0 9px; color: var(--color-text-heading); font-size: var(--font-size-body); }
.governance-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; padding: 14px; border: 1px solid var(--color-border); border-radius: var(--radius-button); background: var(--color-bg-subtle); }
.governance-row strong { color: var(--color-text-heading); font-size: var(--font-size-caption); }
.governance-row p { margin: 5px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-badge); line-height: 1.6; }
.mono { font-family: monospace; }
</style>
