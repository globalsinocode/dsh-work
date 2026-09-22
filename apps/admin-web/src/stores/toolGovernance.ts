import { ref } from 'vue'
import { defineStore } from 'pinia'

import { adminApi } from '../api/client'
import type { AgentDefinition, AgentVersionRecord, ToolBindingRecord } from '../types/domain'

export interface ToolBindingRevision {
  id: string
  endpoint: string
  executor: string
  credentialSlot: string
  filterPolicy: string
  sealedAt: string
}

export interface ToolGovernance {
  bindingRevision: ToolBindingRevision
  revoked: boolean
}

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

/** DSH 内置工具治理视图；候选接入由专用准入流程负责，不在此 store 模拟。 */
export const useToolGovernanceStore = defineStore('tool-governance', () => {
  const serverBindings = ref<Record<string, ToolGovernance>>({})
  const bindingsError = ref('')

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
      const mapped: Record<string, ToolGovernance> = {}
      for (const [toolId, record] of latest) {
        mapped[toolId] = { bindingRevision: toBindingRevision(record), revoked: record.status !== 'active' }
      }
      serverBindings.value = mapped
    } catch (error) {
      serverBindings.value = {}
      bindingsError.value = error instanceof Error ? error.message : String(error)
    }
  }

  function governanceOf(toolId: string): ToolGovernance {
    return serverBindings.value[toolId] ?? { bindingRevision: pendingBinding(), revoked: false }
  }

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

  return { serverBindings, bindingsError, loadBindings, governanceOf, referencesOf }
})
