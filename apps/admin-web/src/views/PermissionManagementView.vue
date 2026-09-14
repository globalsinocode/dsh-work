<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Key, Lock, Search, View } from '@element-plus/icons-vue'
import { useRoute } from 'vue-router'

import { StatusTag } from '@dsh-work/ui-core'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import type { ToolDefinition } from '@/types/domain'

const authStore = useAuthStore()
const contentStore = useContentStore()
const route = useRoute()
const query = ref('')
const selectedTool = ref<ToolDefinition>()
const toolDialogOpen = ref(false)
const saving = ref(false)

const toolForm = reactive({
  allowedRoles: [] as string[],
  dataScopes: [] as string[],
  approvalPolicy: 'none' as ToolDefinition['approvalPolicy'],
})

const filteredTools = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return contentStore.tools.filter((tool) =>
    !keyword
    || `${tool.name} ${tool.id} ${tool.system} ${tool.allowedRoles.join(' ')} ${tool.dataScopes.join(' ')}`
      .toLowerCase()
      .includes(keyword),
  )
})

const roleOptions = computed(() =>
  [...new Set([
    ...contentStore.tools.flatMap((tool) => tool.allowedRoles),
    ...toolForm.allowedRoles,
  ])].sort((left, right) => left.localeCompare(right, 'zh-CN')),
)

const dataScopeOptions = computed(() =>
  [...new Set([
    ...contentStore.tools.flatMap((tool) => tool.dataScopes),
    ...toolForm.dataScopes,
    '本人所属部门',
    '已授权工厂',
    '已授权仓库',
    '当前工作空间',
  ])],
)

function editTool(tool: ToolDefinition) {
  selectedTool.value = tool
  toolForm.allowedRoles = [...tool.allowedRoles]
  toolForm.dataScopes = [...tool.dataScopes]
  toolForm.approvalPolicy = tool.approvalPolicy
  toolDialogOpen.value = true
}

async function saveTool() {
  if (!selectedTool.value) return
  saving.value = true
  try {
    await contentStore.updateToolPermissions({
      toolId: selectedTool.value.id,
      allowedRoles: [...toolForm.allowedRoles],
      dataScopes: [...toolForm.dataScopes],
      approvalPolicy: toolForm.approvalPolicy,
    })
    toolDialogOpen.value = false
    ElMessage.success('工具权限策略已保存')
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '工具权限保存失败')
  } finally {
    saving.value = false
  }
}

function approvalLabel(policy: ToolDefinition['approvalPolicy']) {
  return { none: '无需审批', sensitive: '敏感范围审批', always: '每次审批' }[policy]
}

onMounted(async () => {
  await contentStore.load()
  if (typeof route.query.tool === 'string') {
    const target = contentStore.tools.find((tool) => tool.id === route.query.tool)
    if (target) editTool(target)
  }
})
</script>

<template>
  <div class="ops-page permission-page">
    <el-alert v-if="contentStore.error" :title="contentStore.error" type="error" show-icon @close="contentStore.error = ''" />
    <el-alert v-if="authStore.isAuditor" type="info" show-icon :closable="false" title="当前为安全审计员视图，仅可查看工具与数据范围配置。" />

    <section class="permission-model content-panel" aria-label="三层权限模型">
      <article><span><el-icon><Key /></el-icon></span><div><small>第一层</small><strong>平台使用权限</strong><p>决定用户能否进入员工端或管理后台。</p></div></article><i></i>
      <article><span><el-icon><Lock /></el-icon></span><div><small>第二层</small><strong>能力使用权限</strong><p>决定可见 Agent、Skill 与工具允许列表。</p></div></article><i></i>
      <article><span><el-icon><View /></el-icon></span><div><small>第三层</small><strong>业务数据范围</strong><p>每次工具调用按用户与服务端数据范围过滤。</p></div></article>
    </section>

    <section class="content-panel filter-panel">
      <div class="filter-bar permission-toolbar">
        <el-input v-model="query" :prefix-icon="Search" clearable placeholder="搜索工具、系统、角色或数据范围" />
        <span class="filter-bar__meta">{{ filteredTools.length }} 个工具</span>
      </div>
    </section>

    <section class="content-panel content-panel--flush permission-table">
      <el-table class="data-table" v-loading="contentStore.loading" :data="filteredTools" empty-text="暂无匹配的工具权限">
        <el-table-column label="工具" min-width="250"><template #default="scope"><div class="tool-name"><strong>{{ scope.row.name }}</strong><code>{{ scope.row.id }}</code></div></template></el-table-column>
        <el-table-column prop="system" label="系统" min-width="110" />
        <el-table-column label="风险" width="100"><template #default="scope"><StatusTag :status="scope.row.risk" /></template></el-table-column>
        <el-table-column label="授权角色" min-width="220"><template #default="scope"><span class="cell-text">{{ scope.row.allowedRoles.join('、') || '无' }}</span></template></el-table-column>
        <el-table-column label="数据范围策略" min-width="240"><template #default="scope"><span class="scope-text"><el-icon><Lock /></el-icon>{{ scope.row.dataScopes.join('、') || '未配置' }}</span></template></el-table-column>
        <el-table-column label="审批策略" width="145"><template #default="scope"><span class="approval-label">{{ approvalLabel(scope.row.approvalPolicy) }}</span></template></el-table-column>
        <el-table-column label="操作" width="110" fixed="right"><template #default="scope"><el-button link type="primary" data-action="configure-tool-permission" @click="editTool(scope.row)">{{ authStore.canManage ? '配置' : '查看' }}</el-button></template></el-table-column>
      </el-table>
    </section>

    <el-dialog v-model="toolDialogOpen" :title="`${authStore.canManage ? '配置' : '查看'}工具权限：${selectedTool?.name ?? ''}`" width="720px">
      <el-form v-if="selectedTool" label-position="top" :disabled="!authStore.canManage">
        <el-form-item label="允许使用的角色"><el-select v-model="toolForm.allowedRoles" multiple filterable allow-create default-first-option><el-option v-for="role in roleOptions" :key="role" :label="role" :value="role" /></el-select></el-form-item>
        <el-form-item label="允许的数据范围"><el-select v-model="toolForm.dataScopes" multiple filterable allow-create default-first-option><el-option v-for="scope in dataScopeOptions" :key="scope" :label="scope" :value="scope" /></el-select></el-form-item>
        <el-form-item label="审批策略"><el-radio-group v-model="toolForm.approvalPolicy" :disabled="selectedTool.system === 'DSH Runtime'"><el-radio value="none">无需审批</el-radio><el-radio value="sensitive">敏感范围审批</el-radio><el-radio value="always">每次审批</el-radio></el-radio-group><small v-if="selectedTool.system === 'DSH Runtime'" class="policy-help">DSH 内置工具的审批策略由平台安全边界固定；需要逐次审批的工具在审批中心接入前不可授权。</small></el-form-item>
      </el-form>
      <el-alert type="warning" :closable="false" show-icon title="授权角色与数据范围必须同时满足；审批不能扩大后端注入的业务数据权限。" />
      <template #footer><el-button @click="toolDialogOpen = false">{{ authStore.canManage ? '取消' : '关闭' }}</el-button><el-button v-if="authStore.canManage" type="primary" :loading="saving" @click="saveTool">保存工具策略</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.permission-model { display: grid; grid-template-columns: 1fr 32px 1fr 32px 1fr; align-items: center; gap: 8px; }
.permission-model article { display: grid; grid-template-columns: 42px 1fr; align-items: center; gap: 12px; min-height: 110px; padding: 17px; }
.permission-model article > span { display: grid; width: 40px; height: 40px; place-items: center; border-radius: var(--radius-card); color: var(--color-primary); background: var(--color-primary-light); font-size: var(--font-size-heading); }
.permission-model small { display: block; color: var(--color-primary); font-size: var(--font-size-badge); font-weight: var(--font-weight-heading); }
.permission-model strong { display: block; margin-top: 4px; color: var(--color-text-heading); font-size: var(--font-size-body); }
.permission-model p { margin: 5px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-badge); line-height: 1.5; }
.permission-model > i { height: 1px; background: var(--color-border-strong); }
.permission-toolbar .el-input { width: 340px; }
.tool-name { display: flex; flex-direction: column; }
.tool-name strong { color: var(--color-text-heading); font-size: var(--font-size-caption); font-weight: var(--font-weight-title); }
.tool-name code { margin-top: 4px; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.cell-text { color: var(--color-text-secondary); font-size: var(--font-size-badge); line-height: 1.5; }
.scope-text { display: inline-flex; align-items: flex-start; gap: 6px; color: var(--color-text-secondary); font-size: var(--font-size-badge); line-height: 1.5; }
.scope-text .el-icon { margin-top: 2px; color: var(--color-warning); }
.approval-label { color: var(--color-text-primary); font-size: var(--font-size-badge); font-weight: var(--font-weight-badge); }
.policy-help { display: block; margin-top: 8px; color: var(--color-text-muted); font-size: var(--font-size-badge); line-height: 1.5; }
.el-dialog .el-select { width: 100%; }
@media (max-width: 960px) { .permission-model { grid-template-columns: 1fr; } .permission-model > i { display: none; } }
@media (max-width: 700px) { .permission-toolbar, .permission-toolbar .el-input { width: 100%; } }
</style>
