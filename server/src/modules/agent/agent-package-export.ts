import { zipSync, strToU8 } from 'fflate'
import { stringify } from 'yaml'

import { hash } from '../skill/skill-package.ts'
import { AGENT_EVALUATION_API_VERSION, AGENT_EVALUATION_KIND, parseAgentPackage, type AgentPackageCase } from './agent-package.ts'
import type { AgentSpec } from './agent-spec.ts'

/** Export only the portable definition. Connector IDs, endpoints, credentials and grants stay platform-owned. */
export function exportAgentPackage(spec: AgentSpec, cases: AgentPackageCase[] = []): Uint8Array {
  if (spec.evaluation.cases && !cases.length) throw new Error('已声明评测文件但缺少可导出的案例')
  const files: Record<string, Uint8Array> = {}
  const add = (path: string, body: string) => { files[path] = strToU8(body) }
  const capability = (reference: string) => {
    const at = reference.lastIndexOf('@')
    return { id: reference.slice(0, at), version: reference.slice(at + 1) }
  }
  const collections = spec.data.collections.map(item => {
    if (item.schema) add(item.schema.path, JSON.stringify(item.schema.body, null, 2))
    return {
      key: item.key, scope: item.scope, schemaVersion: item.schemaVersion, actions: item.actions,
      ...(item.schema ? { schema: item.schema.path } : {}),
    }
  })
  const evaluationPath = spec.evaluation.cases
  if (evaluationPath) {
    add(evaluationPath, stringify({
      apiVersion: AGENT_EVALUATION_API_VERSION,
      kind: AGENT_EVALUATION_KIND,
      cases: cases.map(({ name, kind, input, automatedAssertions, manualReview }) =>
        ({ name, kind, input, automatedAssertions, manualReview })),
    }))
  }
  add('agent.yaml', stringify({
    apiVersion: spec.apiVersion, kind: 'AgentPackage', metadata: spec.metadata,
    spec: {
      instructions: 'SOUL.md',
      ...(spec.workProcedures ? { workProcedures: 'AGENTS.md' } : {}),
      capabilities: {
        skills: spec.capabilities.skills.map(capability), tools: spec.capabilities.tools.map(capability),
      },
      input: spec.input, output: spec.output, context: spec.context, catalog: spec.catalog,
      limits: spec.limits,
      ...(evaluationPath ? { evaluation: { cases: evaluationPath } } : {}),
      model: spec.model,
      data: { state: spec.data.state, collections },
    },
  }))
  add('SOUL.md', spec.instructions.body)
  if (spec.workProcedures) add('AGENTS.md', spec.workProcedures.body)
  files['checksums.json'] = strToU8(JSON.stringify({
    files: Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, hash(bytes)])),
  }, null, 2))
  const bytes = zipSync(files, { level: 0 })
  // The same strict parser used at import must accept every exported archive.
  parseAgentPackage(bytes)
  return bytes
}
