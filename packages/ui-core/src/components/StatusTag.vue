<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  status: string
  label?: string
  dot?: boolean
}>()

const statusMap: Record<string, { label: string; tone: string }> = {
  queued: { label: '排队中', tone: 'neutral' },
  running: { label: '执行中', tone: 'info' },
  awaiting_approval: { label: '等待确认', tone: 'warning' },
  succeeded: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  cancelled: { label: '已停止', tone: 'neutral' },
  pending: { label: '等待中', tone: 'neutral' },
  achieved: { label: '目标已达成', tone: 'success' },
  unverified: { label: '结果待核验', tone: 'warning' },
  not_achieved: { label: '未达成', tone: 'danger' },
  completed: { label: '已完成', tone: 'success' },
  accepted: { label: '已受理', tone: 'info' },
  rejected: { label: '已拒绝', tone: 'warning' },
  missing: { label: '登记缺失', tone: 'danger' },
  published: { label: '已发布', tone: 'success' },
  draft: { label: '草稿', tone: 'neutral' },
  disabled: { label: '已停用', tone: 'danger' },
  available: { label: '可用', tone: 'success' },
  degraded: { label: '性能下降', tone: 'warning' },
  offline: { label: '离线', tone: 'danger' },
  healthy: { label: '正常', tone: 'success' },
  warning: { label: '需关注', tone: 'warning' },
  success: { label: '成功', tone: 'success' },
  blocked: { label: '已阻止', tone: 'warning' },
  low: { label: '低风险', tone: 'success' },
  medium: { label: '中风险', tone: 'warning' },
  high: { label: '高风险', tone: 'danger' },
  active: { label: '正常', tone: 'success' },
  suspended: { label: '已停用', tone: 'danger' },
  synced: { label: '已同步', tone: 'success' },
  pending_sync: { label: '待同步', tone: 'warning' },
}

const config = computed(() => statusMap[props.status] ?? { label: props.status, tone: 'neutral' })
</script>

<template>
  <span class="status-tag" :class="`status-tag--${config.tone}`">
    <span v-if="dot" class="status-tag__dot" aria-hidden="true"></span>
    {{ label ?? config.label }}
  </span>
</template>

<style scoped>
.status-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 24px;
  padding: 3px 9px;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: var(--dsh-font-size-caption);
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}

.status-tag__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.status-tag--neutral {
  border-color: #e3e7ed;
  color: #667085;
  background: #f7f8fa;
}

.status-tag--info {
  border-color: #dce5ff;
  color: #315ac5;
  background: #eef3ff;
}

.status-tag--success {
  border-color: #cfeee2;
  color: #107052;
  background: #ecf8f3;
}

.status-tag--warning {
  border-color: #fae1bd;
  color: #a14506;
  background: #fff5e8;
}

.status-tag--danger {
  border-color: #f6d2d7;
  color: #b42335;
  background: #fff1f2;
}
</style>
