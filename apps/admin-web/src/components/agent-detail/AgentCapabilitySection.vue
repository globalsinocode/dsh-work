<script setup lang="ts">
import { computed, ref } from 'vue'

import { AGENT_DRAFT_BOUNDS, useAgentDraftEditor } from '@/composables/use-agent-draft'
import { useContentStore } from '@/stores/content'
import type { AgentMcpScope, ConnectorDefinition } from '@/types/domain'

const editor = useAgentDraftEditor()
const form = editor.form
const contentStore = useContentStore()
const readonly = computed(() => !editor.canEdit.value)
const limitsOpen = ref(false)
const inspectingMcp = ref<ConnectorDefinition | null>(null)
const mcpToolsDialogOpen = ref(false)

const publishedSkills = computed(() => contentStore.skills.filter(skill =>
  Boolean(skill.activeVersion) && skill.status !== 'disabled'))
const mcpConnectors = computed(() => contentStore.connectors.filter(connector => connector.protocol === 'mcp'))
const selectedMcpConnectors = computed(() => form.mcpScope.connectorIds.map(id =>
  mcpConnectors.value.find(connector => connector.id === id)))
const limitsSummary = computed(() =>
  `${form.timeoutSeconds} 秒 · ${form.maxToolCalls} 次工具调用 · ${form.maxOutputBytes.toLocaleString()} 字节输出`)

function setMcpMode(mode: AgentMcpScope['mode']) {
  if (form.mcpScope.mode === mode) return
  form.mcpScope = { mode, connectorIds: [] }
}

// 相同选择不重新赋值，避免 ElSelect 回写同值时触发无意义的草稿保存与重复渲染。
function setSelectedMcpIds(ids: string[]) {
  const next = [...new Set(ids.filter(Boolean))]
  const current = form.mcpScope.connectorIds
  if (form.mcpScope.mode === 'selected' && next.length === current.length && next.every((id, index) => id === current[index])) return
  form.mcpScope = { mode: 'selected', connectorIds: next }
}

function showMcpTools(connector: ConnectorDefinition) {
  inspectingMcp.value = connector
  mcpToolsDialogOpen.value = true
}
</script>

<template>
  <section class="detail-section" aria-label="能力">
    <header class="detail-section__head">
      <div><h3>能力</h3><p>平台自动提供获准的基础能力；这里选择工作方法（Skill）和外部连接（MCP）。能力属于版本，修改后需要重新验证。</p></div>
    </header>
    <el-form label-position="top" @submit.prevent>
      <el-form-item label="引用 Skill（选填）">
        <el-select v-model="form.skills" multiple filterable collapse-tags :max-collapse-tags="3" :disabled="readonly" placeholder="选择已发布 Skill" aria-label="引用 Skill（选填）">
          <el-option v-for="skill in publishedSkills" :key="skill.id" :label="`${skill.name} · v${skill.activeVersion}`" :value="`${skill.id}@${skill.activeVersion}`" />
        </el-select>
        <p class="field-help">精确引用已发布版本；Skill 依赖的工具由平台自动装配。</p>
      </el-form-item>

      <el-form-item label="联网搜索">
        <el-switch v-model="form.webSearchEnabled" :disabled="readonly" active-text="允许联网搜索" aria-label="允许联网搜索" data-testid="agent-web-search-switch" />
        <p class="field-help">开启后 Agent 可使用 web_search 检索公开网页，查询内容会发送到外部搜索服务。读取与生成工作区文件等基础工具始终由平台提供；需要联网搜索的 Skill 只能在开启后引用。</p>
      </el-form-item>

      <el-form-item label="项目任务管理">
        <el-switch v-model="form.projectTasksEnabled" :disabled="readonly" active-text="允许查看与维护项目任务" aria-label="允许查看与维护项目任务" data-testid="agent-project-tasks-switch" />
        <p class="field-help">开启后，该 Agent 在其所在的项目空间（群组）中可由成员发起运行时查看与维护项目任务；写入按发起人权限执行，Agent 新建的 Agent 任务执行规则为手动。个人对话与系统运行不装配这些工具。</p>
      </el-form-item>
      <el-form-item label="推荐其他 AI 同事">
        <el-switch v-model="form.agentRecommendationEnabled" :disabled="readonly" active-text="可推荐其他 AI 同事" aria-label="可推荐其他 AI 同事" data-testid="agent-recommendation-switch" />
        <p class="field-help">开启后，员工在个人对话中问“该找谁”或问题更适合其他 AI 同事时，该 Agent 可在回复下推荐同事卡片，员工点击后与该同事开始新对话。只推荐员工本人可用的 AI 同事；团队空间、定时任务与发布验证不装配。</p>
      </el-form-item>

      <div class="subsection-heading"><strong>MCP 外部连接</strong><span>按整个 Connector 选择，不逐工具配置</span></div>
      <el-radio-group :model-value="form.mcpScope.mode" :disabled="readonly" aria-label="MCP 使用范围" @update:model-value="(value: string | number | boolean | undefined) => setMcpMode(value as AgentMcpScope['mode'])">
        <el-radio value="selected">仅使用选定 MCP</el-radio>
        <el-radio value="none">不使用 MCP（默认）</el-radio>
      </el-radio-group>
      <p class="field-help">MCP 可访问的数据由连接器的上游凭据和服务端决定；平台数据范围不会过滤 MCP 返回的数据。只有在此选定的连接器会在该 Agent 运行时加载。</p>
      <div v-if="form.mcpScope.mode === 'selected'" class="mcp-selection">
        <el-form-item label="选择 MCP Connector" :error="editor.errors.mcpScope">
          <el-select :model-value="form.mcpScope.connectorIds" multiple filterable :disabled="readonly" placeholder="至少选择一个 Connector" aria-label="选择 MCP Connector" @update:model-value="setSelectedMcpIds">
            <el-option v-for="connector in mcpConnectors" :key="connector.id" :label="`${connector.name} · ${connector.status}`" :value="connector.id" :disabled="connector.status !== 'healthy'" />
          </el-select>
          <p v-if="!mcpConnectors.length" class="field-help">暂无可用 MCP Connector；请先在连接器管理中登记并检查。</p>
        </el-form-item>
        <div v-for="(connector, index) in selectedMcpConnectors" :key="form.mcpScope.connectorIds[index]" class="selected-mcp">
          <div><strong>{{ connector?.name ?? form.mcpScope.connectorIds[index] }}</strong><small>{{ connector ? `${connector.status} · ${connector.mcp?.capabilityCount ?? 0} 个工具 · 上游权限说明：${connector.scopeDescription || '未登记'}` : '连接器已删除或不可见' }}</small></div>
          <el-button v-if="connector" link type="primary" @click="showMcpTools(connector)">查看工具</el-button>
          <el-button v-if="!readonly" link type="danger" @click="setSelectedMcpIds(form.mcpScope.connectorIds.filter(id => id !== form.mcpScope.connectorIds[index]))">移除</el-button>
        </div>
        <el-alert v-if="selectedMcpConnectors.some(connector => !connector || connector.status !== 'healthy')" type="warning" :closable="false" title="所选连接器不可用；验证和新任务将被拒绝，请修正选择或恢复连接。" />
      </div>

      <p class="field-help approval-note">内置工具不需要逐次审批；工具出现问题时，管理员可在 Runtime 配置中紧急停用。</p>

      <details class="limits" :open="limitsOpen || undefined" @toggle="limitsOpen = ($event.target as HTMLDetailsElement).open">
        <summary>运行限制 <small>{{ limitsSummary }}</small></summary>
        <div class="limits__grid">
          <el-form-item label="运行超时（秒）" :error="editor.errors.timeoutSeconds">
            <el-input-number v-model="form.timeoutSeconds" :min="AGENT_DRAFT_BOUNDS.timeoutSeconds.min" :max="AGENT_DRAFT_BOUNDS.timeoutSeconds.max" :step="30" :disabled="readonly" aria-label="运行超时（秒）" />
          </el-form-item>
          <el-form-item label="工具调用上限" :error="editor.errors.maxToolCalls">
            <el-input-number v-model="form.maxToolCalls" :min="AGENT_DRAFT_BOUNDS.maxToolCalls.min" :max="AGENT_DRAFT_BOUNDS.maxToolCalls.max" :disabled="readonly" aria-label="工具调用上限" />
          </el-form-item>
          <el-form-item label="输出上限（字节）" :error="editor.errors.maxOutputBytes">
            <el-input-number v-model="form.maxOutputBytes" :min="AGENT_DRAFT_BOUNDS.maxOutputBytes.min" :max="AGENT_DRAFT_BOUNDS.maxOutputBytes.max" :step="1024" :disabled="readonly" aria-label="输出上限（字节）" />
          </el-form-item>
        </div>
      </details>
    </el-form>
  </section>

  <el-dialog v-model="mcpToolsDialogOpen" :title="`工具清单 · ${inspectingMcp?.name ?? ''}`" width="min(680px, calc(100vw - 40px))" append-to-body>
    <el-empty v-if="!inspectingMcp?.mcp?.capabilities.length" description="暂无已发现工具" />
    <div v-for="tool in inspectingMcp?.mcp?.capabilities ?? []" :key="tool.name" class="mcp-tool-detail">
      <strong>{{ tool.name }}</strong><p>{{ tool.description || '无描述' }}</p>
      <details><summary>输入 Schema</summary><pre>{{ JSON.stringify(tool.inputSchema, null, 2) }}</pre></details>
    </div>
  </el-dialog>
</template>

<style scoped>
.field-help { width: 100%; margin: 5px 0 0; color: var(--color-text-muted); font-size: var(--font-size-badge); line-height: 1.5; }
.subsection-heading { display: flex; align-items: baseline; flex-wrap: wrap; gap: 10px; margin: 6px 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--color-border); }
.subsection-heading strong { color: var(--color-text-heading); font-size: var(--font-size-body); }
.subsection-heading span { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.mcp-selection { margin-top: 14px; }
.selected-mcp { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; padding: 9px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-card); }
.selected-mcp > div { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 3px; }
.selected-mcp strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.selected-mcp small { color: var(--color-text-muted); overflow-wrap: anywhere; }
.approval-note { margin-top: 16px; }
.limits { margin-top: 12px; padding: 10px 14px; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-bg-subtle); }
.limits summary { cursor: pointer; color: var(--color-text-heading); font-weight: var(--font-weight-title); }
.limits summary small { margin-left: 8px; color: var(--color-text-muted); font-weight: normal; }
.limits__grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 16px; margin-top: 12px; }
.mcp-tool-detail { padding: 12px 0; border-bottom: 1px solid var(--color-border); }
.mcp-tool-detail p { color: var(--color-text-secondary); }
.mcp-tool-detail pre { max-height: 220px; overflow: auto; padding: 10px; background: var(--color-bg-subtle); }
:deep(.el-form-item__label) { color: var(--color-text-heading); font-weight: var(--font-weight-title); }
:deep(.el-select), :deep(.el-input-number) { width: 100%; }
@media (max-width: 760px) { .limits__grid { grid-template-columns: 1fr; } }
</style>
