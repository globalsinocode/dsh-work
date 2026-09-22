import ElementPlus, { ElNotification } from 'element-plus'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import CapabilityManagementView from './CapabilityManagementView.vue'
import { useAuthStore } from '../stores/auth'
import { useContentStore } from '../stores/content'
import { useToolGovernanceStore } from '../stores/toolGovernance'

const wrappers: VueWrapper[] = []
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function render(canManage = true, initial = '/skills') {
  const pinia = createPinia()
  setActivePinia(pinia)
  useAuthStore().$patch({ permissions: canManage ? ['admin:write'] : ['admin:read'] })
  const content = useContentStore()
  vi.spyOn(content, 'load').mockResolvedValue(undefined)
  const toolGovernance = useToolGovernanceStore()
  vi.spyOn(toolGovernance, 'loadBindings').mockResolvedValue(undefined)
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/skills', component: CapabilityManagementView },
    { path: '/skills/install', component: CapabilityManagementView },
    { path: '/tools', component: CapabilityManagementView },
    { path: '/connectors', component: CapabilityManagementView },
  ] })
  await router.push(initial)
  await router.isReady()
  const wrapper = mount(CapabilityManagementView, {
    global: {
      plugins: [pinia, router, ElementPlus],
      stubs: {
        teleport: true,
        ElSelect: { template: '<div class="el-select-stub"><slot /></div>' },
        ElOption: true,
        ElDropdown: { template: '<div class="el-dropdown-stub"><slot /><slot name="dropdown" /></div>' },
        ElDropdownMenu: { template: '<div class="el-dropdown-menu-stub"><slot /></div>' },
        ElDropdownItem: { template: '<button type="button"><slot /></button>' },
      },
    },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return { wrapper, router, auth: useAuthStore(), content, toolGovernance }
}

function strictDraftSkill(): import('../types/domain').SkillDefinition {
  return {
    packageSha256: 'sha256-package',
    id: 'skill-strict-test',
    name: '严格试运行 Skill',
    version: '0.1.0',
    category: '测试',
    owner: '平台管理员',
    status: 'draft',
    description: '用于验证严格试运行交互反馈。',
    instructions: '先激活 Skill，然后按照测试输入完成验证并返回结果。',
    toolIds: [],
    testPrompt: '验证当前 Skill',
    updatedAt: '2026-09-13 15:00',
  }
}

function disabledDshTool(): import('../types/domain').ToolDefinition {
  return {
    id: 'read', version: '1.0.0', name: '读取文件', system: 'DSH Runtime',
    description: '读取当前 Run 已授权的文件。', connectorId: 'connector-dsh-workspace',
    risk: 'low', mode: 'read', status: 'disabled', inputSchema: '{}', outputSchema: '{}',
    outputValidation: 'unavailable', retryPolicy: 'safe', concurrencyPolicy: 'concurrent',
    completionSemantics: 'completed', timeoutSeconds: 30, allowedRoles: ['平台管理员'],
    dataScopes: ['workspace:authorized'], approvalPolicy: 'none', lastCheckedAt: '刚刚',
  }
}

function offlinePendingMcp(): import('../types/domain').ConnectorDefinition {
  return {
    id: 'connector-mcp-offline', name: '离线待审核 MCP', system: 'MCP', status: 'offline',
    toolCount: 1, protocol: 'mcp', endpoint: 'https://mcp.example.invalid/mcp', authType: 'bearer',
    credentialRef: '已加密存储', scopeDescription: '只读测试范围', latency: '—', lastCheckedAt: '刚刚',
    lastHealthMessage: 'MCP 认证失败：Bearer Token 已过期',
    createdAt: '2026-09-20T02:30:00.000Z', createdBy: '陈默', updatedAt: '2026-09-22T00:05:00.000Z',
    mcp: {
      serverName: 'offline_pending', transport: 'streamable-http', approvalStatus: 'pending_review',
      capabilityDigest: 'a'.repeat(64), approvedDigest: null, capabilityCount: 1,
      capabilities: [{ name: 'query', description: '查询', inputSchema: { type: 'object' } }],
      grantedAgentIds: [], discoveredAt: '2026-09-22T00:00:00.000Z', reviewedAt: null, reviewedBy: null,
    },
  }
}

describe('Skill installation sibling tab', () => {
  it('opens the dedicated tab, removes the old create dialog, and preserves inputs across tabs', async () => {
    const { wrapper, router } = await render()
    expect(wrapper.findAll('[role="tablist"][aria-label="Skill 管理"] [role="tab"]').map(tab => tab.text())).toEqual(['Skill 列表 0', '新增 Skill'])
    expect(wrapper.find('[data-action="create-skills"]').exists()).toBe(false)
    await wrapper.get('#capability-tab-install').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/skills/install')
    expect(wrapper.get('#capability-panel-install').isVisible()).toBe(true)
    expect(wrapper.find('.capability-toolbar').exists()).toBe(false)
    const fileInput = wrapper.get('input[type="file"]')
    Object.defineProperty(fileInput.element, 'files', { value: [new File(['demo'], 'sample.zip')], configurable: true })
    await fileInput.trigger('change')
    await flushPromises()
    await wrapper.get('#capability-tab-skills').trigger('click')
    await flushPromises()
    await wrapper.get('#capability-tab-install').trigger('click')
    await flushPromises()
    expect(wrapper.get('#capability-panel-install').text()).toContain('sample.zip')
    expect(wrapper.find('textarea').exists()).toBe(false)
  })

  it('hides installation from readers even for a direct URL and responds to permission revocation', async () => {
    const { wrapper, auth } = await render(false, '/skills/install')
    expect(wrapper.find('#capability-tab-install').exists()).toBe(false)
    expect(wrapper.find('#capability-panel-install').exists()).toBe(false)
    expect(wrapper.get('#capability-tab-skills').attributes('aria-selected')).toBe('true')
    auth.$patch({ permissions: ['admin:write'] })
    await flushPromises()
    expect(wrapper.get('#capability-panel-install').isVisible()).toBe(true)
    auth.$patch({ permissions: ['admin:read'] })
    await flushPromises()
    expect(wrapper.find('#capability-panel-install').exists()).toBe(false)
  })

  it('supports keyboard tab navigation', async () => {
    const { wrapper, router } = await render()
    await wrapper.get('#capability-tab-skills').trigger('keydown', { key: 'ArrowRight' })
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/skills/install')
    await wrapper.get('#capability-tab-install').trigger('keydown', { key: 'End' })
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/skills/install')
    await wrapper.get('#capability-tab-install').trigger('keydown', { key: 'ArrowLeft' })
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/skills')
  })

  it('renders tools and connectors as independent pages without the Skill tabs', async () => {
    const { wrapper, router } = await render(true, '/tools')
    expect(wrapper.find('[role="tablist"][aria-label="Skill 管理"]').exists()).toBe(false)
    expect(wrapper.get('[aria-label="DSH 内置工具列表"]').attributes('aria-label')).toBe('DSH 内置工具列表')
    expect(wrapper.get('.capability-toolbar input').attributes('placeholder')).toBe('搜索 DSH 内置工具名称、标识或说明')
    expect(wrapper.text()).toContain('MCP 工具随连接器清单自动同步')
    expect(wrapper.findAll('button').some(button => button.text() === '交给管理助手')).toBe(false)
    expect(wrapper.get('[data-action="add-tool"]').text()).toContain('添加工具')
    expect(wrapper.find('[data-action="register-tool-candidate"]').exists()).toBe(false)

    await router.push('/connectors')
    await flushPromises()
    expect(wrapper.get('[aria-label="MCP 连接器列表"]').attributes('aria-label')).toBe('MCP 连接器列表')
    expect(wrapper.get('.capability-toolbar input').attributes('placeholder')).toBe('搜索 MCP 名称、标识或 serverName')
  })

  it('adds a ready DSH tool with explicit role, scope and approval defaults', async () => {
    const { wrapper, content } = await render(true, '/tools')
    content.toolCatalog.push({
      id: 'edit', version: '1.0.0', name: '编辑文本文件', system: 'DSH Runtime',
      description: '精确替换成果目录中的文本。', connectorId: 'connector-dsh-workspace',
      risk: 'low', mode: 'write', timeoutSeconds: 30,
      defaultAllowedRoles: ['普通员工', '平台管理员'],
      defaultDataScopes: ['workspace:authorized'], defaultApprovalPolicy: 'none',
      outputValidation: 'unavailable', retryPolicy: 'never', concurrencyPolicy: 'serialized', completionSemantics: 'completed',
      requirements: ['当前 Run 工作区', '仅允许 output 成果目录'],
      status: 'ready', availabilityMessage: '当前部署已批准该工具，DSH Runtime 健康检查通过',
    })
    const addTool = vi.spyOn(content, 'addTool').mockResolvedValue({
      id: 'edit', version: '1.0.0', name: '编辑文本文件', system: 'DSH Runtime',
      description: '精确替换成果目录中的文本。', connectorId: 'connector-dsh-workspace',
      risk: 'low', mode: 'write', status: 'available', inputSchema: '{}', outputSchema: '{}',
      outputValidation: 'unavailable', retryPolicy: 'never', concurrencyPolicy: 'serialized', completionSemantics: 'completed',
      timeoutSeconds: 30, allowedRoles: ['普通员工', '平台管理员'],
      dataScopes: ['workspace:authorized'], approvalPolicy: 'none', lastCheckedAt: '刚刚',
    })
    await flushPromises()

    await wrapper.get('[data-action="add-tool"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('.tool-catalog-card').text()).toContain('edit@1.0.0')
    expect(wrapper.get('.tool-catalog-config').text()).toContain('仅允许 output 成果目录')
    await wrapper.get('[data-action="confirm-add-tool"]').trigger('click')
    await flushPromises()

    expect(addTool).toHaveBeenCalledWith({
      catalogId: 'edit',
      allowedRoles: ['普通员工', '平台管理员'],
      dataScopes: ['workspace:authorized'],
      approvalPolicy: 'none',
    })
  })

  it('does not expose tool creation to read-only administrators', async () => {
    const { wrapper } = await render(false, '/tools')
    expect(wrapper.find('[data-action="add-tool"]').exists()).toBe(false)
  })

  it('keeps the enable action when a disabled tool has revoked binding history', async () => {
    const { wrapper, content, toolGovernance } = await render(true, '/tools')
    content.tools.push(disabledDshTool())
    toolGovernance.serverBindings.read = {
      revoked: true,
      bindingRevision: {
        id: 'tool-binding-read rev2', endpoint: 'dsh://workspace', executor: 'read',
        credentialSlot: '—（无凭据槽位）', filterPolicy: 'Runtime Manifest + Sandbox · default', sealedAt: '刚刚',
      },
    }
    await flushPromises()

    expect(wrapper.get('[data-action="enable-tool"]').text()).toBe('启用')
    expect(wrapper.get('.el-table__row').text()).toContain('已停用')
    expect(wrapper.get('.el-table__row').text()).not.toContain('已撤销')
  })

  it('keeps offline status ahead of a retained legacy MCP review state', async () => {
    const { wrapper, content } = await render(true, '/connectors')
    const connector = offlinePendingMcp()
    content.connectors.push(connector)
    const check = vi.spyOn(content, 'checkConnector').mockResolvedValue(connector)
    const error = vi.spyOn(ElNotification, 'error').mockImplementation(() => ({ close: () => undefined }))
    const info = vi.spyOn(ElNotification, 'info').mockImplementation(() => ({ close: () => undefined }))
    await flushPromises()

    expect(wrapper.find('.mcp-summary').exists()).toBe(false)
    const headers = wrapper.findAll('.el-table__header th')
    expect(headers.map(header => header.text())).toEqual([
      '名称', 'Endpoint', '认证方式', '工具数量', '状态', '更新时间', '添加时间', '添加人员', '操作',
    ])
    expect(headers[3]?.classes()).toContain('is-center')
    expect(headers[7]?.classes()).toContain('is-center')
    expect(wrapper.get('.el-table__row').text()).toContain('离线')
    expect(wrapper.get('.el-table__row').text()).toContain('https://mcp.example.invalid/mcp')
    expect(wrapper.get('.el-table__row').text()).toContain('Bearer Token')
    expect(wrapper.get('.el-table__row').text()).toContain('陈默')
    expect(wrapper.get('.el-table__row').findAll('td')[7]?.classes()).toContain('is-center')
    expect(wrapper.find('.mcp-row-actions').exists()).toBe(true)
    expect(wrapper.get('[data-action="mcp-more"]').text()).toContain('更多')
    expect(wrapper.get('.el-table__row').text()).not.toContain('连通，待审核')
    expect(wrapper.find('[data-action="approve-mcp-connector"]').exists()).toBe(false)
    await wrapper.get('[data-action="view-mcp-tools"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[aria-label="MCP 工具清单"]').text()).toContain('query')
    expect(wrapper.get('[aria-label="MCP 工具清单"]').text()).toContain('查询')
    expect(wrapper.get('[aria-label="MCP 工具清单"]').text()).toContain('"type": "object"')
    await wrapper.get('[data-action="check-connector"]').trigger('click')
    await flushPromises()

    expect(check).toHaveBeenCalledWith(connector.id)
    expect(error).toHaveBeenCalledWith(expect.objectContaining({
      title: `连接器异常：${connector.name}`,
      message: expect.stringContaining('原因：MCP 认证失败：Bearer Token 已过期。'),
    }))
    expect(info).not.toHaveBeenCalled()
  })

  it('does not expose the DSH Runtime internal connector in MCP management', async () => {
    const { wrapper, content } = await render(true, '/connectors')
    content.connectors.push({
      id: 'connector-dsh-workspace', name: 'DSH Runtime 内置工具连接器', system: 'DSH Runtime',
      status: 'healthy', toolCount: 4, protocol: 'runtime', endpoint: 'dsh://workspace',
      authType: 'Runtime Manifest + Sandbox', credentialRef: '无独立凭据',
      scopeDescription: '当前 Run 工作区', latency: '0 ms', lastCheckedAt: '刚刚',
    }, offlinePendingMcp())
    await flushPromises()

    expect(wrapper.text()).toContain('离线待审核 MCP')
    expect(wrapper.text()).not.toContain('DSH Runtime 内置工具连接器')
    expect(wrapper.findAll('.el-table__row')).toHaveLength(1)
  })

  it('groups dependency Skills under their installation entry', async () => {
    const { wrapper, content } = await render()
    const root = {
      ...strictDraftSkill(),
      id: 'skill-grill-me',
      name: 'grill-me',
      installationRole: 'root' as const,
      dependencies: [{ id: 'skill-grilling', name: 'grilling', version: '0.1.0', status: 'published' as const, depth: 1 }],
    }
    const dependency = {
      ...strictDraftSkill(),
      id: 'skill-grilling',
      name: 'grilling',
      status: 'published' as const,
      installationRole: 'dependency' as const,
    }
    content.skills.splice(0, content.skills.length, root, dependency)
    await flushPromises()

    expect(wrapper.get('#capability-tab-skills').text()).toContain('Skill 列表 1')
    expect(wrapper.findAll('[data-action="view-skill"]')).toHaveLength(1)
    expect(wrapper.get('.skill-primary-cell').text()).toContain('入口 Skill')
    expect(wrapper.get('.skill-dependencies').text()).toContain('依赖 1')
    expect(wrapper.get('.skill-dependency-chip').text()).toContain('grilling')

    await wrapper.get('.skill-dependency-chip').trigger('click')
    await flushPromises()
    expect(wrapper.get('.el-drawer').text()).toContain('依赖 Skill（员工端不单独展示）')
  })

  it('opens a progress dialog immediately and polls the real strict test run', async () => {
    const { wrapper, content } = await render()
    const skill = strictDraftSkill()
    content.skills.push(skill)
    await flushPromises()
    let resolveStart!: (value: import('../types/domain').SkillTestRunProgress) => void
    vi.spyOn(content, 'startSkillTestRun').mockReturnValue(new Promise(resolve => { resolveStart = resolve }))
    const getProgress = vi.spyOn(content, 'getSkillTestRun').mockResolvedValue({
      runId: 'run-strict-1', skillId: skill.id, version: skill.version, status: 'passed', resultSummary: '这是一段不应直接展示的 DSH 详细回复。', testedAt: '2026-09-13T15:01:00.000Z',
      steps: [
        { id: `activation:${skill.id}`, title: '激活根 Skill', description: '已验证锁定内容', status: 'completed' },
        { id: 'result', title: '核验发布条件', description: '这是一段不应在进度步骤中展示的 DSH 完整业务回复。', status: 'completed' },
      ],
    })
    await wrapper.get('[data-action="publish-skill"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('.skill-test-dialog').text()).toContain('正在创建 DSH 严格试运行')
    expect(wrapper.find('[data-testid="skill-action-feedback"]').exists()).toBe(false)

    vi.useFakeTimers()
    resolveStart({
      runId: 'run-strict-1', skillId: skill.id, version: skill.version, status: 'running',
      steps: [{ id: 'activation', title: '激活根 Skill', description: '等待 DSH 调用 activate_skill', status: 'running' }],
    })
    await flushPromises()
    expect(wrapper.get('.skill-test-dialog').text()).toContain('Run run-strict-1')
    expect(wrapper.get('.skill-test-dialog').text()).toContain('激活根 Skill')

    await vi.advanceTimersByTimeAsync(1000)
    await flushPromises()
    expect(getProgress).toHaveBeenCalledWith(skill.id, 'run-strict-1')
    expect(wrapper.get('.skill-test-dialog').text()).toContain('试运行通过')
    expect(wrapper.get('.skill-test-dialog__result').text()).toContain('可以发布')
    expect(wrapper.get('.skill-test-dialog__result').text()).toContain('1 个 Skill 已验证，DSH 已返回有效结果')
    expect(wrapper.get('.skill-test-dialog').text()).not.toContain('不应直接展示的 DSH 详细回复')
    expect(wrapper.get('.skill-test-dialog').text()).not.toContain('不应在进度步骤中展示的 DSH 完整业务回复')
    expect(wrapper.get('.skill-test-progress').text()).toContain('全部发布条件均已通过')
    expect(wrapper.get('[data-testid="skill-action-feedback"]').text()).toContain('请在试运行窗口确认结果后发布')
  })

  it('publishes only after the administrator confirms the completed result', async () => {
    const { wrapper, content } = await render()
    const skill = strictDraftSkill()
    content.skills.push(skill)
    await flushPromises()
    vi.spyOn(content, 'startSkillTestRun').mockResolvedValue({
      runId: 'run-strict-2', skillId: skill.id, version: skill.version, status: 'passed', resultSummary: '根 Skill 与依赖均已激活。', testedAt: '2026-09-13T15:01:00.000Z',
      steps: [{ id: 'result', title: '生成并核验试运行结果', description: '全部门禁通过', status: 'completed' }],
    })
    const publish = vi.spyOn(content, 'setSkillStatus').mockResolvedValue({ ...skill, status: 'published', activeVersion: skill.version })
    await wrapper.get('[data-action="publish-skill"]').trigger('click')
    await flushPromises()

    expect(publish).not.toHaveBeenCalled()
    const publishButton = wrapper.findAll('button').find(button => button.text() === '确认结果并发布')
    expect(publishButton).toBeDefined()
    await publishButton!.trigger('click')
    await flushPromises()
    expect(publish).toHaveBeenCalledWith(skill.id, 'published')
    expect(wrapper.get('.skill-test-dialog').text()).toContain('Skill 已发布')
    expect(wrapper.get('[data-testid="skill-action-feedback"]').text()).toContain('Skill 已发布')
  })
})
