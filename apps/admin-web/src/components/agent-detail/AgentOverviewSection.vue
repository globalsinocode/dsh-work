<script setup lang="ts">
import { computed } from 'vue'

import { useContentStore } from '@/stores/content'
import type { AgentDefinition, AgentMcpScope, AgentVersionRecord } from '@/types/domain'

/**
 * 详情页概览：只读展示当前版本的定义与能力。修改版本内容必须进入草稿编辑流程，
 * 这里不提供任何输入框，查看时不会生成草稿。
 */
const props = defineProps<{
  agent: AgentDefinition
  activeVersion: string | null
  pendingVersion?: AgentVersionRecord
  canManage: boolean
}>()
const emit = defineEmits<{ edit: [] }>()

const contentStore = useContentStore()

const activeRecord = computed(() => props.activeVersion
  ? contentStore.agentVersions.find(item => item.agentId === props.agent.id && item.version === props.activeVersion)
  : undefined)
/** 有当前版本记录时展示当前版本；从未发布（或记录暂不可见）时展示工作草稿。 */
const showingDraft = computed(() => !activeRecord.value && (!props.activeVersion || Boolean(props.pendingVersion)))
const source = computed(() => {
  const record = activeRecord.value
  const agent = props.agent
  return {
    welcomeMessage: record?.welcomeMessage ?? agent.welcomeMessage,
    examplePrompts: record?.examplePrompts ?? agent.examplePrompts,
    systemPrompt: record?.systemPrompt ?? agent.systemPrompt,
    workInstructions: (record ? record.workInstructions : agent.workInstructions) ?? '',
    skills: record?.skills ?? agent.skills,
    mcpScope: record?.mcpScope ?? agent.mcpScope ?? { mode: 'none', connectorIds: [] } as AgentMcpScope,
    timeoutSeconds: record?.timeoutSeconds ?? agent.timeoutSeconds,
    maxToolCalls: record?.maxToolCalls ?? agent.maxToolCalls,
    maxOutputBytes: record?.maxOutputBytes ?? agent.maxOutputBytes,
  }
})
const versionLabel = computed(() => showingDraft.value
  ? `草稿 v${props.agent.version}（尚未发布）`
  : `当前版本 v${props.activeVersion}`)

const pendingTitle = computed(() => {
  const pending = props.pendingVersion
  const stage = pending?.status === 'candidate' ? '已冻结，等待验证判定与发布' : '草稿'
  if (!props.activeVersion) return `尚未发布，员工暂时看不到这个 Agent。以下为${pending ? ` v${pending.version}（${stage}）` : '草稿'}内容。`
  return `有待发布的修改：v${pending?.version}（${stage}）。${showingDraft.value ? '当前版本记录暂不可读，下方为草稿内容。' : '下方仍是当前版本内容。'}`
})

function skillLabel(reference: string) {
  const [id, version] = reference.split('@')
  const skill = contentStore.skills.find(item => item.id === id)
  return `${skill?.name ?? id}${version ? ` · v${version}` : ''}`
}

const mcpLabel = computed(() => {
  const scope = source.value.mcpScope
  if (scope.mode === 'all') return '全部可用 MCP'
  if (scope.mode === 'none') return '不使用 MCP'
  return scope.connectorIds.map(id => contentStore.connectors.find(item => item.id === id)?.name ?? id).join('、') || '仅选定（未选择）'
})
</script>

<template>
  <section class="detail-section" aria-label="概览">
    <header class="detail-section__head">
      <div>
        <h3>概览</h3>
        <p>只读查看 {{ versionLabel }} 的定义与能力。修改职责、人格或能力请进入草稿编辑流程，验证并发布后才对员工生效。</p>
      </div>
    </header>

    <el-alert
      v-if="pendingVersion || !activeVersion"
      class="overview-alert"
      :type="activeVersion ? 'info' : 'warning'"
      :closable="false"
      show-icon
      :title="pendingTitle"
    >
      <template v-if="pendingVersion">
        <el-button v-if="canManage" link type="primary" data-action="continue-draft" @click="emit('edit')">继续编辑</el-button>
        <el-button v-else link type="primary" @click="emit('edit')">查看待发布版本</el-button>
      </template>
    </el-alert>

    <dl class="overview-grid">
      <div><dt>名称</dt><dd>{{ agent.name }}</dd></div>
      <div><dt>负责人</dt><dd>{{ agent.owner }}</dd></div>
      <div class="overview-grid__wide"><dt>说明</dt><dd>{{ agent.description }}</dd></div>
      <div class="overview-grid__wide"><dt>欢迎语</dt><dd>{{ source.welcomeMessage || '按名称和说明自动生成' }}</dd></div>
      <div class="overview-grid__wide">
        <dt>员工端示例问题</dt>
        <dd><ol class="overview-list"><li v-for="(prompt, index) in source.examplePrompts" :key="index">{{ prompt }}</li></ol></dd>
      </div>
      <div><dt>引用 Skill</dt><dd>{{ source.skills.length ? source.skills.map(skillLabel).join('、') : '未引用' }}</dd></div>
      <div><dt>MCP 外部连接</dt><dd>{{ mcpLabel }}</dd></div>
      <div class="overview-grid__wide"><dt>运行限制</dt><dd>{{ source.timeoutSeconds }} 秒 · {{ source.maxToolCalls }} 次工具调用 · {{ source.maxOutputBytes.toLocaleString() }} 字节输出</dd></div>
    </dl>

    <details class="overview-doc" open>
      <summary>SOUL.md（人格与工作原则）</summary>
      <pre aria-label="SOUL.md 内容">{{ source.systemPrompt }}</pre>
    </details>
    <details class="overview-doc">
      <summary>AGENTS.md（工作规程）<small v-if="!source.workInstructions">未填写</small></summary>
      <pre v-if="source.workInstructions" aria-label="AGENTS.md 内容">{{ source.workInstructions }}</pre>
    </details>
  </section>
</template>

<style scoped>
.overview-alert { margin-bottom: 14px; }
.overview-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 24px; margin: 0 0 14px; }
.overview-grid > div { min-width: 0; }
.overview-grid__wide { grid-column: 1 / -1; }
.overview-grid dt { margin-bottom: 4px; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.overview-grid dd { margin: 0; color: var(--color-text-primary); font-size: var(--font-size-caption); line-height: 1.6; overflow-wrap: anywhere; }
.overview-list { margin: 0; padding-left: 18px; }
.overview-doc { margin-top: 10px; border: 1px solid var(--color-border); border-radius: var(--radius-button); }
.overview-doc summary { padding: 10px 12px; cursor: pointer; color: var(--color-text-heading); font-size: var(--font-size-caption); font-weight: var(--font-weight-title); }
.overview-doc summary small { margin-left: 8px; color: var(--color-text-muted); font-weight: normal; }
.overview-doc pre { max-height: 360px; margin: 0; padding: 0 12px 12px; overflow: auto; color: var(--color-text-primary); font-family: inherit; font-size: var(--font-size-caption); line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 700px) { .overview-grid { grid-template-columns: 1fr; } }
</style>
