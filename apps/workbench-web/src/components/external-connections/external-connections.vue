<script setup lang="ts">
import type { McpUserGrantListItem } from '@/types/domain'

const props = defineProps<{
  items: McpUserGrantListItem[]
  loading?: boolean
  grantError?: string
  authorize: (connectorId: string) => void | Promise<void>
  revoke: (connectorId: string) => void | Promise<void>
  reload: () => void | Promise<void>
}>()

function statusLabel(status: McpUserGrantListItem['status']) {
  if (status === 'active') return '已授权'
  if (status === 'reauthorization_required') return '需要重新授权'
  if (status === 'disabled') return '连接器已停用'
  return '未授权'
}
</script>

<template>
  <section class="panel settings-section external-connections">
    <div class="settings-section__heading">
      <div><h2>外部连接</h2><p>管理员登记的需要个人授权的外部 MCP；此处只能查看状态并完成授权。</p></div>
      <el-button link type="primary" :loading="loading" @click="reload">刷新</el-button>
    </div>
    <el-alert v-if="grantError" type="warning" :closable="false" show-icon :title="grantError" />
    <p v-if="!loading && !items.length" class="external-connections__empty">管理员尚未登记需要个人授权的外部连接</p>
    <el-table v-else v-loading="loading" :data="items" empty-text="暂无外部连接">
      <el-table-column label="名称" prop="name" min-width="160" />
      <el-table-column label="权限说明" prop="scopeDescription" min-width="220" />
      <el-table-column label="工具数量" prop="toolCount" width="100" align="center" />
      <el-table-column label="我的状态" width="140">
        <template #default="{ row }">{{ statusLabel(row.status) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="160">
        <template #default="{ row }">
          <el-button
            v-if="row.status === 'unauthorized' || row.status === 'reauthorization_required'"
            link
            type="primary"
            data-action="authorize-mcp-grant"
            @click="authorize(row.connectorId)"
          >授权</el-button>
          <el-button
            v-if="row.status === 'active' || row.status === 'reauthorization_required'"
            link
            type="danger"
            data-action="revoke-mcp-grant"
            @click="revoke(row.connectorId)"
          >解除授权</el-button>
        </template>
      </el-table-column>
    </el-table>
  </section>
</template>

<style scoped>
.external-connections__empty { margin: 12px 0; color: var(--el-text-color-secondary); }
</style>
