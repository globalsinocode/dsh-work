<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import { StatusTag } from '@dsh-work/ui-core'
import { adminApi } from '@/api/client'
import { useContentStore } from '@/stores/content'
import type { AgentVersionHistoryItem } from '@/types/domain'

/** 版本历史属于查看与运维：发布记录与回滚，不属于验证与发布流程。 */
const props = defineProps<{ agentId: string; canManage: boolean }>()

const contentStore = useContentStore()
const versions = ref<AgentVersionHistoryItem[]>([])
const error = ref('')
const loading = ref(false)
const busy = ref('')

async function load() {
  loading.value = true
  try {
    versions.value = (await adminApi.getAgentVersionHistory(props.agentId)).items
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法读取版本历史'
  } finally {
    loading.value = false
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
  busy.value = item.id
  try {
    await contentStore.rollbackAgent(props.agentId, item.version)
    ElMessage.success(`已回滚到 v${item.version}，操作已写入审计`)
    await load()
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '回滚失败')
  } finally {
    busy.value = ''
  }
}

function formatTime(value: string | null) {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('zh-CN', { hour12: false }) : value
}

watch(() => props.agentId, load)
onMounted(load)
defineExpose({ reload: load })
</script>

<template>
  <section class="detail-section" aria-label="版本历史">
    <header class="detail-section__head">
      <div><h3>版本历史</h3><p>每次发布生成不可变版本。回滚只移动当前版本指针，不需要重新验证；启用/停用状态和进行中的草稿保持不变。</p></div>
    </header>
    <el-alert v-if="error" type="error" :closable="false" :title="error">
      <el-button link type="primary" @click="load">重新读取</el-button>
    </el-alert>
    <el-table v-else v-loading="loading" class="data-table" :data="versions" empty-text="暂无版本记录">
      <el-table-column label="版本" width="120"><template #default="scope"><span class="mono">v{{ scope.row.version }}</span><small v-if="scope.row.active" class="current-version">当前</small></template></el-table-column>
      <el-table-column label="变更说明" min-width="200"><template #default="scope"><div class="version-summary"><strong>{{ scope.row.summary }}</strong><small>{{ scope.row.createdBy }} · {{ formatTime(scope.row.createdAt) }}</small></div></template></el-table-column>
      <el-table-column label="状态" width="100"><template #default="scope"><StatusTag :status="scope.row.status" /></template></el-table-column>
      <el-table-column label="发布" min-width="170"><template #default="scope"><small v-if="scope.row.publishedAt" class="hint">{{ scope.row.publishedBy }} · {{ formatTime(scope.row.publishedAt) }}</small><span v-else class="hint">—</span></template></el-table-column>
      <el-table-column label="操作" width="110">
        <template #default="scope">
          <el-button v-if="canManage && scope.row.publishedAt && !scope.row.active" link type="primary" :loading="busy === scope.row.id" :disabled="busy !== ''" data-action="rollback-agent" @click="rollback(scope.row)">回滚至此</el-button>
          <span v-else class="hint">—</span>
        </template>
      </el-table-column>
    </el-table>
  </section>
</template>

<style scoped>
.mono { font-family: monospace; }
.hint { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.current-version { display: inline-flex; margin-left: 5px; padding: 2px 5px; border-radius: var(--radius-tag); color: var(--color-primary); background: var(--color-primary-light); font-size: var(--font-size-micro); }
.version-summary { display: flex; flex-direction: column; }
.version-summary strong { color: var(--color-text-primary); font-size: var(--font-size-caption); font-weight: var(--font-weight-badge); }
.version-summary small { margin-top: 4px; color: var(--color-text-muted); font-size: var(--font-size-badge); }
</style>
