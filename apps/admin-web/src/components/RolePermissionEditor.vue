<script setup lang="ts">
import { computed } from 'vue'

import {
  ADMIN_MODULE_DESCRIPTIONS,
  ADMIN_MODULE_LABELS,
  ADMIN_MODULES,
  READ_ONLY_MODULES,
  modulePermission,
  moduleLevelsOf,
  permissionsBeyond,
  type AdminModule,
  type AdminModuleLevel,
  type AdminModuleLevels,
} from '@/utils/admin-modules'

/**
 * 角色的功能权限按模块编辑（功能规则第 13 节）。旧的 `admin:read` / `admin:write`
 * 显示为各模块全部查看 / 修改，修改任一模块后改存为逐个模块的权限码。超出操作人自身的选项不可勾选。
 */
const props = defineProps<{
  modelValue: string[]
  /** 操作人自己的权限码，用于“授出不超过自身”的提示；平台管理员含 admin:*。 */
  actorPermissions: string[]
  locked: boolean
  /** 平台管理员角色：权限固定为 admin:*，只能改名称。 */
  platformRole: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [permissions: string[]] }>()

const LEGACY_ALL = new Set(['admin:read', 'admin:write'])
const KNOWLEDGE_LEVELS = [['', '无'], ['knowledge:view', '查看'], ['knowledge:docs', '管理文档'], ['knowledge:bases', '管理知识库']] as const

const levels = computed(() => moduleLevelsOf(props.modelValue))
const granted = computed(() => new Set(props.modelValue))
const editable = computed(() => !props.locked && !props.platformRole)

function beyond(code: string) {
  return !granted.value.has(code) && permissionsBeyond([code], props.actorPermissions).length > 0
}

function isModuleCode(code: string) {
  return LEGACY_ALL.has(code) || ADMIN_MODULES.some(module => code === modulePermission(module, 'read') || code === modulePermission(module, 'write'))
}

function withLevels(next: AdminModuleLevels) {
  const kept = props.modelValue.filter(code => !isModuleCode(code))
  const moduleCodes = ADMIN_MODULES.flatMap((module) => {
    if (next[module] === 'none') return []
    return [modulePermission(module, next[module] === 'write' && !READ_ONLY_MODULES.has(module) ? 'write' : 'read')]
  })
  emit('update:modelValue', [...kept, ...moduleCodes])
}

function setLevel(module: AdminModule, level: AdminModuleLevel) {
  withLevels({ ...levels.value, [module]: level })
}

function toggleView(module: AdminModule) {
  setLevel(module, levels.value[module] === 'none' ? 'read' : 'none')
}

function toggleWrite(module: AdminModule) {
  setLevel(module, levels.value[module] === 'write' ? 'read' : 'write')
}

function toggleCode(code: string) {
  const next = granted.value.has(code) ? props.modelValue.filter(item => item !== code) : [...props.modelValue, code]
  emit('update:modelValue', next)
}

function setKnowledgeLevel(code: string) {
  const next = props.modelValue.filter(item => !item.startsWith('knowledge:'))
  emit('update:modelValue', code ? [...next, code] : next)
}

const knowledgeLevel = computed(() => KNOWLEDGE_LEVELS.slice(1).reverse().find(([code]) => granted.value.has(code))?.[0] ?? '')

/** 快捷操作只勾选操作人自己有的模块与级别。 */
function setAll(level: 'read' | 'write' | 'none') {
  const next = Object.fromEntries(ADMIN_MODULES.map((module) => {
    if (level === 'none') return [module, 'none']
    const wanted: AdminModuleLevel = READ_ONLY_MODULES.has(module) ? 'read' : level
    const writeCode = modulePermission(module, 'write')
    const readCode = modulePermission(module, 'read')
    if (wanted === 'write' && permissionsBeyond([writeCode], props.actorPermissions).length === 0) return [module, 'write']
    if (permissionsBeyond([readCode], props.actorPermissions).length === 0) return [module, 'read']
    return [module, levels.value[module]]
  })) as AdminModuleLevels
  withLevels(next)
}

const TEMPLATES: Array<{ label: string; permissions: string[] }> = [
  { label: '知识库管理员', permissions: ['admin:knowledge:write', 'workbench:use', 'knowledge:bases'] },
  { label: 'Agent 管理员', permissions: ['admin:agent:write', 'admin:skill:write', 'admin:connector:read', 'workbench:use'] },
  { label: '模型与数据防护管理员', permissions: ['admin:model:write', 'admin:dlp:write', 'workbench:use'] },
  { label: '人事管理员', permissions: ['admin:identity:write', 'admin:dingtalk:write', 'admin:org:write', 'workbench:use', 'knowledge:view'] },
]
const templates = computed(() => TEMPLATES.filter(template => permissionsBeyond(template.permissions, props.actorPermissions).length === 0))
function applyTemplate(permissions: string[]) {
  emit('update:modelValue', [...permissions])
}

const legacyAll = computed(() => props.modelValue.some(code => LEGACY_ALL.has(code)))
/** 平台级权限 `admin:*`（功能规则第 13 节）：只有平台管理员能授出，因此只对平台管理员显示；已含该权限的角色也显示。 */
const showPlatformOption = computed(() => !props.platformRole && (props.actorPermissions.includes('admin:*') || granted.value.has('admin:*')))

const sections = computed(() => ADMIN_MODULES.map((module) => {
  const level = levels.value[module]
  const readCode = modulePermission(module, 'read')
  const writeCode = modulePermission(module, 'write')
  return {
    module,
    label: ADMIN_MODULE_LABELS[module],
    description: module === 'knowledge' ? '管理端：连接与全部知识库；员工端：部门知识库与文档' : ADMIN_MODULE_DESCRIPTIONS[module],
    view: level !== 'none',
    write: level === 'write',
    hasWrite: !READ_ONLY_MODULES.has(module),
    viewDisabled: !editable.value || level === 'write' || (level === 'none' && beyond(readCode)),
    writeDisabled: !editable.value || (level !== 'write' && beyond(writeCode)),
    viewBeyond: level === 'none' && beyond(readCode),
    writeBeyond: level !== 'write' && beyond(writeCode),
    prefix: module === 'knowledge' ? '管理端' : '',
  }
}))
</script>

<template>
  <div class="role-permissions">
    <div v-if="editable" class="role-permissions__toolbar">
      <span class="role-permissions__muted">模板：</span>
      <el-button v-for="template in templates" :key="template.label" link type="primary" @click="applyTemplate(template.permissions)">{{ template.label }}</el-button>
      <span class="role-permissions__muted" aria-hidden="true">|</span>
      <el-button link type="primary" @click="setAll('read')">全部查看</el-button>
      <el-button link type="primary" @click="setAll('write')">全部修改</el-button>
      <el-button link type="primary" @click="setAll('none')">清空</el-button>
    </div>
    <el-alert v-if="platformRole" type="info" :closable="false" title="平台管理员角色拥有全部权限（admin:*），只能修改名称、说明。" />
    <el-alert v-else-if="legacyAll && editable" type="info" :closable="false" title="该角色使用旧的“全部模块”权限；修改任一模块后将改存为逐个模块的权限，以后新增的模块不会自动包含。" />
    <section v-if="showPlatformOption" class="role-permissions__section role-permissions__platform" aria-label="平台管理员">
      <strong>平台管理员</strong>
      <p>全部模块与审计的全部权限，包括授出平台管理员权限、修改钉钉应用配置。只有平台管理员可以授出。</p>
      <el-checkbox :model-value="granted.has('admin:*')" :disabled="!editable || beyond('admin:*')" @change="toggleCode('admin:*')">
        平台管理员权限（admin:*）
      </el-checkbox>
    </section>
    <div class="role-permissions__grid">
      <section v-for="section in sections" :key="section.module" class="role-permissions__section" :aria-label="section.label">
        <strong>{{ section.label }}</strong>
        <p>{{ section.description }}</p>
        <div class="role-permissions__options">
          <el-checkbox :model-value="section.view" :disabled="section.viewDisabled" @change="toggleView(section.module)">
            {{ section.prefix }}查看<small v-if="section.viewBeyond && editable">（超出你的权限）</small>
          </el-checkbox>
          <el-checkbox v-if="section.hasWrite" :model-value="section.write" :disabled="section.writeDisabled" @change="toggleWrite(section.module)">
            {{ section.prefix }}修改<small v-if="editable">（{{ section.writeBeyond ? '超出你的权限' : '含查看' }}）</small>
          </el-checkbox>
          <el-checkbox
            v-if="section.module === 'dlp'"
            :model-value="granted.has('data-protection:terms')"
            :disabled="!editable || !section.view || beyond('data-protection:terms')"
            @change="toggleCode('data-protection:terms')"
          >
            保密词表与白名单<small v-if="editable">（{{ beyond('data-protection:terms') ? '超出你的权限' : section.view ? '机密内容，单独授权' : '需先有数据防护查看' }}）</small>
          </el-checkbox>
        </div>
        <el-radio-group
          v-if="section.module === 'knowledge'"
          class="role-permissions__radios"
          aria-label="员工端企业知识库级别"
          :model-value="knowledgeLevel"
          :disabled="!editable"
          @change="setKnowledgeLevel(String($event))"
        >
          <span class="role-permissions__muted">员工端：</span>
          <el-radio v-for="[code, label] in KNOWLEDGE_LEVELS" :key="code" :value="code" :disabled="!editable || (Boolean(code) && beyond(code) && knowledgeLevel !== code)">{{ label }}</el-radio>
        </el-radio-group>
      </section>
      <section class="role-permissions__section" aria-label="审计">
        <strong>审计</strong>
        <p>审计记录、运行治理</p>
        <div class="role-permissions__options">
          <el-checkbox :model-value="granted.has('audit:read')" :disabled="!editable || beyond('audit:read')" @change="toggleCode('audit:read')">
            查看<small v-if="editable && beyond('audit:read')">（超出你的权限）</small>
          </el-checkbox>
        </div>
      </section>
      <section class="role-permissions__section" aria-label="员工工作台">
        <strong>员工工作台</strong>
        <p>员工端登录与部门管理</p>
        <div class="role-permissions__options">
          <el-checkbox :model-value="granted.has('workbench:use')" :disabled="!editable || beyond('workbench:use')" @change="toggleCode('workbench:use')">使用</el-checkbox>
          <el-checkbox :model-value="granted.has('workbench:manage')" :disabled="!editable || beyond('workbench:manage')" @change="toggleCode('workbench:manage')">
            管理部门工作内容<small v-if="editable && beyond('workbench:manage')">（超出你的权限）</small>
          </el-checkbox>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.role-permissions { display: grid; width: 100%; gap: 10px; }
.role-permissions__toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; }
.role-permissions__toolbar .el-button { margin-left: 0; }
.role-permissions__muted { color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.role-permissions__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
.role-permissions__section { padding: 12px; border: 1px solid var(--color-border); border-radius: var(--radius-tag); }
.role-permissions__section > strong { display: block; color: var(--color-text-heading); font-size: var(--font-size-caption); }
.role-permissions__section > p { margin: 2px 0 8px; color: var(--color-text-secondary); font-size: var(--font-size-badge); }
.role-permissions__options { display: flex; flex-wrap: wrap; gap: 4px 18px; }
.role-permissions__options small { color: var(--color-text-secondary); }
.role-permissions__radios { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--color-border); }
.role-permissions__radios .el-radio { margin-right: 0; }
</style>
