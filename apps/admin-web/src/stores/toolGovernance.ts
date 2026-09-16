import { ref } from 'vue'
import { defineStore } from 'pinia'

import type { AgentDefinition, AgentVersionRecord, ToolDefinition } from '../types/domain'
import type { EvidenceRef } from './agentGovernance'

/**
 * 工具治理叠加原型 store：候选、测试准入、绑定修订与证据
 * 作为本地内存数据叠加在 content store 的真实 Tool 数据上。
 * 不连接任何服务端接口；接真实 API 时替换为 /api/admin/v1/tool-candidates 接口族。
 */

export type ToolExecutorType = 'dsh_builtin' | 'interface_wrapper' | 'sandbox_code'

export interface ToolBindingRevision {
  id: string
  endpoint: string
  executor: string
  credentialSlot: string
  filterPolicy: string
  sealedAt: string
}

export type ToolCandidateStatus = 'draft' | 'admitted' | 'verified'

export interface ToolCandidate {
  id: string
  name: string
  sourceVersion: string
  /** 随 Agent 包提交时记录来源；管理员独立接入为空。 */
  sourceAgent?: { agentId: string; agentName: string }
  executorType: ToolExecutorType
  status: ToolCandidateStatus
  admission?: {
    environment: string
    identity: string
    quota: number
    expiresAt: string
    basis: string
  }
  binding?: ToolBindingRevision
  schemaSummary: string
  lastEvent: string
  blockedReason?: string
}

export interface ToolGovernance {
  bindingRevision: ToolBindingRevision
  evidence: EvidenceRef[]
  revoked: boolean
}

const delay = (ms = 420) => new Promise(resolve => setTimeout(resolve, ms))
const now = () => new Date().toISOString()
let bindingCounter = 5
const nextBindingId = () => `binding-rev-${(bindingCounter += 1)}`

function seedCandidates(): ToolCandidate[] {
  return [
    {
      id: 'query-orders-api',
      name: '订单查询接口封装',
      sourceVersion: '1.0.0',
      sourceAgent: { agentId: 'operations-analyst', agentName: '经营分析助手' },
      executorType: 'interface_wrapper',
      status: 'admitted',
      admission: {
        environment: 'dev-isolated',
        identity: 'test-orders-reader',
        quota: 50,
        expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
        basis: '只读订单接口，过滤规则已批准',
      },
      binding: {
        id: 'binding-rev-4',
        endpoint: 'https://orders.internal.example.com/api/v1',
        executor: 'connector.orders.read',
        credentialSlot: 'cred-orders-readonly',
        filterPolicy: 'order.region ∈ caller.regions',
        sealedAt: '2026-09-14T05:00:00.000Z',
      },
      schemaSummary: 'query(period, region) → { orders[] }',
      lastEvent: '2026-09-15 测试准入签发',
    },
    {
      id: 'reconcile-script',
      name: '对账沙箱脚本',
      sourceVersion: '0.1.0',
      sourceAgent: { agentId: 'operations-analyst', agentName: '经营分析助手' },
      executorType: 'sandbox_code',
      status: 'draft',
      schemaSummary: 'handler(records) → { diffs[] }（handler.py）',
      lastEvent: '2026-09-15 随包解析为候选，等待测试准入',
    },
    {
      id: 'erp-write',
      name: 'ERP 写入操作',
      sourceVersion: '0.1.0',
      executorType: 'interface_wrapper',
      status: 'draft',
      blockedReason: '首版仅允许只读操作',
      schemaSummary: 'write(doc) → { id }（首版不支持写操作）',
      lastEvent: '2026-09-12 提交被暂缓：首版仅允许只读操作',
    },
  ]
}

function seedGovernance(): Record<string, ToolGovernance> {
  const builtIn = (endpoint: string, executor: string, runId: string): ToolGovernance => ({
    bindingRevision: {
      id: 'binding-rev-3',
      endpoint,
      executor,
      credentialSlot: '—（平台内置）',
      filterPolicy: '按调用者权限与数据范围过滤',
      sealedAt: '2026-08-01T02:00:00.000Z',
    },
    evidence: [
      { kind: 'configuration_checked', summary: 'Schema、权限与绑定检查通过', at: '2026-08-01T02:00:00.000Z', by: 'platform', scope: 'tool-catalog' },
      { kind: 'runtime_verified', summary: 'DSH 链路验证通过', runId, at: '2026-08-01T02:10:00.000Z', by: 'platform', scope: 'dev-isolated' },
    ],
    revoked: false,
  })
  return {
    'knowledge.search': builtIn('internal://connector-knowledge', 'platform.knowledge.search', 'run-tool-verify-101'),
    'erp.get_sales_order': builtIn('internal://connector-erp', 'connector.erp.sales_order', 'run-tool-verify-102'),
    'mes.get_work_order_progress': builtIn('internal://connector-mes', 'connector.mes.work_order', 'run-tool-verify-103'),
    'wms.get_material_inventory': builtIn('internal://connector-wms', 'connector.wms.inventory', 'run-tool-verify-104'),
    'artifact.publish': builtIn('internal://artifact-service', 'platform.artifact.publish', 'run-tool-verify-105'),
  }
}

const defaultBinding = (toolId: string): ToolBindingRevision => ({
  id: 'binding-rev-3',
  endpoint: `internal://platform/${toolId}`,
  executor: 'platform.executor',
  credentialSlot: '—（平台内置）',
  filterPolicy: '按调用者权限过滤',
  sealedAt: '—',
})

export const useToolGovernanceStore = defineStore('tool-governance-proto', () => {
  const candidates = ref<ToolCandidate[]>(seedCandidates())
  const governance = ref<Record<string, ToolGovernance>>(seedGovernance())
  /** 候选发布后并入工具列表的原型记录；真实数据仍来自 content store。 */
  const publishedFromCandidates = ref<ToolDefinition[]>([])
  const busy = ref('')

  /** Agent 试运行检查用：候选状态、已发布，或 undefined（未知标识）。 */
  function candidateStatusOf(toolId: string): ToolCandidateStatus | 'published' | undefined {
    const candidate = candidates.value.find(item => item.id === toolId)
    if (candidate) return candidate.status
    if (governance.value[toolId] || publishedFromCandidates.value.some(item => item.id === toolId)) {
      return 'published'
    }
    return undefined
  }

  function governanceOf(toolId: string): ToolGovernance {
    return governance.value[toolId] ?? {
      bindingRevision: defaultBinding(toolId),
      evidence: [],
      revoked: false,
    }
  }

  /** 登记工具候选：管理员独立接入或 Agent 包随包提交（silent 幂等登记）。 */
  async function registerCandidate(input: {
    id: string
    name: string
    executorType: ToolExecutorType
    schemaSummary: string
    sourceAgent?: { agentId: string; agentName: string }
    sourceVersion?: string
    silent?: boolean
  }) {
    const exists = candidates.value.some(item => item.id === input.id) || Boolean(governance.value[input.id])
    if (exists) {
      if (input.silent) return
      throw new Error(`工具标识已存在：${input.id}`)
    }
    if (!input.silent) busy.value = 'register'
    if (!input.silent) await delay()
    candidates.value.unshift({
      id: input.id,
      name: input.name,
      sourceVersion: input.sourceVersion ?? '1.0.0',
      ...(input.sourceAgent ? { sourceAgent: input.sourceAgent } : {}),
      executorType: input.executorType,
      status: 'draft',
      schemaSummary: input.schemaSummary || '（待补充 Schema）',
      lastEvent: input.sourceAgent
        ? `${now().slice(0, 10)} 随包解析为候选，等待测试准入`
        : `${now().slice(0, 10)} 管理员独立接入为候选`,
    })
    if (!input.silent) busy.value = ''
  }

  /** 签发测试准入：仅允许指定候选版本/绑定/身份/环境试运行。 */
  async function admitCandidate(id: string) {
    const candidate = candidates.value.find(item => item.id === id)
    if (!candidate || candidate.status !== 'draft') throw new Error('只有候选草稿可以签发测试准入')
    if (candidate.blockedReason) throw new Error(`候选被暂缓：${candidate.blockedReason}`)
    busy.value = 'admit'
    await delay()
    candidate.admission = {
      environment: 'dev-isolated',
      identity: 'test-runner',
      quota: 30,
      expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
      basis: '管理员批准的隔离测试条件',
    }
    candidate.binding ??= {
      id: nextBindingId(),
      endpoint: `internal://candidates/${id}`,
      executor: `candidate.${id}`,
      credentialSlot: '—（待绑定凭据）',
      filterPolicy: '按调用者权限与数据范围过滤',
      sealedAt: now(),
    }
    candidate.status = 'admitted'
    candidate.lastEvent = `${now().slice(0, 10)} 签发测试准入`
    busy.value = ''
  }

  /** DSH 链路验证（原型模拟：准入有效则通过）。 */
  async function verifyCandidate(id: string) {
    const candidate = candidates.value.find(item => item.id === id)
    if (!candidate?.admission) throw new Error('缺少有效测试准入，不能执行')
    if (new Date(candidate.admission.expiresAt).getTime() < Date.now()) throw new Error('测试准入已过期')
    busy.value = 'verify'
    await delay(800)
    candidate.status = 'verified'
    candidate.lastEvent = `${now().slice(0, 10)} 经 DSH 链路验证通过（Schema/过滤/超时/取消/隔离）`
    busy.value = ''
  }

  async function publishCandidate(id: string) {
    const candidate = candidates.value.find(item => item.id === id)
    if (!candidate || candidate.status !== 'verified') throw new Error('只有已验证候选可以发布')
    busy.value = 'publish'
    await delay()
    governance.value = {
      ...governance.value,
      [id]: {
        bindingRevision: candidate.binding ?? defaultBinding(id),
        revoked: false,
        evidence: [
          { kind: 'configuration_checked', summary: '候选 Schema 与绑定检查通过', at: now(), by: 'platform', scope: `tool-candidate-${id}` },
          { kind: 'runtime_verified', summary: 'DSH 链路验证通过', at: now(), by: 'platform', scope: candidate.admission?.environment ?? 'dev-isolated' },
        ],
      },
    }
    publishedFromCandidates.value.push({
      id: candidate.id,
      version: candidate.sourceVersion,
      name: candidate.name,
      system: '原型候选',
      description: candidate.schemaSummary,
      connectorId: '',
      risk: 'low',
      mode: 'read',
      status: 'available',
      inputSchema: candidate.schemaSummary,
      outputSchema: '{}',
      timeoutSeconds: 30,
      allowedRoles: ['试点员工'],
      dataScopes: ['workspace:authorized'],
      approvalPolicy: 'none',
      lastCheckedAt: '刚刚',
    })
    candidates.value = candidates.value.filter(item => item.id !== id)
    busy.value = ''
  }

  async function revokeTool(id: string) {
    busy.value = 'revoke'
    await delay()
    const current = governance.value[id] ?? governanceOf(id)
    governance.value = { ...governance.value, [id]: { ...current, revoked: true } }
    busy.value = ''
  }

  /** 真实派生引用方：所有 tools 数组含该 toolId（按 @ 前的 id 比较）的 Agent 及版本号。 */
  function referencesOf(toolId: string, agents: AgentDefinition[], versions: AgentVersionRecord[]) {
    const refId = (reference: string) => {
      const separator = reference.lastIndexOf('@')
      return separator > 0 ? reference.slice(0, separator) : reference
    }
    const matches = (references: string[]) => references.some(reference => refId(reference) === toolId)
    return agents.flatMap((agent) => {
      const matched = versions
        .filter(version => version.agentId === agent.id && matches(version.tools))
        .map(version => version.version)
      if (matches(agent.tools) && !matched.includes(agent.version)) matched.unshift(agent.version)
      return matched.length ? [{ agentId: agent.id, agentName: agent.name, versions: matched }] : []
    })
  }

  return {
    candidates,
    governance,
    publishedFromCandidates,
    busy,
    candidateStatusOf,
    governanceOf,
    registerCandidate,
    admitCandidate,
    verifyCandidate,
    publishCandidate,
    revokeTool,
    referencesOf,
  }
})
