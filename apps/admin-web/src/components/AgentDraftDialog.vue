<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'

import AgentZipImportPanel from '@/components/AgentZipImportPanel.vue'
import { adminApi } from '@/api/client'
import type { ZipInspection } from '@/stores/agentGovernance'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import type { AgentDefinition, AgentDraftConfiguration, AgentMcpScope, AgentPrincipalRoleOption, ConnectorDefinition, CreateAgentDraftInput } from '@/types/domain'

const props = defineProps<{
  agent?: AgentDefinition
}>()

const emit = defineEmits<{
  saved: [agent: AgentDefinition, source: 'config' | 'zip']
  'continue-release': [agent: AgentDefinition]
}>()

const dialogOpen = defineModel<boolean>({ default: false })
const authStore = useAuthStore()
const contentStore = useContentStore()
const formRef = ref<FormInstance>()
const zipPanelRef = ref<InstanceType<typeof AgentZipImportPanel>>()
const creationMode = ref<'config' | 'zip'>('config')
const activeStep = ref(0)
const saving = ref(false)
const examplePrompt = ref('')
const initialSnapshot = ref('')
const savedResult = ref<{
  agent: AgentDefinition
  source: 'config' | 'zip'
  inspection?: ZipInspection
  executionGrantMissing?: boolean
}>()
/**
 * 仅作历史 id 的显示兜底。可见角色的**可选集合**必须来自服务端角色目录
 * （`getAgentPrincipalRoleOptions`），不能再用本地映射推导：此前这里用
 * `Object.keys(roleLabels)` 拼选项，而 `roles` 表里根本没有 `role-manager` /
 * `role-supply`，真实的「部门负责人」是 `role-department-manager`，导致
 * ① 选中「部门负责人」实际写入死 id，等于没选；② 真实角色在界面上无法表达。
 * 现在存活角色由目录提供名称，这个映射只兜住历史版本里已存在的 id；
 * 已失效的 id 故意不给友好名，直接显示原始 id 以便一眼看出异常。
 */
const legacyRoleLabels: Record<string, string> = {
  'role-platform-admin': '平台管理员',
  'role-employee': '普通员工',
  'role-auditor': '安全审计员',
}
const roleCatalog = ref<AgentPrincipalRoleOption[]>([])

type DraftForm = AgentDraftConfiguration & { workInstructions: string; mcpScope: AgentMcpScope }
const form = reactive<DraftForm>(emptyDraft())
const executionRoleIds = ref<string[]>([])
const executionDataScopes = ref<string[]>([])
const inspectingMcp = ref<ConnectorDefinition | null>(null)
const mcpToolsDialogOpen = ref(false)
const governanceSections = ref<string[]>([])

const rules: FormRules = {
  name: [
    { required: true, message: '请输入 Agent 名称', trigger: 'blur' },
    { min: 2, max: 40, message: '名称长度为 2～40 个字符', trigger: 'blur' },
  ],
  description: [
    { required: true, message: '请输入 Agent 说明', trigger: 'blur' },
    { min: 10, max: 200, message: '说明长度为 10～200 个字符', trigger: 'blur' },
  ],
  systemPrompt: [
    { required: true, message: '请输入 SOUL.md 内容', trigger: 'blur' },
    { min: 20, message: 'SOUL.md 内容至少需要 20 个字符', trigger: 'blur' },
  ],
  workInstructions: [{ async validator(_rule, value: string) {
    const length = value?.trim().length ?? 0
    if (length > 0 && length < 20) throw new Error('AGENTS.md 填写后至少需要 20 个字符')
  }, trigger: 'blur' }],
  roleIds: [{ type: 'array', required: true, min: 1, message: '请至少选择一个可见角色', trigger: 'change' }],
  dataScopes: [{ type: 'array', required: true, min: 1, message: '请至少配置一个业务数据范围', trigger: 'change' }],
}

const publishedSkills = computed(() => contentStore.skills.filter((skill) =>
  Boolean(skill.activeVersion) && skill.status !== 'disabled',
))
const mcpConnectors = computed(() => contentStore.connectors.filter(connector => connector.protocol === 'mcp'))
const selectedMcpConnectors = computed(() => form.mcpScope.connectorIds.map(id =>
  mcpConnectors.value.find(connector => connector.id === id),
))
const delegationTargets = computed(() => contentStore.agentVersions.filter((version) =>
  version.status === 'published',
).map((version) => ({
  id: version.id,
  label: `${contentStore.agents.find(agent => agent.id === version.agentId)?.name ?? version.agentId} · v${version.version}`,
})))
const dataScopeOptions = computed(() => unique([
  'enterprise:authorized',
  'workspace:authorized',
  'domain:supply-chain',
  'domain:operations',
  ...contentStore.agents.flatMap((agent) => agent.dataScopes),
  ...contentStore.tools.flatMap((tool) => tool.dataScopes),
]))
const dataScopeLabels: Record<string, string> = {
  'enterprise:authorized': '企业授权范围',
  'workspace:authorized': '当前工作空间授权范围',
  'domain:supply-chain': '供应链业务范围',
  'domain:operations': '经营分析范围',
}
/** 存活角色（启用中）来自服务端目录，这是可见角色与执行角色的唯一可选来源。 */
const activeRoleOptions = computed(() => roleCatalog.value
  .filter(role => role.status === 'active')
  .map(role => ({ id: role.id, name: role.name })))
/**
 * 选项集合 = 服务端存活角色 ∪ 本表单已选 ∪ 现有 Agent 已用（历史 id）。
 * 保留历史 id 是为了让旧草稿/旧版本的既有取值仍能显示，而不是悄悄丢掉。
 */
const roleOptions = computed(() => {
  const catalog = new Map(activeRoleOptions.value.map(role => [role.id, role.name]))
  const extras = unique([
    ...contentStore.agents.flatMap((agent) => agent.roleIds),
    ...form.roleIds,
  ]).filter(id => !catalog.has(id))
  return [
    ...activeRoleOptions.value,
    ...extras.map(id => ({ id, name: roleName(id) })),
  ]
})
const selectedRoleNames = computed(() => form.roleIds.map(roleName))
/** 执行授权是否为空：留空即「默认无授权」，该 Agent 无法试运行，因此必须让创建者明确知情。 */
const executionGrantEmpty = computed(() => !executionRoleIds.value.length || !executionDataScopes.value.length)
const executionGrantAcknowledged = ref(false)
const editorTitle = computed(() => savedResult.value
  ? savedResult.value.source === 'zip' ? 'Agent 导入完成' : 'Agent 草稿已保存'
  : props.agent ? `编辑 Agent：${props.agent.name}` : '创建 Agent')
const employeeWelcome = computed(() => form.welcomeMessage.trim() || buildWelcomeMessage(form.name, form.description))
const isDirty = computed(() => JSON.stringify(form) !== initialSnapshot.value)
const savedMissingCount = computed(() => {
  const missing = savedResult.value?.inspection?.missing
  return missing ? missing.skills.length + missing.tools.length : 0
})

const stepFields: string[][] = [
  ['name', 'description', 'systemPrompt', 'workInstructions'],
  ['roleIds', 'dataScopes'],
]

watch(dialogOpen, (open) => {
  if (open) resetEditor()
})

watch(() => [...form.roleIds], roles => {
  executionRoleIds.value = executionRoleIds.value.filter(role => roles.includes(role))
})
watch(() => [...form.dataScopes], scopes => {
  executionDataScopes.value = executionDataScopes.value.filter(scope => scopes.includes(scope))
})
// 目录只在打开时拉一次；角色目录属于低频变更的治理数据。
// immediate 保证「挂载时就已经打开」（深链/首次渲染）同样会加载，否则可见角色与
// 一键授权都会退化成空集合。
watch(dialogOpen, (open) => {
  if (open && !roleCatalog.value.length) void loadRoleCatalog()
}, { immediate: true })

function emptyDraft(): DraftForm {
  return {
    id: createAgentId(),
    name: '',
    description: '',
    owner: authStore.user.name,
    department: authStore.user.department,
    visibility: '全体试点员工',
    roleIds: ['role-employee'],
    dataScopes: ['enterprise:authorized', 'workspace:authorized'],
    welcomeMessage: '',
    examplePrompts: ['请介绍你能提供哪些帮助'],
    systemPrompt: '',
    workInstructions: '',
    maxOutputBytes: 65536,
    maxToolCalls: 20,
    timeoutSeconds: 300,
    skills: [],
    tools: [],
    mcpScope: { mode: 'all', connectorIds: [] },
    delegationPolicy: defaultDelegationPolicy(),
    changeSummary: '创建初始草稿版本',
  }
}

function defaultDelegationPolicy() {
  return { allowedAgentVersionIds: [] as string[], maxDepth: 1, maxParallel: 1, timeoutSeconds: 120 }
}

function resetEditor() {
  const source = props.agent
    ? {
        id: props.agent.id,
        name: props.agent.name,
        description: props.agent.description,
        owner: props.agent.owner,
        department: props.agent.department,
        visibility: props.agent.visibility,
        roleIds: [...props.agent.roleIds],
        dataScopes: [...props.agent.dataScopes],
        welcomeMessage: props.agent.welcomeMessage,
        examplePrompts: [...props.agent.examplePrompts],
        systemPrompt: props.agent.systemPrompt,
        workInstructions: props.agent.workInstructions ?? '',
        maxOutputBytes: props.agent.maxOutputBytes,
        maxToolCalls: props.agent.maxToolCalls,
        timeoutSeconds: props.agent.timeoutSeconds,
        skills: [...props.agent.skills],
        tools: props.agent.tools.map(toVersionedToolReference),
        mcpScope: props.agent.mcpScope ?? { mode: 'all' as const, connectorIds: [] as [] },
        delegationPolicy: (() => {
          const policy = props.agent.delegationPolicy ?? defaultDelegationPolicy()
          return { ...policy, allowedAgentVersionIds: [...policy.allowedAgentVersionIds] }
        })(),
        changeSummary: `更新 ${props.agent.name} 草稿配置`,
      }
    : emptyDraft()
  Object.assign(form, source)
  executionRoleIds.value = []
  executionDataScopes.value = []
  executionGrantAcknowledged.value = false
  savedResult.value = undefined
  creationMode.value = 'config'
  activeStep.value = 0
  examplePrompt.value = source.examplePrompts[0] ?? '请介绍你能提供哪些帮助'
  initialSnapshot.value = JSON.stringify(form)
  governanceSections.value = []
  formRef.value?.clearValidate()
}

async function nextStep() {
  if (activeStep.value === 1 && form.mcpScope.mode === 'selected' && !form.mcpScope.connectorIds.length) {
    ElMessage.warning('仅选定模式下，请至少选择一个 MCP Connector')
    return
  }
  const fields = stepFields[activeStep.value] ?? []
  try {
    if (fields.length) await formRef.value?.validateField(fields)
    activeStep.value += 1
    if (activeStep.value === 2 && !examplePrompt.value) examplePrompt.value = '请介绍你能提供哪些帮助'
  } catch {
    ElMessage.warning('请先完成当前步骤的必填配置')
  }
}

function previousStep() {
  activeStep.value = Math.max(0, activeStep.value - 1)
}

async function saveAgent() {
  if (form.mcpScope.mode === 'selected' && !form.mcpScope.connectorIds.length) {
    activeStep.value = 1
    ElMessage.warning('仅选定模式下，请至少选择一个 MCP Connector')
    return
  }
  // 「默认无授权」是刻意的安全语义（差异清单 AE-02：创建时不从可见角色继承），
  // 但留空的后果——该 Agent 过不了试运行、因而永远发不出去——此前只写在帮助文字里。
  // 这里要求创建者显式确认一次，把静默失败变成一次明确的知情选择。
  if (!props.agent && executionGrantEmpty.value && !executionGrantAcknowledged.value) {
    activeStep.value = 1
    ElMessage.warning('执行授权留空时该 Agent 无法试运行。请点「与可见范围相同」快速授予，或勾选确认「暂不授予」。')
    return
  }
  try {
    await formRef.value?.validate()
  } catch {
    const firstInvalidStep = findFirstInvalidStep()
    if (firstInvalidStep >= 0) activeStep.value = firstInvalidStep
    ElMessage.warning('仍有必填配置未完成，请检查后再保存')
    return
  }

  saving.value = true
  try {
    const payload = preparePayload(form)
    const saved = props.agent
      ? await contentStore.updateAgentDraft(payload)
      : await contentStore.createAgentDraft({
          ...payload,
          executionRoleIds: executionRoleIds.value.filter(role => payload.roleIds.includes(role)),
          executionDataScopes: executionDataScopes.value.filter(scope => payload.dataScopes.includes(scope)),
        } satisfies CreateAgentDraftInput)
    initialSnapshot.value = JSON.stringify(form)
    savedResult.value = { agent: saved, source: 'config',
      executionGrantMissing: !props.agent && (!executionRoleIds.value.length || !executionDataScopes.value.length) }
    emit('saved', saved, 'config')
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Agent 保存失败')
  } finally {
    saving.value = false
  }
}

function findFirstInvalidStep() {
  if (!form.name || !form.description || !form.systemPrompt
    || (form.workInstructions.trim() && form.workInstructions.trim().length < 20)) return 0
  if (!form.roleIds.length || !form.dataScopes.length) return 1
  return -1
}

function handleZipSaved(agent: AgentDefinition, inspection: ZipInspection) {
  savedResult.value = { agent, source: 'zip', inspection, executionGrantMissing: !props.agent }
  emit('saved', agent, 'zip')
}

function handleBeforeClose(done: () => void) {
  if (savedResult.value || (!props.agent && creationMode.value === 'zip') || !isDirty.value || saving.value) {
    done()
    return
  }
  ElMessageBox.confirm(
    '关闭后，本次尚未保存的 Agent 配置会丢失。',
    '放弃未保存的修改？',
    { confirmButtonText: '放弃修改', cancelButtonText: '继续编辑', type: 'warning' },
  ).then(() => done()).catch(() => undefined)
}

function requestClose() {
  handleBeforeClose(() => {
    dialogOpen.value = false
  })
}

function finishSaved() {
  dialogOpen.value = false
}

function continueRelease() {
  const saved = savedResult.value?.agent
  if (!saved) return
  dialogOpen.value = false
  emit('continue-release', saved)
}

function cloneDraft(value: DraftForm): DraftForm {
  return {
    ...value,
    roleIds: [...value.roleIds],
    dataScopes: [...value.dataScopes],
    examplePrompts: [...value.examplePrompts],
    skills: [...value.skills],
    tools: [...value.tools],
    mcpScope: value.mcpScope.mode === 'selected'
      ? { mode: 'selected', connectorIds: [...value.mcpScope.connectorIds] }
      : { mode: value.mcpScope.mode, connectorIds: [] },
    delegationPolicy: {
      ...value.delegationPolicy,
      allowedAgentVersionIds: [...value.delegationPolicy.allowedAgentVersionIds],
    },
  }
}

function preparePayload(value: DraftForm): AgentDraftConfiguration {
  const payload = cloneDraft(value)
  if (!props.agent) {
    payload.owner = authStore.user.name
    payload.department = authStore.user.department
  }
  payload.visibility = buildVisibilityLabel(payload.roleIds)
  payload.welcomeMessage = employeeWelcome.value
  payload.examplePrompts = [examplePrompt.value.trim() || '请介绍你能提供哪些帮助']
  payload.changeSummary = props.agent ? `更新 ${payload.name} 配置` : '创建 Agent 初始版本'
  return payload
}

function setMcpMode(mode: AgentMcpScope['mode']) {
  form.mcpScope = { mode, connectorIds: [] }
}

function setSelectedMcpIds(ids: string[]) {
  form.mcpScope = { mode: 'selected', connectorIds: unique(ids) }
}

function showMcpTools(connector: ConnectorDefinition) {
  inspectingMcp.value = connector
  mcpToolsDialogOpen.value = true
}

function createAgentId() {
  return `agent-${Date.now().toString(36)}`
}

function buildWelcomeMessage(name: string, description: string) {
  const agentName = name.trim() || '企业 Agent'
  const purpose = description.trim() || '我会根据已配置的能力和权限协助你完成工作。'
  return `你好，我是${agentName}。${purpose}`.slice(0, 120)
}

function buildVisibilityLabel(roleIds: string[]) {
  const names = roleIds.map(roleName)
  if (roleIds.includes('role-employee')) return '全体试点员工'
  return names.length > 1 ? `${names[0]}等 ${names.length} 个角色` : names[0] ?? '指定角色'
}

function roleName(roleId: string) {
  return roleCatalog.value.find(role => role.id === roleId)?.name ?? legacyRoleLabels[roleId] ?? roleId
}

/** 载入服务端角色目录；失败时不静默降级，明确告知并保持空目录（宁可不给选项）。 */
async function loadRoleCatalog() {
  try {
    roleCatalog.value = await adminApi.getAgentPrincipalRoleOptions()
  } catch (cause) {
    roleCatalog.value = []
    ElMessage.warning(cause instanceof Error
      ? `角色目录加载失败，无法选择可见角色：${cause.message}`
      : '角色目录加载失败，无法选择可见角色')
  }
}

/**
 * 显式动作：把当前可见范围拷成执行授权（不会自动继承，必须由创建者点选）。
 *
 * 这里原样拷贝可见角色而不按目录过滤：执行角色本就受「必须是可见角色的子集」约束
 * （见上方的 watch），角色 id 是否真实存在由服务端在保存时统一校验并给出明确报错，
 * 前端再做一次过滤只会在目录尚未加载时静默拷成空集合。
 */
function copyVisibleScopeToExecutionGrant() {
  executionRoleIds.value = [...form.roleIds]
  executionDataScopes.value = [...form.dataScopes]
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))]
}

function toVersionedToolReference(reference: string) {
  if (reference.lastIndexOf('@') > 0) return reference
  const tool = contentStore.tools.find((item) => item.id === reference)
  return `${reference}@${tool?.version ?? '1.0.0'}`
}
</script>

<template>
  <el-dialog
    v-model="dialogOpen"
    class="agent-editor"
    :title="editorTitle"
    width="min(1040px, calc(100vw - 64px))"
    top="4vh"
    :close-on-click-modal="false"
    :before-close="handleBeforeClose"
    destroy-on-close
  >
    <section v-if="savedResult" class="draft-completion" aria-live="polite">
      <el-result
        icon="success"
        :title="savedResult.source === 'zip' ? '已导入为 Agent 草稿' : 'Agent 草稿已保存'"
        sub-title="草稿已保存在 Agent 管理中。您可以关闭弹窗稍后处理，也可以主动进入发布流程。"
      />
      <dl class="draft-completion__summary">
        <div><dt>Agent</dt><dd>{{ savedResult.agent.name }}</dd></div>
        <div><dt>草稿版本</dt><dd class="mono">v{{ savedResult.agent.version }}</dd></div>
        <div><dt>创建方式</dt><dd>{{ savedResult.source === 'zip' ? 'ZIP 导入' : '配置创建' }}</dd></div>
        <div><dt>能力范围</dt><dd>{{ savedResult.agent.skills.length }} 个 Skill · MCP：{{ savedResult.agent.mcpScope?.mode === 'selected' ? '仅选定' : savedResult.agent.mcpScope?.mode === 'none' ? '不使用' : '全部可用' }}</dd></div>
      </dl>
      <el-alert
        v-if="savedResult.executionGrantMissing"
        type="warning"
        :closable="false"
        show-icon
        title="尚未授予 AI 员工执行角色或数据范围"
        description="请在 Agent 管理详情的“独立执行身份”中配置授权，再进行发布试运行。可见角色不会自动授予执行权限。"
      />
      <el-alert
        v-if="savedMissingCount"
        type="warning"
        :closable="false"
        show-icon
        :title="`草稿仍有 ${savedMissingCount} 个依赖待处理，暂不能试运行`"
        description="进入定义与依赖页面后，可以补齐平台能力或移除不需要的引用。"
      />
    </section>

    <template v-else>
      <section v-if="!props.agent" class="creation-mode" aria-labelledby="creation-mode-title">
      <div>
        <strong id="creation-mode-title">创建方式</strong>
        <span>两种方式都会进入同一套检查、试运行和发布流程</span>
      </div>
      <el-radio-group v-model="creationMode" aria-label="选择 Agent 创建方式">
        <el-radio-button value="config">配置创建</el-radio-button>
        <el-radio-button value="zip">ZIP 导入</el-radio-button>
      </el-radio-group>
      </section>

      <div v-if="props.agent || creationMode === 'config'" class="agent-editor__steps">
      <el-steps :active="activeStep" finish-status="success" align-center>
        <el-step title="定义 Agent" description="职责、Soul 和工作规程" />
        <el-step title="选择 Skill 与 MCP" description="选择方法与外部连接" />
        <el-step :title="props.agent ? '确认并保存' : '确认并创建'" description="确认员工端展示和配置摘要" />
      </el-steps>
      </div>

      <el-form v-if="props.agent || creationMode === 'config'" ref="formRef" :model="form" :rules="rules" label-position="top" status-icon>
      <section v-show="activeStep === 0" class="agent-editor__pane" aria-label="Agent 基础信息">
        <header class="pane-heading">
          <div><h3>定义 Agent</h3><p>填写员工识别和理解 Agent 所需的基础信息。</p></div>
          <span class="step-badge">1 / 3</span>
        </header>
        <div v-if="props.agent" class="creator-owner" aria-label="Agent 负责人">
          <span class="creator-owner__avatar">{{ form.owner.slice(0, 1) }}</span>
          <div><small>负责人</small><strong>{{ form.owner }}</strong><p>{{ props.agent ? '负责人不随配置编辑变更，后续可通过移交流程调整。' : `当前创建者 · ${form.department}` }}</p></div>
          <el-tag effect="plain" round>{{ props.agent ? '当前负责人' : '自动设置' }}</el-tag>
        </div>
        <el-form-item label="Agent 名称" prop="name">
          <el-input v-model="form.name" maxlength="40" show-word-limit placeholder="例如：质量异常分析助手" />
        </el-form-item>
        <el-form-item label="Agent 说明" prop="description">
          <el-input v-model="form.description" type="textarea" :rows="4" maxlength="200" show-word-limit placeholder="说明这个 Agent 面向谁、能够解决什么问题" />
        </el-form-item>
        <el-form-item label="欢迎语（选填）" prop="welcomeMessage">
          <el-input v-model="form.welcomeMessage" type="textarea" :rows="2" maxlength="120" show-word-limit placeholder="员工首次打开 Agent 时看到的欢迎语" />
          <p class="field-help">留空时，平台会根据 Agent 名称和说明自动生成欢迎语。</p>
        </el-form-item>
        <el-form-item label="SOUL.md（人格与工作原则）" prop="systemPrompt">
          <el-input v-model="form.systemPrompt" type="textarea" :rows="6" maxlength="20000" show-word-limit placeholder="定义 Agent 的稳定职责、工作原则、沟通风格、禁止事项和转人工条件" />
          <p class="field-help">根目录 SOUL.md 随版本固定；不要填写凭据或密钥。</p>
        </el-form-item>
        <el-form-item label="AGENTS.md（工作规程，选填）" prop="workInstructions">
          <el-input v-model="form.workInstructions" type="textarea" :rows="5" maxlength="20000" show-word-limit placeholder="例如：如何核对输入、使用状态与经验、验证结果，以及何时交接给人工" />
          <p class="field-help">留空时不生成文件；填写后作为版本指令固定，不会读取服务器工作目录的同名文件。</p>
        </el-form-item>
      </section>

      <section v-show="activeStep === 1" class="agent-editor__pane" aria-label="Skill 与 MCP 使用范围">
        <header class="pane-heading">
          <div><h3>选择 Skill 与 MCP</h3><p>平台自动提供获准的基础能力；这里只选择工作方法和外部连接范围。</p></div>
          <span class="step-badge">2 / 3</span>
        </header>
        <el-form-item label="引用 Skill（选填）" prop="skills">
          <el-select v-model="form.skills" multiple filterable collapse-tags :max-collapse-tags="2" placeholder="选择已发布 Skill">
            <el-option v-for="skill in publishedSkills" :key="skill.id" :label="`${skill.name} · v${skill.activeVersion}`" :value="`${skill.id}@${skill.activeVersion}`" />
          </el-select>
          <p class="field-help">精确引用已发布版本；无需 Skill 时可留空。</p>
        </el-form-item>
        <div class="configuration-section-heading"><strong>MCP 外部连接</strong><span>按整个 Connector 选择，不逐工具配置</span></div>
        <el-radio-group :model-value="form.mcpScope.mode" aria-label="MCP 使用范围" @update:model-value="(value: string) => setMcpMode(value as AgentMcpScope['mode'])">
          <el-radio value="all">全部可用 MCP（默认）</el-radio>
          <el-radio value="selected">仅使用选定 MCP</el-radio>
          <el-radio value="none">不使用 MCP</el-radio>
        </el-radio-group>
        <p class="field-help">全部模式在每次新运行时使用租户当前可用连接；历史运行保留各自清单。</p>
        <div v-if="form.mcpScope.mode === 'selected'" class="mcp-selection">
          <el-form-item label="选择 MCP Connector">
            <el-select :model-value="form.mcpScope.connectorIds" multiple filterable placeholder="至少选择一个 Connector" @update:model-value="setSelectedMcpIds">
              <el-option v-for="connector in mcpConnectors" :key="connector.id" :label="`${connector.name} · ${connector.status}`" :value="connector.id" :disabled="connector.status !== 'healthy'" />
            </el-select>
            <p v-if="!mcpConnectors.length" class="field-help">暂无可用 MCP Connector；请先在连接器管理中登记并检查。</p>
            <p v-else-if="!form.mcpScope.connectorIds.length" class="field-help field-help--error">仅选定模式必须选择至少一个 Connector。</p>
          </el-form-item>
          <div v-for="(connector, index) in selectedMcpConnectors" :key="form.mcpScope.connectorIds[index]" class="selected-mcp">
            <div><strong>{{ connector?.name ?? form.mcpScope.connectorIds[index] }}</strong><small>{{ connector ? `${connector.status} · ${connector.mcp?.capabilityCount ?? 0} 个工具` : '连接器已删除或不可见' }}</small></div>
            <el-button v-if="connector" link type="primary" @click="showMcpTools(connector)">查看工具</el-button>
            <el-button link type="danger" @click="setSelectedMcpIds(form.mcpScope.connectorIds.filter(id => id !== form.mcpScope.connectorIds[index]))">移除</el-button>
          </div>
          <el-alert v-if="selectedMcpConnectors.some(connector => !connector || connector.status !== 'healthy')" type="warning" :closable="false" title="所选连接器不可用；试运行和新任务将被拒绝，请修正选择或恢复连接。" />
        </div>
        <el-collapse v-model="governanceSections" class="agent-governance-collapse">
          <el-collapse-item name="permissions" title="权限与运行限制">
        <div class="configuration-section-heading configuration-section-heading--permissions"><strong>受控委派（选填）</strong><span>只允许调用固定的已发布 Agent Version</span></div>
        <el-form-item label="允许委派的 Agent Version">
          <el-select v-model="form.delegationPolicy.allowedAgentVersionIds" multiple filterable collapse-tags :max-collapse-tags="2" placeholder="不选择则不开放 Agent 委派">
            <el-option v-for="target in delegationTargets" :key="target.id" :label="target.label" :value="target.id" />
          </el-select>
          <p class="field-help">子任务沿用当前员工、工作空间和根任务累计预算，权限只会继续收窄。</p>
        </el-form-item>
        <div class="form-grid form-grid--three">
          <el-form-item label="最大深度">
            <el-input-number v-model="form.delegationPolicy.maxDepth" :min="1" :max="4" :disabled="!form.delegationPolicy.allowedAgentVersionIds.length" />
          </el-form-item>
          <el-form-item label="并行上限">
            <el-input-number v-model="form.delegationPolicy.maxParallel" :min="1" :max="4" :disabled="!form.delegationPolicy.allowedAgentVersionIds.length" />
          </el-form-item>
          <el-form-item label="单次超时（秒）">
            <el-input-number v-model="form.delegationPolicy.timeoutSeconds" :min="10" :max="300" :step="10" :disabled="!form.delegationPolicy.allowedAgentVersionIds.length" />
          </el-form-item>
        </div>
        <div class="configuration-section-heading configuration-section-heading--permissions"><strong>可见性与定义范围</strong><span>控制员工可选范围和此版本的数据上限</span></div>
        <div class="form-grid form-grid--two">
          <el-form-item label="可见角色" prop="roleIds">
            <el-select v-model="form.roleIds" multiple filterable placeholder="选择可以使用此 Agent 的角色">
              <el-option v-for="role in roleOptions" :key="role.id" :label="role.name" :value="role.id" />
            </el-select>
            <p class="field-help">未选中的角色不会在员工工作台看到此 Agent。</p>
          </el-form-item>
          <el-form-item label="数据范围" prop="dataScopes">
            <el-select v-model="form.dataScopes" multiple filterable allow-create default-first-option placeholder="选择或输入数据范围">
              <el-option v-for="scope in dataScopeOptions" :key="scope" :label="dataScopeLabels[scope] ? `${dataScopeLabels[scope]} · ${scope}` : scope" :value="scope" />
            </el-select>
            <p class="field-help">最终权限取 Agent 范围、员工角色、工作空间和工具审批策略的交集。</p>
          </el-form-item>
        </div>
        <div v-if="!props.agent" class="configuration-section-heading configuration-section-heading--permissions"><strong>AI 员工执行授权</strong><span>独立授权，留空即默认拒绝；留空时无法试运行，也就无法发布</span></div>
        <div v-if="!props.agent" class="form-grid form-grid--two">
          <el-form-item label="执行角色">
            <el-select v-model="executionRoleIds" multiple filterable placeholder="选择 Agent 本身获准使用的角色">
              <el-option v-for="role in roleOptions.filter(item => form.roleIds.includes(item.id))" :key="role.id" :label="role.name" :value="role.id" />
            </el-select>
            <p class="field-help">与员工当前角色取交集；不会从可见角色自动继承。</p>
          </el-form-item>
          <el-form-item label="执行数据范围">
            <el-select v-model="executionDataScopes" multiple filterable placeholder="选择 Agent 本身获准使用的数据范围">
              <el-option v-for="scope in form.dataScopes" :key="scope" :label="scope" :value="scope" />
            </el-select>
            <p class="field-help">与员工、工作空间及版本范围取交集；留空默认拒绝。</p>
          </el-form-item>
        </div>
        <div v-if="!props.agent" class="execution-grant-actions">
          <el-button link type="primary" @click="copyVisibleScopeToExecutionGrant">与可见范围相同</el-button>
          <span class="field-help">把上面的可见角色与数据范围显式拷成执行授权；之后仍可单独收窄。</span>
        </div>
        <el-alert
          v-if="!props.agent && executionGrantEmpty"
          type="warning"
          :closable="false"
          show-icon
          title="执行授权留空：该 Agent 无法试运行，因而无法发布"
          description="发布检查的「AI 员工执行授权」一项会判定为未通过并阻断试运行。若暂不授予，请勾选下方确认。"
        />
        <el-checkbox v-if="!props.agent && executionGrantEmpty" v-model="executionGrantAcknowledged" class="execution-grant-ack">
          我确认暂不授予执行身份，该 Agent 将无法通过试运行
        </el-checkbox>
        <el-alert type="info" :closable="false" show-icon title="涉及敏感数据或写操作时，工具自身的审批策略仍然生效。" />
          </el-collapse-item>
        </el-collapse>
      </section>

      <section v-show="activeStep === 2" class="agent-editor__pane" aria-label="Agent 配置确认">
        <header class="pane-heading">
          <div><h3>{{ props.agent ? '确认并保存' : '确认并创建' }}</h3><p>确认员工端展示、示例问题和配置摘要。</p></div>
          <span class="step-badge">3 / 3</span>
        </header>
        <div class="review-grid">
          <section class="employee-preview">
            <h4>员工端展示预览</h4>
            <div class="employee-preview__frame">
              <header class="employee-preview__identity">
                <span class="employee-preview__avatar">d</span>
                <div><strong>{{ form.name || '未命名 Agent' }}</strong><small>{{ props.agent ? `由 ${form.owner} 维护` : '企业 Agent' }}</small></div>
                <el-tag effect="plain" round>Agent</el-tag>
              </header>
              <p class="employee-preview__description">{{ form.description || '填写 Agent 说明后，员工将在这里了解它能够解决的问题。' }}</p>
              <div class="employee-preview__message">{{ employeeWelcome }}</div>
              <div class="employee-preview__capabilities">
                <span v-for="skill in form.skills" :key="skill">{{ skill }}</span>
              </div>
              <small class="employee-preview__visibility">可见角色：{{ selectedRoleNames.join('、') || '未配置' }}</small>
            </div>
          </section>
          <section class="draft-summary">
            <h4>{{ props.agent ? '修改内容确认' : '创建内容确认' }}</h4>
            <el-form-item label="员工端示例问题">
              <el-input v-model="examplePrompt" type="textarea" :rows="3" maxlength="160" show-word-limit placeholder="例如：请介绍你能提供哪些帮助" />
            </el-form-item>
            <div class="draft-summary__grid" :class="{ 'draft-summary__grid--create': !props.agent }">
              <div><span>Agent</span><strong>{{ form.name }}</strong><small>{{ form.description }}</small></div>
              <div v-if="props.agent"><span>负责人</span><strong>{{ form.owner }}</strong><small>负责配置维护与发布</small></div>
              <div><span>能力</span><strong>{{ form.skills.length }} 个 Skill</strong><small>MCP：{{ form.mcpScope.mode === 'selected' ? `${form.mcpScope.connectorIds.length} 个选定` : form.mcpScope.mode === 'none' ? '不使用' : '全部可用' }}</small></div>
              <div><span>工作规程</span><strong>{{ form.workInstructions.trim() ? '已填写 AGENTS.md' : '未填写' }}</strong><small>与 Soul 一起随版本固定</small></div>
              <div><span>委派</span><strong>{{ form.delegationPolicy.allowedAgentVersionIds.length }} 个目标</strong><small>深度 {{ form.delegationPolicy.maxDepth }} · 并行 {{ form.delegationPolicy.maxParallel }}</small></div>
              <div><span>权限</span><strong>{{ selectedRoleNames.length }} 个可见角色</strong><small>{{ form.dataScopes.length }} 个数据范围</small></div>
              <div v-if="!props.agent"><span>执行授权</span><strong>{{ executionRoleIds.length }} 个角色</strong><small>{{ executionGrantEmpty ? '留空：该 Agent 无法试运行' : `${executionDataScopes.length} 个数据范围` }}</small></div>
            </div>
          </section>
        </div>
      </section>
      </el-form>
      <AgentZipImportPanel v-else ref="zipPanelRef" class="agent-editor__zip" @saved="handleZipSaved" />
    </template>

    <template #footer>
      <div v-if="savedResult" class="agent-editor__footer">
        <el-button @click="finishSaved">关闭</el-button>
        <el-button type="primary" @click="continueRelease">进入定义与依赖</el-button>
      </div>
      <div v-else class="agent-editor__footer">
        <el-button :disabled="saving" @click="requestClose">取消</el-button>
        <div v-if="props.agent || creationMode === 'config'">
          <el-button v-if="activeStep > 0" :disabled="saving" @click="previousStep">上一步</el-button>
          <el-button v-if="activeStep < 2" type="primary" @click="nextStep">下一步</el-button>
          <el-button v-else type="primary" :loading="saving" @click="saveAgent">{{ props.agent ? '保存修改' : '完成创建' }}</el-button>
        </div>
        <el-button
          v-else
          type="primary"
          :loading="zipPanelRef?.importing ?? false"
          :disabled="!zipPanelRef?.parsed"
          data-action="confirm-zip-import"
          @click="zipPanelRef?.importAsDraft()"
        >导入为草稿</el-button>
      </div>
    </template>
  </el-dialog>
  <el-dialog v-model="mcpToolsDialogOpen" :title="`工具清单 · ${inspectingMcp?.name ?? ''}`" width="min(680px, calc(100vw - 40px))" append-to-body>
    <el-empty v-if="!inspectingMcp?.mcp?.capabilities.length" description="暂无已发现工具" />
    <div v-for="tool in inspectingMcp?.mcp?.capabilities ?? []" :key="tool.name" class="mcp-tool-detail">
      <strong>{{ tool.name }}</strong><p>{{ tool.description || '无描述' }}</p>
      <details><summary>输入 Schema</summary><pre>{{ JSON.stringify(tool.inputSchema, null, 2) }}</pre></details>
    </div>
  </el-dialog>
</template>

<style scoped>
:global(.agent-editor.el-dialog) { display: flex; max-height: 92vh; flex-direction: column; overflow: hidden; }
:global(.agent-editor .el-dialog__body) { min-height: 0; overflow: auto; }
:global(.agent-editor .el-dialog__footer) { flex: 0 0 auto; border-top: 1px solid var(--color-border); }
.creation-mode { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin: 2px 8px 18px; padding: 14px 16px; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-bg-subtle); }
.creation-mode > div { display: flex; min-width: 0; flex-direction: column; gap: 4px; }
.creation-mode strong { color: var(--color-text-heading); font-size: var(--font-size-caption); }
.creation-mode span { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.creation-mode :deep(.el-radio-group) { display: inline-flex; flex-direction: row; flex-wrap: nowrap; }
.creation-mode :deep(.el-radio-button) { flex: 0 0 auto; }
.agent-editor__steps { padding: 4px 12px 22px; border-bottom: 1px solid var(--color-border); }
.agent-editor__zip { min-height: 500px; padding: 4px 8px; }
.draft-completion { max-width: 760px; min-height: 480px; margin: 0 auto; }
.draft-completion :deep(.el-result) { padding: 36px 20px 24px; }
.draft-completion__summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 20px; margin: 0 0 18px; padding: 0 18px; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-bg-subtle); }
.draft-completion__summary > div { padding: 12px 0; border-bottom: 1px solid var(--color-border); }
.draft-completion__summary > div:nth-last-child(-n + 2) { border-bottom: 0; }
.draft-completion__summary dt { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.draft-completion__summary dd { margin: 3px 0 0; color: var(--color-text-heading); font-size: var(--font-size-caption); }
.mono { font-family: monospace; }
.agent-editor__pane { min-height: 500px; padding: 22px 8px 4px; }
.pane-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 22px; }
.pane-heading h3, .employee-preview h4, .draft-summary h4 { margin: 0; color: var(--color-text-heading); font-size: var(--font-size-title); }
.pane-heading p { margin: 5px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.step-badge { padding: 4px 9px; border-radius: var(--radius-tag); color: var(--color-primary); background: var(--color-primary-light); font-size: var(--font-size-badge); font-weight: var(--font-weight-badge); }
.form-grid { display: grid; gap: 0 20px; }
.form-grid--two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.form-grid--three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.field-help { width: 100%; margin: 5px 0 0; color: var(--color-text-muted); font-size: var(--font-size-badge); line-height: 1.5; }
.creator-owner { display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; align-items: center; gap: 12px; margin-bottom: var(--spacing-card); padding: 14px 16px; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-bg-subtle); }
.creator-owner__avatar { display: grid; width: 40px; height: 40px; place-items: center; border-radius: 50%; color: var(--color-primary); background: var(--color-primary-light); font-size: var(--font-size-body); font-weight: var(--font-weight-title); }
.creator-owner > div { display: flex; min-width: 0; flex-direction: column; }
.creator-owner small { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.creator-owner strong { margin-top: 2px; color: var(--color-text-heading); font-size: var(--font-size-body); }
.creator-owner p { margin: 3px 0 0; color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.configuration-section-heading { display: flex; align-items: baseline; gap: 10px; margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid var(--color-border); }
.configuration-section-heading strong { color: var(--color-text-heading); font-size: var(--font-size-body); }
.configuration-section-heading span { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.configuration-section-heading--permissions { margin-top: 24px; }
.selection-overview { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 12px; }
.selection-overview > div { display: grid; grid-template-columns: 1fr auto; align-items: center; padding: 14px; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-bg-subtle); }
.selection-overview span, .draft-summary span { color: var(--color-text-secondary); font-size: var(--font-size-caption); }
.selection-overview strong { color: var(--color-text-heading); font-size: var(--font-size-heading); }
.selection-overview small { grid-column: 1 / -1; color: var(--color-text-muted); font-size: var(--font-size-badge); }
.mcp-selection { margin-top: 16px; }
.selected-mcp { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-card); margin-bottom: 8px; }
.selected-mcp > div { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 3px; }
.selected-mcp strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.selected-mcp small { color: var(--color-text-muted); }
.field-help--error { color: var(--color-danger); }
.execution-grant-actions { display: flex; align-items: center; gap: var(--space-2, 8px); margin: calc(-1 * var(--space-1, 4px)) 0 var(--space-3, 12px); }
.execution-grant-ack { margin: 0 0 var(--space-3, 12px); white-space: normal; height: auto; }
.agent-governance-collapse { margin-top: 24px; }
.mcp-tool-detail { padding: 12px 0; border-bottom: 1px solid var(--color-border); }
.mcp-tool-detail p { color: var(--color-text-secondary); }
.mcp-tool-detail pre { max-height: 220px; overflow: auto; padding: 10px; background: var(--color-bg-subtle); }
.review-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.employee-preview, .draft-summary { padding: 16px; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-bg-base); }
.employee-preview h4, .draft-summary h4 { margin-bottom: 14px; }
.employee-preview__frame { min-height: 270px; padding: 18px; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-bg-subtle); }
.employee-preview__identity { display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; align-items: center; gap: 10px; }
.employee-preview__avatar { display: grid; width: 40px; height: 40px; place-items: center; border-radius: var(--radius-button); color: var(--color-bg-base); background: var(--color-primary); font-size: var(--font-size-heading); font-weight: var(--font-weight-heading); font-style: italic; }
.employee-preview__identity div { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.employee-preview__identity strong { overflow: hidden; color: var(--color-text-heading); font-size: var(--font-size-body); text-overflow: ellipsis; white-space: nowrap; }
.employee-preview__identity small, .employee-preview__visibility { color: var(--color-text-muted); font-size: var(--font-size-badge); }
.employee-preview__description { margin: 16px 0 12px; color: var(--color-text-secondary); font-size: var(--font-size-caption); line-height: 1.6; }
.employee-preview__message { padding: 12px 14px; border: 1px solid var(--color-border); border-radius: var(--radius-card); color: var(--color-text-primary); background: var(--color-bg-base); font-size: var(--font-size-caption); line-height: 1.6; }
.employee-preview__capabilities { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0; }
.employee-preview__capabilities span { padding: 4px 8px; border-radius: var(--radius-tag); color: var(--color-primary); background: var(--color-primary-light); font-size: var(--font-size-badge); }
.draft-summary { background: var(--color-bg-subtle); }
.draft-summary__grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.draft-summary__grid--create { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.draft-summary__grid > div { display: flex; min-width: 0; flex-direction: column; gap: 4px; }
.draft-summary strong { overflow: hidden; color: var(--color-text-heading); font-size: var(--font-size-caption); text-overflow: ellipsis; white-space: nowrap; }
.draft-summary small { overflow: hidden; color: var(--color-text-muted); font-size: var(--font-size-badge); text-overflow: ellipsis; white-space: nowrap; }
.agent-editor__footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.agent-editor__footer > div { display: flex; gap: 8px; }
:deep(.el-form-item) { margin-bottom: 20px; }
:deep(.el-form-item__label) { color: var(--color-text-heading); font-weight: var(--font-weight-title); }
:deep(.el-select), :deep(.el-input-number) { width: 100%; }
:deep(.el-step__title) { font-size: var(--font-size-body); }
:deep(.el-step__description) { font-size: var(--font-size-badge); }
:deep(.el-empty) { padding: 24px 0 8px; }
@media (max-width: 800px) {
  .form-grid--two, .form-grid--three, .review-grid, .draft-summary__grid, .draft-completion__summary { grid-template-columns: 1fr; }
  .draft-completion__summary > div:nth-last-child(2) { border-bottom: 1px solid var(--color-border); }
  .agent-editor__pane { min-height: 0; }
  .creation-mode { align-items: stretch; flex-direction: column; }
}
</style>
