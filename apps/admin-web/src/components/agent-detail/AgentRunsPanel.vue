<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'

import { StatusTag } from '@dsh-work/ui-core'
import { adminApi } from '@/api/client'
import type { AgentRunSource, AgentRunSummary } from '@/types/domain'

const props = defineProps<{ agentId: string }>()

const sourceLabel: Record<AgentRunSource, string> = {
  conversation: '员工对话',
  validation: '验证',
  routine: '主动任务',
  automation: '自动任务',
  api: '接口调用',
  event: '事件触发',
  system: '系统',
}

const runs = ref<AgentRunSummary[]>([])
const loading = ref(false)
const loadError = ref('')

async function load() {
  loading.value = true
  try {
    runs.value = (await adminApi.getAgentRuns(props.agentId)).items
    loadError.value = ''
  } catch (cause) {
    loadError.value = cause instanceof Error ? cause.message : '无法读取运行记录'
  } finally {
    loading.value = false
  }
}

function formatTime(value: string | null) {
  if (!value) return '—'
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('zh-CN', { hour12: false }) : value
}

function duration(run: AgentRunSummary) {
  if (!run.startedAt || !run.endedAt) return '—'
  const ms = new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '—'
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.round(ms / 60_000)} 分钟`
}

watch(() => props.agentId, load)
onMounted(load)
</script>

<template>
  <section class="detail-section" aria-label="运行记录">
    <header class="detail-section__head">
      <div><h3>运行记录</h3><p>以该 Agent 身份运行的最近 20 个 Run，包括员工对话、主动任务、自动任务与验证；排队中尚未开始的 Run 不在此列。</p></div>
      <el-button size="small" :loading="loading" @click="load">刷新</el-button>
    </header>
    <el-alert v-if="loadError" type="error" :closable="false" :title="loadError">
      <el-button link type="primary" @click="load">重新读取</el-button>
    </el-alert>
    <el-table v-else v-loading="loading" class="data-table" :data="runs" empty-text="还没有运行记录">
      <el-table-column label="开始时间" width="170"><template #default="scope">{{ formatTime(scope.row.startedAt ?? scope.row.createdAt) }}</template></el-table-column>
      <el-table-column label="来源" width="100"><template #default="scope">{{ sourceLabel[scope.row.source as AgentRunSource] }}</template></el-table-column>
      <el-table-column label="内容" min-width="200"><template #default="scope"><span>{{ scope.row.sessionTitle ?? '—' }}</span><small class="cell-sub">发起人：{{ scope.row.requestedBy }}</small></template></el-table-column>
      <el-table-column label="版本" width="90"><template #default="scope"><span class="mono">{{ scope.row.version ? `v${scope.row.version}` : '—' }}</span></template></el-table-column>
      <el-table-column label="状态" width="110"><template #default="scope"><StatusTag :status="scope.row.status" /><small v-if="scope.row.errorCode" class="cell-sub mono">{{ scope.row.errorCode }}</small></template></el-table-column>
      <el-table-column label="耗时" width="90"><template #default="scope">{{ duration(scope.row) }}</template></el-table-column>
      <el-table-column label="Run" min-width="160"><template #default="scope"><span class="mono run-id">{{ scope.row.runId }}</span></template></el-table-column>
    </el-table>
  </section>
</template>

<style scoped>
.mono { font-family: monospace; }
.cell-sub { display: block; margin-top: 3px; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.run-id { color: var(--color-text-muted); font-size: var(--font-size-badge); overflow-wrap: anywhere; }
</style>
