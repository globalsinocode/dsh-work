<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox, ElNotification } from 'element-plus'
import { Connection, DocumentCopy, Refresh, Search, View } from '@element-plus/icons-vue'
import { useRoute, useRouter } from 'vue-router'

import { StatusTag } from '@dsh-work/ui-core'
import SkillInstallationPanel from '@/components/SkillInstallationPanel.vue'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import type { ConnectorDefinition, SkillDefinition, SkillReleaseRecord, SkillVersionRecord, ToolDefinition } from '@/types/domain'

type CapabilityTab = 'skills' | 'install' | 'tools' | 'connectors'

const authStore = useAuthStore()
const contentStore = useContentStore()
const router = useRouter()
const route = useRoute()
const activeTab = computed<CapabilityTab>(() => {
  const tab = route.query.tab
  if (tab === 'install') return authStore.canManage ? 'install' : 'skills'
  return tab === 'tools' || tab === 'connectors' ? tab : 'skills'
})
const tabs = computed<Array<{ id: CapabilityTab; label: string; count?: number }>>(() => [
  { id: 'skills', label: 'Skill 中心', count: contentStore.skills.length },
  ...(authStore.canManage ? [{ id: 'install' as const, label: '新增 Skill' }] : []),
  { id: 'tools', label: '工具目录', count: contentStore.tools.length },
  { id: 'connectors', label: '连接器状态', count: contentStore.connectors.length },
])
const query = ref('')
const detailOpen = ref(false)
const detailTitle = ref('')
const detailRows = ref<Array<{ label: string; value: string }>>([])
const detailType = ref<'skill' | 'tool' | 'connector'>('skill')
const detailTargetId = ref('')
const skillDetailTab = ref<'config' | 'versions' | 'releases'>('config')
const installationTarget = ref<{ id: string; name: string }>()
const actionLoading = ref('')
const healthRefreshing = ref(false)

const selectedSkill = computed(() => contentStore.skills.find((item) => item.id === detailTargetId.value))
const selectedSkillVersions = computed(() => contentStore.skillVersions.filter((item) => item.skillId === detailTargetId.value))
const selectedSkillReleases = computed(() => contentStore.skillReleaseRecords.filter((item) => item.skillId === detailTargetId.value))

const filteredSkills = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return contentStore.skills.filter((item) => !keyword || `${item.name} ${item.description} ${item.owner} ${item.id}`.toLowerCase().includes(keyword))
})
const filteredTools = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return contentStore.tools.filter((item) => !keyword || `${item.name} ${item.id} ${item.system} ${item.description}`.toLowerCase().includes(keyword))
})
const filteredConnectors = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return contentStore.connectors.filter((item) => !keyword || `${item.name} ${item.system} ${item.id}`.toLowerCase().includes(keyword))
})
function switchTab(tab: CapabilityTab) {
  query.value = ''
  void router.replace({ query: { ...route.query, tab: tab === 'skills' ? undefined : tab } })
}

function navigateTabs(event: KeyboardEvent) {
  const supported = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
  if (!supported.includes(event.key)) return
  event.preventDefault()
  const index = tabs.value.findIndex(tab => tab.id === activeTab.value)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.value.length - 1
    : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.value.length) % tabs.value.length
  const tab = tabs.value[next]
  if (!tab) return
  switchTab(tab.id)
  document.getElementById(`capability-tab-${tab.id}`)?.focus()
}

function installVersion(skill: SkillDefinition) {
  installationTarget.value = { id: skill.id, name: skill.name }
  detailOpen.value = false
  switchTab('install')
}

function inspectSkill(skill: SkillDefinition) {
  skillDetailTab.value = 'config'
  showDetail(skill.name, [
    { label: 'Skill 标识', value: skill.id },
    { label: '版本', value: `v${skill.version}` },
    { label: '分类', value: skill.category },
    { label: '负责人', value: skill.owner },
    { label: '说明', value: skill.description },
    { label: '执行指令', value: skill.instructions },
    { label: '引用工具', value: toolNames(skill.toolIds) },
    { label: '典型问题', value: skill.testPrompt },
  ], 'skill', skill.id)
}

function inspectTool(tool: ToolDefinition) {
  const connector = contentStore.connectors.find((item) => item.id === tool.connectorId)
  showDetail(tool.name, [
    { label: '工具标识', value: tool.id },
    { label: '工具说明', value: tool.description },
    { label: '所属系统', value: tool.system },
    { label: '绑定连接器', value: connector?.name ?? '平台内置能力' },
    { label: '操作模式', value: tool.mode === 'read' ? '只读' : '写入' },
    { label: '风险等级', value: riskLabel(tool.risk) },
    { label: '授权角色', value: tool.allowedRoles.join('、') },
    { label: '数据范围', value: tool.dataScopes.join('、') },
    { label: '审批策略', value: approvalLabel(tool.approvalPolicy) },
    { label: '调用超时', value: `${tool.timeoutSeconds} 秒` },
    { label: '输入 Schema', value: tool.inputSchema },
    { label: '输出 Schema', value: tool.outputSchema },
  ], 'tool', tool.id)
}

function inspectConnector(connector: ConnectorDefinition) {
  showDetail(connector.name, [
    { label: '连接器标识', value: connector.id },
    { label: '企业系统', value: connector.system },
    { label: '协议', value: protocolLabel(connector.protocol) },
    { label: '服务地址', value: connector.endpoint },
    { label: '认证方式', value: connector.authType },
    { label: '凭据引用', value: connector.credentialRef },
    { label: '数据范围', value: connector.scopeDescription },
    { label: '提供工具', value: `${connector.toolCount} 个` },
    { label: '当前延迟', value: connector.latency },
  ], 'connector', connector.id)
}

function showDetail(title: string, rows: Array<{ label: string; value: string }>, type: 'skill' | 'tool' | 'connector', targetId: string) {
  detailTitle.value = title
  detailRows.value = rows
  detailType.value = type
  detailTargetId.value = targetId
  detailOpen.value = true
}

async function copySkillIdentifier(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    ElMessage.success('Skill 标识已复制')
  } catch {
    ElMessage.error('复制失败，请手动选择标识')
  }
}

function openToolPermissions(toolId = detailTargetId.value) {
  detailOpen.value = false
  void router.push({ path: '/permissions', query: { tool: toolId } })
}

async function changeSkillStatus(skill: SkillDefinition) {
  const disabling = skill.status === 'published'
  const nextStatus = disabling ? 'disabled' : 'published'
  const action = disabling ? '停用' : skill.status === 'draft' ? '发布' : '启用'
  try {
    await ElMessageBox.confirm(
      disabling ? '停用后，新建 Agent 不能再引用此 Skill；已有版本不会被改写。' : '发布后当前版本不可原地编辑，只能作为稳定版本被 Agent 引用。',
      `${action}“${skill.name}”？`,
      { confirmButtonText: `确认${action}`, cancelButtonText: '取消', type: 'warning' },
    )
    actionLoading.value = `skill:${skill.id}`
    if (skill.status === 'draft') {
      const test = await contentStore.testSkill(skill.id, skill.testPrompt)
      if (test.status !== 'passed') throw new Error(test.resultSummary)
      if (skill.packageSha256) await ElMessageBox.confirm(test.resultSummary, '检查 Skill 真实试运行结果', { confirmButtonText: '确认结果并发布', cancelButtonText: '暂不发布', type: 'info' })
    }
    const updated = await contentStore.setSkillStatus(skill.id, nextStatus)
    if (detailOpen.value && detailTargetId.value === skill.id) inspectSkill(updated)
    ElMessage.success(skill.status === 'draft' ? (skill.packageSha256 ? '真实试运行已确认，Skill 已发布' : '服务端配置校验通过，Skill 已发布') : `Skill 已${action}`)
  } catch (cause) {
    if (cause instanceof Error) ElMessage.error(cause.message)
  } finally {
    actionLoading.value = ''
  }
}

async function rollbackSkill(version: SkillVersionRecord) {
  const skill = selectedSkill.value
  if (!skill) return
  try {
    await ElMessageBox.confirm(
      `活动版本将切换为已发布的 v${version.version}，历史版本不会被修改。`,
      `回滚“${skill.name}”？`,
      { confirmButtonText: '确认回滚', cancelButtonText: '取消', type: 'warning' },
    )
    actionLoading.value = `skill-rollback:${version.id}`
    const updated = await contentStore.rollbackSkill(skill.id, version.version)
    inspectSkill(updated)
    skillDetailTab.value = 'releases'
    ElMessage.success(`Skill 已回滚到 v${version.version}`)
  } catch (cause) {
    if (cause instanceof Error) ElMessage.error(cause.message)
  } finally {
    actionLoading.value = ''
  }
}

function releaseActionLabel(record: SkillReleaseRecord) {
  return {
    published: '发布版本',
    enabled: '启用 Skill',
    disabled: '停用 Skill',
    rollback: '版本回滚',
  }[record.action]
}

async function changeToolStatus(tool: ToolDefinition) {
  const disabling = tool.status !== 'disabled'
  const nextStatus = disabling ? 'disabled' : 'available'
  const action = disabling ? '停用' : '启用'
  try {
    await ElMessageBox.confirm(
      disabling ? '停用后，Agent 运行将不能再调用此工具；已有审计记录保留。' : '启用前请确认连接器、Schema 和权限配置仍然有效。',
      `${action}“${tool.name}”？`,
      { confirmButtonText: `确认${action}`, cancelButtonText: '取消', type: 'warning' },
    )
    actionLoading.value = `tool:${tool.id}`
    await contentStore.setToolStatus(tool.id, nextStatus)
    ElMessage.success(`工具已${action}`)
  } catch (cause) {
    if (cause instanceof Error) ElMessage.error(cause.message)
  } finally {
    actionLoading.value = ''
  }
}

async function checkConnector(connector: ConnectorDefinition) {
  actionLoading.value = `connector:${connector.id}`
  try {
    const updated = await contentStore.checkConnector(connector.id)
    if (updated.status === 'healthy') ElMessage.success(`${connector.name}健康检查通过`)
    else ElNotification.error({
      title: `连接器异常：${connector.name}`,
      message: `原因：健康检查结果为${updated.status === 'offline' ? '离线' : '性能下降'}。下一步：检查 ${updated.endpoint}、凭据引用和 DSH Runtime 状态，恢复后重新检查。`,
      duration: 8000,
    })
  } catch (cause) {
    const failure = cause as Error & { object?: string; suggestion?: string; traceId?: string }
    ElNotification.error({
      title: `连接器检查失败：${failure.object ?? connector.name}`,
      message: `原因：${failure.message ?? '健康检查未完成'}。下一步：${failure.suggestion ?? '检查连接器配置和系统健康后重试。'}${failure.traceId && failure.traceId !== '—' ? ` 链路编号：${failure.traceId}` : ''}`,
      duration: 8000,
    })
  } finally {
    actionLoading.value = ''
  }
}

async function refreshHealth() {
  healthRefreshing.value = true
  try {
    const results = await Promise.all(contentStore.connectors.map((connector) => contentStore.checkConnector(connector.id)))
    const abnormal = results.filter((connector) => connector.status !== 'healthy')
    if (!abnormal.length) ElMessage.success(`全部 ${results.length} 个连接器健康检查通过`)
    else ElNotification.warning({
      title: `${abnormal.length} 个连接器需要处理`,
      message: `对象：${abnormal.map((connector) => connector.name).join('、')}。下一步：逐项检查端点、凭据引用和依赖状态。`,
      duration: 8000,
    })
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '批量健康检查失败')
  } finally {
    healthRefreshing.value = false
  }
}

function toolNames(references: string[]) {
  return references.map((reference) => {
    const separator = reference.lastIndexOf('@')
    const id = separator > 0 ? reference.slice(0, separator) : reference
    return contentStore.tools.find((tool) => tool.id === id)?.name ?? reference
  }).join('、')
}

function riskLabel(risk: ToolDefinition['risk']) {
  return { low: '低风险', medium: '中风险', high: '高风险' }[risk]
}

function approvalLabel(policy: ToolDefinition['approvalPolicy']) {
  return { none: '无需审批', sensitive: '敏感范围审批', always: '每次审批' }[policy]
}

function protocolLabel(protocol: ConnectorDefinition['protocol']) {
  return { runtime: 'Runtime', rest: 'REST API', openapi: 'OpenAPI', mcp: 'MCP', database: '数据库代理' }[protocol]
}

onMounted(() => contentStore.load())
</script>

<template>
  <div class="ops-page capabilities-page">
    <el-alert v-if="contentStore.error" :title="contentStore.error" type="error" show-icon @close="contentStore.error = ''" />
    <el-alert v-if="authStore.isAuditor" type="info" show-icon :closable="false" title="当前为安全审计员视图，仅可查看 Skill、工具与连接器配置。" />

    <section class="content-panel filter-panel capability-filters">
      <div class="status-tabs" role="tablist" aria-label="能力类型" @keydown="navigateTabs">
        <button v-for="tab in tabs" :id="`capability-tab-${tab.id}`" :key="tab.id" class="status-tab" :class="{ active: activeTab === tab.id }" type="button" role="tab" :aria-selected="activeTab === tab.id" :aria-controls="`capability-panel-${tab.id}`" :tabindex="activeTab === tab.id ? 0 : -1" @click="switchTab(tab.id)">{{ tab.label }} <span v-if="tab.count !== undefined" class="tab-count">{{ tab.count }}</span></button>
      </div>
      <div v-if="activeTab !== 'install'" class="filter-bar capability-toolbar">
        <el-input v-model="query" :prefix-icon="Search" clearable :placeholder="activeTab === 'skills' ? '搜索 Skill 名称、说明或负责人' : activeTab === 'tools' ? '搜索工具名称、标识或系统' : '搜索连接器或企业系统'" />
        <div v-if="activeTab === 'skills'" class="capability-toolbar__legend"><span>版本发布后不可变</span></div>
        <el-button @click="router.push('/assistant?context=skills')">交给管理助手</el-button>
        <el-button v-if="authStore.canManage && activeTab === 'connectors'" :icon="Refresh" :loading="healthRefreshing" data-action="refresh-connectors" @click="refreshHealth">全部检查</el-button>
      </div>
    </section>

    <div v-if="authStore.canManage" v-show="activeTab === 'install'" id="capability-panel-install" role="tabpanel" aria-labelledby="capability-tab-install">
      <SkillInstallationPanel :target="installationTarget" @back="switchTab('skills')" @clear-target="installationTarget = undefined" @assistant="router.push('/assistant?context=skills')" />
    </div>

    <section v-if="activeTab !== 'install'" :id="`capability-panel-${activeTab}`" class="content-panel content-panel--flush capability-panel" role="tabpanel" :aria-labelledby="`capability-tab-${activeTab}`">
      <el-table v-if="activeTab === 'skills'" class="data-table" v-loading="contentStore.loading" :data="filteredSkills" empty-text="暂无匹配的 Skill">
        <el-table-column label="Skill" min-width="290"><template #default="scope"><div class="primary-cell"><strong>{{ scope.row.name }}</strong><small>{{ scope.row.description }}</small></div></template></el-table-column>
        <el-table-column prop="version" label="版本" width="125"><template #default="scope"><span class="mono">v{{ scope.row.version }}</span><small v-if="scope.row.activeVersion && scope.row.activeVersion !== scope.row.version" class="active-version-hint">活动 v{{ scope.row.activeVersion }}</small></template></el-table-column>
        <el-table-column prop="category" label="分类" width="110" />
        <el-table-column label="工具" width="90"><template #default="scope">{{ scope.row.toolIds.length }} 个</template></el-table-column>
        <el-table-column prop="owner" label="负责人" min-width="140" />
        <el-table-column label="状态" width="108"><template #default="scope"><StatusTag :status="scope.row.status" /></template></el-table-column>
        <el-table-column prop="updatedAt" label="更新时间" width="120" />
        <el-table-column label="操作" width="280" fixed="right"><template #default="scope"><el-button link type="primary" :icon="View" data-action="view-skill" @click="inspectSkill(scope.row)">查看</el-button><el-button v-if="authStore.canManage" link type="primary" data-action="install-skill-version" @click="installVersion(scope.row)">安装新版本</el-button><el-button v-if="authStore.canManage" link type="primary" :loading="actionLoading === `skill:${scope.row.id}`" :data-action="scope.row.status === 'published' ? 'disable-skill' : 'publish-skill'" @click="changeSkillStatus(scope.row)">{{ scope.row.status === 'published' ? '停用' : scope.row.status === 'draft' ? (scope.row.packageSha256 ? '试运行并发布' : '校验并发布') : '启用' }}</el-button></template></el-table-column>
      </el-table>

      <el-table v-else-if="activeTab === 'tools'" class="data-table" v-loading="contentStore.loading" :data="filteredTools" empty-text="暂无匹配的工具">
        <el-table-column label="工具" min-width="290"><template #default="scope"><div class="primary-cell"><strong>{{ scope.row.name }}</strong><small>{{ scope.row.description }}</small><code>{{ scope.row.id }}</code></div></template></el-table-column>
        <el-table-column prop="system" label="所属系统" min-width="130" />
        <el-table-column label="模式" width="90"><template #default="scope"><span class="mode-label" :class="`mode-label--${scope.row.mode}`">{{ scope.row.mode === 'read' ? '只读' : '写入' }}</span></template></el-table-column>
        <el-table-column label="风险" width="100"><template #default="scope"><StatusTag :status="scope.row.risk" /></template></el-table-column>
        <el-table-column label="状态" width="115"><template #default="scope"><StatusTag :status="scope.row.status" dot /></template></el-table-column>
        <el-table-column label="授权角色" min-width="190"><template #default="scope"><span class="role-text">{{ scope.row.allowedRoles.join('、') }}</span></template></el-table-column>
        <el-table-column prop="lastCheckedAt" label="检查时间" width="110" />
        <el-table-column label="操作" width="210" fixed="right"><template #default="scope"><el-button link type="primary" :icon="View" data-action="view-tool" @click="inspectTool(scope.row)">查看</el-button><el-button v-if="authStore.canManage" link type="primary" data-action="configure-tool-permissions" @click="openToolPermissions(scope.row.id)">权限</el-button><el-button v-if="authStore.canManage" link type="primary" :loading="actionLoading === `tool:${scope.row.id}`" :data-action="scope.row.status === 'disabled' ? 'enable-tool' : 'disable-tool'" @click="changeToolStatus(scope.row)">{{ scope.row.status === 'disabled' ? '启用' : '停用' }}</el-button></template></el-table-column>
      </el-table>

      <el-table v-else class="data-table" v-loading="contentStore.loading" :data="filteredConnectors" empty-text="暂无匹配的连接器">
        <el-table-column label="连接器" min-width="225"><template #default="scope"><div class="connector-cell"><span><el-icon><Connection /></el-icon></span><div><strong>{{ scope.row.name }}</strong><small>{{ scope.row.system }} · {{ protocolLabel(scope.row.protocol) }}</small></div></div></template></el-table-column>
        <el-table-column label="状态" width="100"><template #default="scope"><StatusTag :status="scope.row.status" dot /></template></el-table-column>
        <el-table-column prop="toolCount" label="工具数" width="110" />
        <el-table-column prop="authType" label="认证与范围" min-width="175" />
        <el-table-column prop="latency" label="延迟" width="90" />
        <el-table-column prop="lastCheckedAt" label="检查时间" width="110" />
        <el-table-column label="操作" width="145" fixed="right"><template #default="scope"><el-button link type="primary" :icon="View" data-action="view-connector" @click="inspectConnector(scope.row)">查看</el-button><el-button v-if="authStore.canManage" link type="primary" :loading="actionLoading === `connector:${scope.row.id}`" data-action="check-connector" @click="checkConnector(scope.row)">检查</el-button></template></el-table-column>
      </el-table>
    </section>

    <el-drawer v-model="detailOpen" size="min(620px, 100vw)" :title="detailTitle">
      <div v-if="detailType === 'skill'" class="capability-detail__notice"><el-icon><Connection /></el-icon><p>Skill 发布后当前版本不可原地编辑，Agent 引用时锁定具体版本。</p></div>
      <div v-if="detailType === 'skill'" class="status-tabs capability-detail__tabs" role="tablist" aria-label="Skill 详情类型">
        <button class="status-tab" :class="{ active: skillDetailTab === 'config' }" type="button" role="tab" :aria-selected="skillDetailTab === 'config'" @click="skillDetailTab = 'config'">配置详情</button>
        <button class="status-tab" :class="{ active: skillDetailTab === 'versions' }" type="button" role="tab" :aria-selected="skillDetailTab === 'versions'" @click="skillDetailTab = 'versions'">版本历史 <span class="tab-count">{{ selectedSkillVersions.length }}</span></button>
        <button class="status-tab" :class="{ active: skillDetailTab === 'releases' }" type="button" role="tab" :aria-selected="skillDetailTab === 'releases'" @click="skillDetailTab = 'releases'">发布记录 <span class="tab-count">{{ selectedSkillReleases.length }}</span></button>
      </div>
      <dl v-if="detailType !== 'skill' || skillDetailTab === 'config'" class="capability-detail__rows">
        <div v-for="row in detailRows" :key="row.label">
          <dt>{{ row.label }}</dt>
          <dd :class="{ 'capability-detail__code': row.label.includes('Schema') }">
            <span v-if="row.label === 'Skill 标识'" class="capability-detail__identifier">
              <code>{{ row.value }}</code>
              <el-button link type="primary" :icon="DocumentCopy" aria-label="复制 Skill 标识" @click="copySkillIdentifier(row.value)">复制</el-button>
            </span>
            <template v-else>{{ row.value }}</template>
          </dd>
        </div>
      </dl>
      <section v-else-if="detailType === 'skill' && skillDetailTab === 'versions'" class="capability-detail__table">
        <el-table class="data-table" :data="selectedSkillVersions" empty-text="暂无版本记录">
          <el-table-column label="版本" width="95"><template #default="scope"><span class="mono">v{{ scope.row.version }}</span></template></el-table-column>
          <el-table-column label="变更说明" min-width="210"><template #default="scope"><div class="version-summary"><strong>{{ scope.row.summary }}</strong><small>{{ scope.row.createdBy }} · {{ scope.row.createdAt }}</small></div></template></el-table-column>
          <el-table-column label="状态" width="95"><template #default="scope"><StatusTag :status="scope.row.status" /></template></el-table-column>
          <el-table-column label="操作" width="100" fixed="right"><template #default="scope"><el-button v-if="authStore.canManage && scope.row.status === 'published' && scope.row.version !== selectedSkill?.activeVersion" link type="primary" :loading="actionLoading === `skill-rollback:${scope.row.id}`" @click="rollbackSkill(scope.row)">回滚至此</el-button><span v-else class="muted">—</span></template></el-table-column>
        </el-table>
      </section>
      <section v-else-if="detailType === 'skill'" class="capability-detail__releases">
        <el-empty v-if="!selectedSkillReleases.length" description="暂无发布记录" />
        <el-timeline v-else><el-timeline-item v-for="record in selectedSkillReleases" :key="record.id" :timestamp="record.time" placement="top"><article class="release-record"><strong>{{ releaseActionLabel(record) }} · v{{ record.version }}</strong><p>{{ record.note }}</p><small>操作人：{{ record.actor }}</small></article></el-timeline-item></el-timeline>
      </section>
      <div v-if="authStore.canManage" class="capability-detail__actions"><template v-if="detailType === 'skill' && selectedSkill"><el-button @click="installVersion(selectedSkill)">安装新版本</el-button><el-button :type="selectedSkill.status === 'published' ? 'danger' : 'primary'" :loading="actionLoading === `skill:${selectedSkill.id}`" @click="changeSkillStatus(selectedSkill)">{{ selectedSkill.status === 'published' ? '停用 Skill' : selectedSkill.status === 'draft' ? (selectedSkill.packageSha256 ? '试运行并发布' : '校验并发布') : '启用 Skill' }}</el-button></template><el-button v-if="detailType === 'tool'" type="primary" @click="openToolPermissions()">配置权限与数据范围</el-button></div>
    </el-drawer>

  </div>
</template>

<style scoped>
:global(body:has(#capability-tab-install[aria-selected="true"])) { min-width: 0; }
.capability-filters { gap: 0; }
.capability-toolbar { justify-content: space-between; padding-top: 10px; }
.capability-toolbar .el-input { width: 330px; }
.capability-toolbar__legend { margin-left: auto; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.capability-toolbar__legend span { display: inline-flex; align-items: center; gap: 6px; }
.capability-panel :deep(.el-table__header .cell) { white-space: nowrap; }
.primary-cell { display: flex; min-width: 0; flex-direction: column; }
.primary-cell strong { color: var(--color-text-heading); font-size: var(--font-size-caption); font-weight: var(--font-weight-title); }
.primary-cell small { max-width: 440px; margin-top: 4px; overflow: hidden; color: var(--color-text-muted); font-size: var(--font-size-badge); text-overflow: ellipsis; white-space: nowrap; }
.primary-cell code { margin-top: 4px; color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.active-version-hint { display: block; margin-top: 3px; color: var(--color-text-muted); font-size: var(--font-size-micro); }
.mode-label { display: inline-flex; padding: 3px 7px; border-radius: var(--radius-tag); color: var(--color-primary); background: var(--color-primary-light); font-size: var(--font-size-badge); font-weight: var(--font-weight-badge); }
.mode-label--write { color: var(--color-warning-strong); background: var(--color-warning-light); }
.role-text { color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.connector-cell { display: flex; align-items: center; gap: 10px; }
.connector-cell > span { display: grid; width: 34px; height: 34px; place-items: center; border-radius: var(--radius-button); color: var(--color-primary); background: var(--color-primary-light); }
.connector-cell > div { display: flex; flex-direction: column; }
.connector-cell strong { color: var(--color-text-heading); font-size: var(--font-size-caption); }
.connector-cell small { margin-top: 4px; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.capability-detail__notice { display: flex; align-items: flex-start; gap: 9px; padding: 13px; border-radius: var(--radius-button); color: var(--color-primary); background: var(--color-primary-light); }
.capability-detail__notice p { margin: 0; font-size: var(--font-size-badge); line-height: 1.6; }
.capability-detail__rows { margin: 18px 0 0; }
.capability-detail__tabs { margin-top: 16px; }
.capability-detail__rows div { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 12px; padding: 12px 2px; border-bottom: 1px solid var(--color-border); }
.capability-detail__rows dt { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.capability-detail__rows dd { margin: 0; color: var(--color-text-primary); font-size: var(--font-size-caption); line-height: 1.55; overflow-wrap: anywhere; white-space: pre-wrap; }
.capability-detail__identifier { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.capability-detail__identifier code { color: var(--color-text-primary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--font-size-badge); }
.capability-detail__code { padding: 9px; border-radius: var(--radius-button); background: var(--color-bg-subtle); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--font-size-badge) !important; }
.capability-detail__actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 24px; }
.capability-detail__table { margin-top: 14px; overflow: hidden; border: 1px solid var(--color-border); border-radius: var(--radius-card); }
.capability-detail__releases { margin-top: 18px; }
.version-summary { display: flex; flex-direction: column; gap: 4px; }
.version-summary small,
.release-record small { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.release-record p { margin: 6px 0; color: var(--color-text-secondary); font-size: var(--font-size-caption); line-height: 1.5; }
@media (max-width: 760px) { .capability-toolbar { align-items: stretch; flex-direction: column; } .capability-toolbar .el-input { width: 100%; } .capability-toolbar__legend { margin-left: 0; } }
</style>
