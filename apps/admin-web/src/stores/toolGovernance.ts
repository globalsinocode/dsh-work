import { ref } from 'vue'
import { defineStore } from 'pinia'

import { adminApi } from '../api/client'
import type { AgentDefinition, AgentVersionRecord, ToolBindingRecord, ToolDefinition } from '../types/domain'
import type { EvidenceRef } from './agentGovernance'

/**
 * 工具治理叠加原型 store：候选与测试准入作为本地内存数据叠加在 content
 * store 的真实 Tool 数据上（接真实 API 时替换为 tool-candidates 接口族）。
 * 绑定修订是真实服务端数据：loadBindings 读取 /tools/bindings 的平台
 * 修订记录，不再使用伪造的 binding-rev-N 占位。
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
// 候选测试准入是开发原型流程：其标识带 candidate- 前缀，不会与平台真实
// 绑定修订（tool-binding-*）混淆。
const nextBindingId = () => `candidate-bind-${(bindingCounter += 1)}`

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
        id: 'candidate-bind-4',
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
  // 内置工具的证据与绑定不再预置伪造值：绑定由 loadBindings 从服务端加载，
  // 证据为空的工具显示「暂无运行证据」。
  return {}
}

/** 服务端绑定修订 → 视图形态；不展示密钥值，只展示凭据槽位引用与策略标签。 */
function toBindingRevision(record: ToolBindingRecord): ToolBindingRevision {
  return {
    id: `${record.bindingId} rev${record.revision}`,
    endpoint: record.endpoint,
    executor: record.executor,
    credentialSlot: record.credentialRef ?? '—（无凭据槽位）',
    filterPolicy: `${record.identityPolicy} · ${record.environment}`,
    sealedAt: record.sealedAt,
  }
}

const pendingBinding = (): ToolBindingRevision => ({
  id: '—',
  endpoint: '—',
  executor: '—',
  credentialSlot: '—',
  filterPolicy: '尚未解析平台绑定',
  sealedAt: '—',
})

export const useToolGovernanceStore = defineStore('tool-governance-proto', () => {
  const candidates = ref<ToolCandidate[]>(seedCandidates())
  const governance = ref<Record<string, ToolGovernance>>(seedGovernance())
  /** 服务端真实绑定修订（key = 工具 id）；active 之外的状态标记为 revoked。 */
  const serverBindings = ref<Record<string, { revision: ToolBindingRevision; revoked: boolean }>>({})
  /** 绑定接口加载失败的可观察信号；为 '' 表示未发生或已恢复。 */
  const bindingsError = ref('')
  /** 候选发布后并入工具列表的原型记录；真实数据仍来自 content store。 */
  const publishedFromCandidates = ref<ToolDefinition[]>([])
  const busy = ref('')

  /** 加载平台绑定修订：每个工具取最新修订（active 优先，其次最大 revision）。 */
  async function loadBindings() {
    bindingsError.value = ''
    try {
      const { items } = await adminApi.getToolBindings()
      const latest = new Map<string, ToolBindingRecord>()
      for (const record of items) {
        const toolId = record.tool.split('@')[0] ?? record.tool
        const current = latest.get(toolId)
        if (!current
          || (current.status !== 'active' && record.status === 'active')
          || (current.status === record.status && record.revision > current.revision)) {
          latest.set(toolId, record)
        }
      }
      const mapped: Record<string, { revision: ToolBindingRevision; revoked: boolean }> = {}
      for (const [toolId, record] of latest) {
        mapped[toolId] = { revision: toBindingRevision(record), revoked: record.status !== 'active' }
      }
      serverBindings.value = mapped
    } catch (error) {
      // 不把接口失败静默成「尚未解析绑定」：保留可观察错误信号供视图提示。
      serverBindings.value = {}
      bindingsError.value = error instanceof Error ? error.message : String(error)
    }
  }

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
    const server = serverBindings.value[toolId]
    if (server) return { bindingRevision: server.revision, evidence: governance.value[toolId]?.evidence ?? [], revoked: server.revoked }
    return governance.value[toolId] ?? {
      bindingRevision: pendingBinding(),
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
        bindingRevision: candidate.binding ?? pendingBinding(),
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
    serverBindings,
    bindingsError,
    publishedFromCandidates,
    busy,
    loadBindings,
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
