import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { PostgresAuthorizationService } from '../authorization/postgres-authorization-service.ts'
import type { ModelGovernanceService } from '../model/model-governance-service.ts'
import type { AgentRuntimePort } from '../runtime/runtime-types.ts'
import type { PostgresConversationRepository } from '../workbench/application/postgres-conversation-repository.ts'
import { RunOrchestrationService } from './run-orchestration-service.ts'
import type { RunRepository } from './run-repository.ts'

test('postDiscussionMessage activates draft session after write authorization', async () => {
  const activated: string[] = []
  const sessionRow = {
    id: 'sess-team',
    workspaceId: 'ws-team',
    workspaceType: 'team' as const,
    workspaceStatus: 'active' as const,
    createdBy: 'U00001',
    agentVersionId: 'agent-v1',
  }
  const conversations = {
    async findSessionRow() { return sessionRow },
    async activateSession(sessionId: string) {
      activated.push(sessionId)
      return true
    },
    async appendDiscussionMessage() {
      return { messageId: 'message-discussion-sess-team-abc', created: true }
    },
  }
  const authorization = {
    async requireTeamRole() {},
  }
  const service = new RunOrchestrationService(
    {} as RunRepository,
    conversations as unknown as PostgresConversationRepository,
    {} as ModelGovernanceService,
    {} as AgentRuntimePort,
    undefined, undefined, undefined, undefined,
    authorization as unknown as PostgresAuthorizationService,
  )
  await service.postDiscussionMessage({
    userId: 'U00001',
    sessionId: sessionRow.id,
    content: 'hello team',
    idempotencyKey: 'idem-1',
  })
  assert.deepEqual(activated, [sessionRow.id])
})

test('postDiscussionMessage does not activate when write authorization fails', async () => {
  let activated = false
  const conversations = {
    async findSessionRow() {
      return {
        id: 'sess-team',
        workspaceId: 'ws-team',
        workspaceType: 'team' as const,
        workspaceStatus: 'active' as const,
        createdBy: 'U00002',
        agentVersionId: 'agent-v1',
      }
    },
    async activateSession() {
      activated = true
      return true
    },
    async appendDiscussionMessage() {
      throw new Error('must not append')
    },
  }
  const service = new RunOrchestrationService(
    {} as RunRepository,
    conversations as unknown as PostgresConversationRepository,
    {} as ModelGovernanceService,
    {} as AgentRuntimePort,
  )
  await assert.rejects(
    () => service.postDiscussionMessage({
      userId: 'U00001',
      sessionId: 'sess-team',
      content: 'blocked',
      idempotencyKey: 'idem-2',
    }),
    (error: unknown) => error instanceof Error && error.message.includes('Session 不存在或不可访问'),
  )
  assert.equal(activated, false)
})
