<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'

import AgentZipImportPanel from '@/components/AgentZipImportPanel.vue'
import type { ZipInspection } from '@/stores/agentGovernance'
import { useAuthStore } from '@/stores/auth'
import { useContentStore } from '@/stores/content'
import type { AgentDefinition, AgentDraftConfiguration } from '@/types/domain'

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
}>()
const roleLabels: Record<string, string> = {
  'role-platform-admin': '平台管理员',
  'role-employee': '试点员工',
  'role-supply': '供应链分析人员',
  'role-manager': '部门负责人',
  'role-auditor': '安全审计员',
}

const form = reactive<AgentDraftConfiguration>(emptyDraft())

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
    { required: true, message: '请输入 System Prompt', trigger: 'blur' },
    { min: 20, message: 'System Prompt 至少需要 20 个字符', trigger: 'blur' },
  ],
  skills: [{ type: 'array', required: true, min: 1, message: '请至少引用一个已发布 Skill', trigger: 'change' }],
  tools: [{ type: 'array', required: true, min: 1, message: '请至少选择一个可用工具', trigger: 'change' }],
  roleIds: [{ type: 'array', required: true, min: 1, message: '请至少选择一个可见角色', trigger: 'change' }],
  dataScopes: [{ type: 'array', required: true, min: 1, message: '请至少配置一个业务数据范围', trigger: 'change' }],
}

const publishedSkills = computed(() => contentStore.skills.filter((skill) =>
  Boolean(skill.activeVersion) && skill.status !== 'disabled',
))
const usableTools = computed(() => contentStore.tools.filter((tool) => tool.status === 'available'))
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
const roleOptions = computed(() => unique([
  'role-employee',
  ...contentStore.agents.flatMap((agent) => agent.roleIds),
  ...form.roleIds,
]).map((id) => ({ id, name: roleName(id) })))
const selectedRoleNames = computed(() => form.roleIds.map(roleName))
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
  ['name', 'description'],
  ['systemPrompt', 'skills', 'tools', 'roleIds', 'dataScopes'],
]

watch(dialogOpen, (open) => {
  if (open) resetEditor()
})

watch(() => [...form.skills], (references) => {
  const requiredTools = references.flatMap((reference) => {
    const separator = reference.lastIndexOf('@')
    const skillId = separator > 0 ? reference.slice(0, separator) : reference
    const skill = contentStore.skills.find(item => item.id === skillId)
    return skill?.toolIds.map(toVersionedToolReference) ?? []
  })
  form.tools = unique([...form.tools, ...requiredTools])
})

function emptyDraft(): AgentDraftConfiguration {
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
    maxOutputBytes: 65536,
    maxToolCalls: 20,
    timeoutSeconds: 300,
    skills: [],
    tools: [],
    changeSummary: '创建初始草稿版本',
  }
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
        maxOutputBytes: props.agent.maxOutputBytes,
        maxToolCalls: props.agent.maxToolCalls,
        timeoutSeconds: props.agent.timeoutSeconds,
        skills: [...props.agent.skills],
        tools: props.agent.tools.map(toVersionedToolReference),
        changeSummary: `更新 ${props.agent.name} 草稿配置`,
      }
    : emptyDraft()
  Object.assign(form, source)
  savedResult.value = undefined
  creationMode.value = 'config'
  activeStep.value = 0
  examplePrompt.value = source.examplePrompts[0] ?? '请介绍你能提供哪些帮助'
  initialSnapshot.value = JSON.stringify(form)
  formRef.value?.clearValidate()
}

async function nextStep() {
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
      : await contentStore.createAgentDraft(payload)
    initialSnapshot.value = JSON.stringify(form)
    savedResult.value = { agent: saved, source: 'config' }
    emit('saved', saved, 'config')
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : 'Agent 保存失败')
  } finally {
    saving.value = false
  }
}

function findFirstInvalidStep() {
  if (!form.name || !form.description) return 0
  if (!form.systemPrompt || !form.skills.length || !form.tools.length || !form.roleIds.length || !form.dataScopes.length) return 1
  return -1
}

function handleZipSaved(agent: AgentDefinition, inspection: ZipInspection) {
  savedResult.value = { agent, source: 'zip', inspection }
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

function cloneDraft(value: AgentDraftConfiguration): AgentDraftConfiguration {
  return {
    ...value,
    roleIds: [...value.roleIds],
    dataScopes: [...value.dataScopes],
    examplePrompts: [...value.examplePrompts],
    skills: [...value.skills],
    tools: [...value.tools],
  }
}

function preparePayload(value: AgentDraftConfiguration): AgentDraftConfiguration {
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
  return roleLabels[roleId] ?? roleId
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
        <div><dt>能力引用</dt><dd>{{ savedResult.agent.skills.length }} 个 Skill · {{ savedResult.agent.tools.length }} 个工具</dd></div>
      </dl>
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
        <el-step title="定义 Agent" description="名称、说明和欢迎语" />
        <el-step title="配置能力和权限" description="Prompt、Skill、工具和权限" />
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
      </section>

      <section v-show="activeStep === 1" class="agent-editor__pane" aria-label="Agent 能力配置">
        <header class="pane-heading">
          <div><h3>配置能力和权限</h3><p>定义 Agent 如何工作，以及哪些员工可以在什么数据范围内使用。</p></div>
          <span class="step-badge">2 / 3</span>
        </header>
        <div class="configuration-section-heading"><strong>能力配置</strong><span>组合 System Prompt、Skill 和工具</span></div>
        <el-form-item label="System Prompt" prop="systemPrompt">
          <el-input v-model="form.systemPrompt" type="textarea" :rows="6" maxlength="2000" show-word-limit placeholder="定义 Agent 的角色、目标、执行边界、输出要求和禁止事项" />
          <p class="field-help">不得包含凭证或密钥；发布后随 Agent 版本锁定。</p>
        </el-form-item>
        <div class="form-grid form-grid--two">
          <el-form-item label="引用 Skill" prop="skills">
            <el-select v-model="form.skills" multiple filterable collapse-tags :max-collapse-tags="2" placeholder="选择已发布 Skill">
              <el-option v-for="skill in publishedSkills" :key="skill.id" :label="`${skill.name} · v${skill.activeVersion}`" :value="`${skill.id}@${skill.activeVersion}`" />
            </el-select>
            <p class="field-help">仅允许引用已发布版本，运行时锁定具体版本。</p>
          </el-form-item>
          <el-form-item label="工具允许列表" prop="tools">
            <el-select v-model="form.tools" multiple filterable collapse-tags :max-collapse-tags="2" placeholder="选择 Agent 可调用的工具">
              <el-option v-for="tool in usableTools" :key="tool.id" :label="`${tool.name} · v${tool.version ?? '1.0.0'} · ${tool.system}`" :value="`${tool.id}@${tool.version ?? '1.0.0'}`" />
            </el-select>
            <p class="field-help">这里只声明允许列表，实际调用仍需通过员工和数据权限检查。</p>
          </el-form-item>
        </div>
        <div class="selection-overview">
          <div><span>Skill</span><strong>{{ form.skills.length }}</strong><small>个已选择</small></div>
          <div><span>工具</span><strong>{{ form.tools.length }}</strong><small>个已允许</small></div>
        </div>
        <div class="configuration-section-heading configuration-section-heading--permissions"><strong>权限配置</strong><span>Agent 权限只能收窄员工原有权限</span></div>
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
        <el-alert type="info" :closable="false" show-icon title="涉及敏感数据或写操作时，工具自身的审批策略仍然生效。" />
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
              <div><span>能力</span><strong>{{ form.skills.length }} 个 Skill</strong><small>{{ form.tools.length }} 个工具</small></div>
              <div><span>权限</span><strong>{{ selectedRoleNames.length }} 个可见角色</strong><small>{{ form.dataScopes.length }} 个数据范围</small></div>
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
.draft-summary__grid--create { grid-template-columns: repeat(3, minmax(0, 1fr)); }
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
  .form-grid--two, .review-grid, .draft-summary__grid, .draft-completion__summary { grid-template-columns: 1fr; }
  .draft-completion__summary > div:nth-last-child(2) { border-bottom: 1px solid var(--color-border); }
  .agent-editor__pane { min-height: 0; }
  .creation-mode { align-items: stretch; flex-direction: column; }
}
</style>
