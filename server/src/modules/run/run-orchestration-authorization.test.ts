import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { PostgresAuthorizationService } from '../authorization/postgres-authorization-service.ts'
import { authorizationDenied } from '../authorization/authorization-errors.ts'
import type { RuntimeManifest } from '../runtime/runtime-types.ts'
import type { AgentRuntimePort } from '../runtime/runtime-types.ts'
import type { ModelGovernanceService } from '../model/model-governance-service.ts'
import type { PostgresConversationRepository } from '../workbench/application/postgres-conversation-repository.ts'
import { RunOrchestrationService } from './run-orchestration-service.ts'
import type { RunRepository } from './run-repository.ts'

/**
 * assertCurrentRunAuthorization 的 purpose 分流回归：
 * - purpose='automation' 是绑定工作空间的员工 Run（workbench 受众会话），
 *   不得走 admin 会话门禁——否则真实 DSH 链路上的每次执行都会在
 *   verifyExecutionAuthorization 被 AUTHORIZATION_REVOKED。
 * - purpose='agent-release-trial' 是管理侧目的（admin 受众会话），
 *   不得落入「缺少固定工作空间」的通用分支。
 */
const baseRun = {
  id: 'run-1', sessionId: 'sess-1', requestedBy: 'u-owner', status: 'running',
  currentAttemptId: 'attempt-1',
}

function orchestration(overrides: {
  requireSession?: (sessionId: string, userId: string, audience: string) => Promise<unknown>
  sessionRow?: Record<string, unknown> | null
  workspaceType?: 'personal' | 'team' | null
  platformAdminCalls?: { count: number }
  adminReaderCalls?: { count: number }
  authorizeRuntimeCalls?: { count: number }
  teamExecutionCalls?: { count: number }
}) {
  const decision = {
    userId: 'u-owner', workspaceId: 'ws-1', roleIds: [], permissions: [],
    dataScopes: ['scope:one'], agentVersionId: 'agent-v1',
  }
  const runs = {
    async getRun() { return { ...baseRun } },
  }
  const conversations = {
    async findSessionRow() { return overrides.sessionRow ?? null },
    async requireSession(sessionId: string, userId: string, audience: string) {
      if (overrides.requireSession) return overrides.requireSession(sessionId, userId, audience)
      throw authorizationDenied('admin session required')
    },
  }
  const authorization = {
    async workspaceTypeOf() { return overrides.workspaceType ?? 'personal' },
    async authorizeRuntime() { if (overrides.authorizeRuntimeCalls) overrides.authorizeRuntimeCalls.count += 1; return decision },
    async authorizeTeamRunExecution() { if (overrides.teamExecutionCalls) overrides.teamExecutionCalls.count += 1; return decision },
    async requireAdminReader() { if (overrides.adminReaderCalls) overrides.adminReaderCalls.count += 1; return { id: 'u-owner' } },
    async requirePlatformAdmin() { if (overrides.platformAdminCalls) overrides.platformAdminCalls.count += 1; return { id: 'u-owner' } },
  }
  const service = new RunOrchestrationService(
    runs as unknown as RunRepository,
    conversations as unknown as PostgresConversationRepository,
    {} as ModelGovernanceService,
    {} as AgentRuntimePort,
    undefined, undefined, undefined, undefined,
    authorization as unknown as PostgresAuthorizationService,
  )
  return service
}

const automationManifest = {
  purpose: 'automation',
  run_id: 'run-1', attempt_id: 'attempt-1', session_id: 'sess-1',
  workspace_id: 'ws-1', agent_version_id: 'agent-v1',
  user_context: { user_id: 'u-owner', tenant_id: 'tenant-dsh-work', role_ids: [] },
  skills: [], data_scopes: ['scope:one'],
  input: { message: 'synthetic', file_mounts: [] },
} as unknown as RuntimeManifest

const trialManifest = {
  purpose: 'agent-release-trial',
  run_id: 'run-1', attempt_id: 'attempt-1', session_id: 'admin-sess-1',
  workspace_id: '', agent_version_id: 'draft-v1',
  user_context: { user_id: 'u-owner', tenant_id: 'tenant-dsh-work', role_ids: [] },
  skills: [], data_scopes: [],
  input: { message: 'synthetic', file_mounts: [] },
} as unknown as RuntimeManifest

test('automation manifest passes the workbench session gate, never the admin gate', async () => {
  let adminSessionQueries = 0
  const service = orchestration({
    sessionRow: {
      id: 'sess-1', workspaceId: 'ws-1', workspaceType: 'personal',
      createdBy: 'u-owner', agentVersionId: 'agent-v1',
    },
    workspaceType: 'personal',
    requireSession: async () => { adminSessionQueries += 1; throw authorizationDenied('must not reach admin session gate') },
  })
  await service.assertCurrentRunAuthorization(automationManifest)
  assert.equal(adminSessionQueries, 0)
})

test('automation manifest in a team workspace passes via member execution check', async () => {
  const teamExecutionCalls = { count: 0 }
  const service = orchestration({
    sessionRow: {
      id: 'sess-1', workspaceId: 'ws-team', workspaceType: 'team',
      createdBy: 'u-owner', agentVersionId: 'agent-v1',
    },
    workspaceType: 'team',
    teamExecutionCalls,
    requireSession: async () => { throw authorizationDenied('must not reach admin session gate') },
  })
  const manifest = { ...automationManifest, workspace_id: 'ws-team' } as RuntimeManifest
  await service.assertCurrentRunAuthorization(manifest)
  assert.equal(teamExecutionCalls.count, 1)
})

test('agent-release-trial manifest passes via admin session and platform-admin checks', async () => {
  const platformAdminCalls = { count: 0 }
  const service = orchestration({
    platformAdminCalls,
    requireSession: async (_sessionId, _userId, audience) => {
      assert.equal(audience, 'admin')
      return { id: 'admin-sess-1' }
    },
  })
  await service.assertCurrentRunAuthorization(trialManifest)
  assert.equal(platformAdminCalls.count, 1)
})
