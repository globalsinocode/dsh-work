/** Real DSH discovery against the disposable loopback MCP; no business database is used. */
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { startPf07McpFixture } from './pf07-mcp-fixture.mjs'
import { DshAcpRuntimeAdapter } from '../../server/src/modules/runtime/dsh-acp-runtime-adapter.ts'
import { preflightDshRuntime, resolveDshRuntimeInstallation } from '../../server/src/modules/runtime/dsh-runtime-installation.ts'
import type { RuntimeManifest } from '../../server/src/modules/runtime/runtime-types.ts'

const projectRoot = resolve(import.meta.dirname, '../..')
const installation = await resolveDshRuntimeInstallation({ projectRoot })
await preflightDshRuntime(installation)
const token = randomBytes(32).toString('hex')
const directory = await mkdtemp(resolve(tmpdir(), 'pf07-mcp-dsh-'))
const fixture = await startPf07McpFixture({ token })
const connection = {
  snapshot: {
    connector_id: 'pf07-disposable-fixture',
    server_name: 'pf07_fixture',
    transport: 'streamable-http' as const,
    endpoint: fixture.url,
    auth_type: 'bearer' as const,
    capability_digest: '0'.repeat(64),
  },
  headers: { Authorization: `Bearer ${token}` },
  capabilities: undefined as Awaited<ReturnType<DshAcpRuntimeAdapter['inspectMcpConnection']>>['capabilities'] | undefined,
}
const invocations: Array<{ capabilityName: string; result: string }> = []
const runtime = new DshAcpRuntimeAdapter({
  runtimeId: 'pf07-disposable-dsh',
  runtimeRoot: resolve(directory, 'attempts'),
  dshRepository: installation.home,
  runtimeVersion: installation.version,
  runtimeCommit: installation.commit,
  protocolVersion: installation.protocolVersion,
  launchMode: installation.launchMode,
  process: installation.process,
  permissionDecision: async () => 'allow_once',
  resolveMcpConnections: async () => [connection],
  recordMcpInvocation: async (_manifest, invocation) => {
    invocations.push({ capabilityName: invocation.capabilityName, result: invocation.result })
  },
})

try {
  const result = await runtime.inspectMcpConnection(connection)
  assert.deepEqual(result.capabilities.map(item => item.name).sort(), ['get_receipt', 'put_receipt', 'unknown_after_commit'])
  connection.snapshot.capability_digest = createHash('sha256').update(JSON.stringify(result.capabilities)).digest('hex')
  connection.capabilities = result.capabilities
  const nonce = randomUUID().slice(0, 8)
  const runId = `run-pf07-${nonce}`
  const attemptId = `attempt-pf07-${nonce}`
  const taskId = `task-pf07-${nonce}`
  const operationKey = `pf07-${nonce}`
  const manifest: RuntimeManifest = {
    manifest_version: '1.0', run_id: runId, attempt_id: attemptId, task_id: taskId,
    session_id: `session-pf07-${nonce}`, workspace_id: 'workspace-pf07-disposable',
    agent_version_id: 'agent-pf07-disposable',
    agent_configuration: { system_prompt: '你是受控测试助手。只按本次明确要求调用本地一次性 MCP 工具，并核对回执。', skill_instructions: [] },
    user_context: { user_id: 'user-pf07-disposable', tenant_id: 'tenant-pf07-disposable', role_ids: ['role-employee'] },
    permission_policy: { approval_mode: 'always', network_policy: 'allowlist', write_policy: 'approved_targets' },
    skills: [], tools: [], mcp_connections: [connection.snapshot], data_scopes: [], knowledge_context: [],
    input: {
      message: `请调用 mcp__pf07_fixture__put_receipt，参数严格为 operationKey="${operationKey}"、value="disposable-write"；然后调用 mcp__pf07_fixture__get_receipt 查询同一 operationKey，最后只报告查询返回的 receipt id。`,
      file_mounts: [],
    },
    budget: {
      scope_task_id: taskId,
      cumulative_limits: { max_duration_ms: null, max_tool_calls: null, max_output_bytes: null },
      reservation: { duration_ms: 180_000, tool_calls: 8, output_bytes: 64 * 1024 },
      enforcement: { duration: 'hard', tool_calls: 'hard', output_bytes: 'hard', tokens: 'unsupported', cost: 'unsupported' },
    },
    limits: { timeout_seconds: 180, max_output_bytes: 64 * 1024, max_tool_calls: 8 },
    created_at: new Date().toISOString(),
  }
  const handle = await runtime.execute(manifest)
  const finished = await handle.done
  assert.equal(finished.status, 'completed', `DSH Attempt failed: ${finished.status}`)
  const receipt = fixture.getReceipt(operationKey)
  assert.equal(receipt?.status, 'completed')
  assert.ok(invocations.some(item => item.capabilityName === 'put_receipt' && item.result === 'success'))
  assert.ok(invocations.some(item => item.capabilityName === 'get_receipt' && item.result === 'success'))
  console.log(JSON.stringify({
    status: 'passed',
    scope: 'real-dsh-adapter-mcp-discovery-and-invocation',
    runtimeVersion: installation.version,
    runtimeCommit: installation.commit,
    capabilityNames: result.capabilities.map(item => item.name).sort(),
    runId, attemptId, receiptId: receipt.id, invocations,
  }))
} finally {
  await runtime.close()
  await fixture.close()
  await rm(directory, { recursive: true, force: true })
}
