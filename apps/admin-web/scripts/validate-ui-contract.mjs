import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const failures = []

function read(path) {
  try {
    return readFileSync(resolve(root, path), 'utf8')
  } catch {
    failures.push(`${path} 文件不存在`)
    return ''
  }
}

function requireFragments(path, fragments) {
  const content = read(path)
  for (const fragment of fragments) {
    if (!content.includes(fragment)) failures.push(`${path} 缺少：${fragment}`)
  }
}

function forbidFragments(path, fragments) {
  const content = read(path)
  for (const fragment of fragments) {
    if (content.includes(fragment)) failures.push(`${path} 不应包含：${fragment}`)
  }
}

requireFragments('src/styles.css', [
  '--color-bg-page',
  '--color-text-heading',
  '--spacing-section',
  '.ops-page',
  '.content-panel',
  '.filter-panel',
  '.filter-bar',
  '.status-tabs',
  '.metric-grid',
  '.data-table',
])

requireFragments('../../packages/admin-components/src/AdminShell.vue', [
  'admin-sidebar',
  'admin-topbar',
  'navigationGroups',
  '运营概览',
  '管理助手',
  'Agent 治理',
  'Skill 管理',
  'DSH 工具管理',
  '连接器管理',
  '组织与权限',
  '工具权限',
  '模型用量',
  '模型治理',
  '运行治理',
  'Runtimes',
  'Session 列表',
  '工作空间',
  '安全与运维',
  '开发接入',
  '接入规范',
  '接口文档',
  '返回员工工作台',
])
forbidFragments('../../packages/admin-components/src/AdminShell.vue', [
  'environmentLabel',
  'environment-status',
  '原型接口',
])
forbidFragments('index.html', ['交互原型'])

const adminShell = read('../../packages/admin-components/src/AdminShell.vue')
const securityGroupIndex = adminShell.indexOf("label: '安全与运维'")
const runtimeNavigationIndex = adminShell.indexOf("label: 'Runtimes'")
const auditNavigationIndex = adminShell.indexOf("label: '审计记录'")
if (!(securityGroupIndex < runtimeNavigationIndex && runtimeNavigationIndex < auditNavigationIndex)) {
  failures.push('Runtimes 必须位于安全与运维导航组中')
}

requireFragments('src/router/index.ts', [
  "meta: { title: '运营概览'",
  "meta: { title: '管理助手'",
  "meta: { title: 'Agent 管理'",
  "meta: { title: 'Agent 发布工作台 ·",
  "path: '/agents/:agentId/release/definition'",
  "path: '/agents/:agentId/release/checks'",
  "path: '/agents/:agentId/release/trial'",
  "path: '/agents/:agentId/release/review'",
  "meta: { title: 'Skill 管理'",
  "meta: { title: 'DSH 工具管理'",
  "meta: { title: '连接器管理'",
  "meta: { title: '模型用量'",
  "meta: { title: '模型治理'",
  "meta: { title: 'Runtimes'",
  "meta: { title: 'Session 列表'",
  "meta: { title: '工作空间'",
  "meta: { title: '工具权限'",
  "meta: { title: '审计记录'",
  "meta: { title: '系统健康'",
  "meta: { title: '接入规范'",
  "meta: { title: '接口文档'",
])

const businessViews = [
  'AdminOverviewView.vue',
  'AgentManagementView.vue',
  'AgentReleaseWorkbenchView.vue',
  'CapabilityManagementView.vue',
  'PermissionManagementView.vue',
  'AuditView.vue',
  'SystemHealthView.vue',
  'RuntimeManagementView.vue',
  'WorkspaceManagementView.vue',
]

const listViews = [
  'AgentManagementView.vue',
  'CapabilityManagementView.vue',
  'PermissionManagementView.vue',
  'AuditView.vue',
  'RuntimeManagementView.vue',
  'WorkspaceManagementView.vue',
]

for (const name of businessViews) {
  requireFragments(`src/views/${name}`, ['ops-page', 'contentStore.error'])
}

// 服务端分页视图自行管理拉取与错误（usePagedList 的 error ref + el-alert）
requireFragments('src/views/SessionManagementView.vue', ['ops-page', 'sessionsError'])
requireFragments('src/views/ModelUsageView.vue', ['ops-page', 'pageError'])

for (const name of listViews) {
  requireFragments(`src/views/${name}`, ['filter-panel', 'class="data-table"', 'v-loading', 'empty-text='])
}

requireFragments('src/views/AgentManagementView.vue', [
  'data-action="view-agent"',
  'data-action="open-candidate"',
  '@continue-release="openCandidate"',
])
forbidFragments('src/views/AgentManagementView.vue', ["activeDetailTab === 'candidate'", 'data-action="publish-agent"'])
const agentManagementView = read('src/views/AgentManagementView.vue')
const savedHandlerStart = agentManagementView.indexOf('function handleDraftSaved')
const savedHandlerEnd = agentManagementView.indexOf('function evidenceName', savedHandlerStart)
if (savedHandlerStart < 0 || savedHandlerEnd < 0 || agentManagementView.slice(savedHandlerStart, savedHandlerEnd).includes('router.push')) {
  failures.push('Agent 草稿保存或导入完成后不得自动跳转发布页面')
}
requireFragments('src/components/AgentDraftDialog.vue', [
  '草稿已保存在 Agent 管理中',
  '进入定义与依赖',
  "'continue-release': [agent: AgentDefinition]",
])
requireFragments('src/views/AgentReleaseWorkbenchView.vue', [
  '候选发布流程',
  '版本与变更详情',
  '依赖状态',
  '试运行案例',
  "activeStep === 'definition'",
  "activeStep === 'checks'",
  "activeStep === 'trial'",
  'data-action="publish-agent"',
])
forbidFragments('src/views/AgentReleaseWorkbenchView.vue', ['class="workbench-header"'])
requireFragments('src/views/CapabilityManagementView.vue', [
  'data-action="view-skill"',
  'data-action="view-tool"',
  'data-action="view-connector"',
  '工具列表',
  '连接器列表',
  '新增 Skill',
])
forbidFragments('src/views/CapabilityManagementView.vue', [
  'data-action="edit-tool"',
  'data-action="edit-connector"',
  'data-action="create-tools"',
  'data-action="create-connectors"',
  '一期由实施团队预置',
  '一期由实施团队配置',
  'SkillEditorDialog',
  'data-action="create-skills"',
])
requireFragments('src/views/ModelUsageView.vue', [
  'data-action="view-model-usage"',
  'data-action="view-employee-model-usage"',
  '员工统计',
  '筛选员工',
])
requireFragments('src/views/ModelGovernanceView.vue', [
  'ops-page',
  'class="data-table"',
  'v-loading',
  'empty-text=',
  '密钥正文未进入 dsh-work',
  'Agent 不单独配置模型',
])
requireFragments('src/views/PermissionManagementView.vue', ['data-action="configure-tool-permission"'])
requireFragments('src/views/AuditView.vue', ['data-action="view-audit"'])
requireFragments('src/views/SystemHealthView.vue', ['data-action="refresh-health"'])
forbidFragments('src/views/SystemHealthView.vue', [
  'MVP',
  '模块化单体',
  '接入状态',
  '运行边界',
])
requireFragments('src/views/RuntimeManagementView.vue', [
  'data-action="view-runtime"',
  'data-action="check-runtime"',
  'data-action="configure-runtime"',
  'data-action="save-runtime-configuration"',
  '最大并发 Worker 数',
  '单次执行超时时间',
  '调度状态',
])
requireFragments('src/views/SessionManagementView.vue', ['data-action="view-session"', 'data-action="view-session-audit"'])
requireFragments('src/views/WorkspaceManagementView.vue', ['data-action="view-workspace"'])

const viewDirectory = resolve(root, 'src/views')
const viewFiles = readdirSync(viewDirectory).filter((name) => name.endsWith('.vue'))
const forbiddenPatterns = [
  { pattern: /<table\b/i, reason: '不得使用原生 table' },
  { pattern: /class="[^"]*page-container/, reason: '不得继续使用旧 page-container 页面骨架' },
  { pattern: /class="[^"]*page-header/, reason: '页面标题由应用壳层承载' },
  { pattern: /<h1\b/i, reason: '页面标题不得在内容区重复渲染' },
  { pattern: /#[0-9a-f]{3,8}\b/i, reason: '页面局部样式不得硬编码色值' },
]

for (const name of viewFiles) {
  const content = read(`src/views/${name}`)
  for (const { pattern, reason } of forbiddenPatterns) {
    if (pattern.test(content)) failures.push(`src/views/${name}：${reason}`)
  }
}

if (failures.length) {
  console.error('管理端 UI 契约验证失败：')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('管理端 UI 契约验证通过。')
