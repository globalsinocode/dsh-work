import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { after, before, test } from 'node:test'

import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { PostgresAgentDataService, type AgentDataActor } from '../../modules/agent-data/postgres-agent-data-service.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import { PostgresTaskRepository } from '../../modules/task/postgres-task-repository.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import { compileRuntimeManifest } from '../../modules/runtime/manifest-compiler.ts'
import { registerAdminAgentDataRoutes } from '../../http/admin/agent-data-routes.ts'
import { Router } from '../../http/router.ts'
import { prototypeApiAuthenticator } from '../../modules/identity/prototype-authenticator.ts'
import type { RuntimeManifest } from '../../modules/runtime/runtime-types.ts'
import type { JsonObject } from '../../modules/run/run-types.ts'

const tenantId = 'tenant-dsh-work'
const primaryAgentId = 'agent-dsh-work-assistant'
const primaryVersionId = 'agent-version-dsh-work-assistant-1'
let throwaway: ThrowawayDatabase
let database: DatabaseClient
let service: PostgresAgentDataService
let runs: PostgresRunRepository
let tasks: PostgresTaskRepository

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_ae03_data', maxConnections: 6 })
  database = throwaway.client
  service = new PostgresAgentDataService(database)
  runs = new PostgresRunRepository(database)
  tasks = new PostgresTaskRepository(database)
  await database`
    insert into agents (id, tenant_id, name, description, owner_user_id, created_by, status)
    values ('agent-ae03-peer', ${tenantId}, 'AE03 peer', 'Independent data-plane reader', 'U00008', 'U00008', 'published')
  `
  await database`
    insert into agent_versions (id, tenant_id, agent_id, version, system_prompt, status, published_at)
    values ('agent-version-ae03-peer-1', ${tenantId}, 'agent-ae03-peer', '1.0.0', 'Read shared records.', 'published', now())
  `
  await database`
    insert into agent_versions (id, tenant_id, agent_id, version, system_prompt, agent_spec, status, published_at)
    values ('agent-version-ae03-data-1', ${tenantId}, ${primaryAgentId}, '9.9.1',
            'Use governed collection records.', ${database.json({ data: { state: false,
              collections: [{ key: 'runtime_data_records', scope: 'workspace', schemaVersion: 1,
                actions: ['query', 'create'], schema: null }] } })}, 'published', now())
  `
  await database`
    insert into agent_versions
      (id, tenant_id, agent_id, version, system_prompt, visible_role_ids, data_scopes, agent_spec, status, published_at)
    values ('agent-version-ae03-review-1', ${tenantId}, ${primaryAgentId}, '9.9.2',
            'Review governed work records.', ${database.json(['role-employee'])},
            ${database.json(['enterprise:authorized', 'workspace:authorized'])},
            ${database.json({ data: { state: false, collections: [{ key: 'reviewed_work_records',
              scope: 'workspace', schemaVersion: 1, actions: ['propose'], schema: null }] } })},
            'published', now())
  `
  await database`
    insert into agent_versions
      (id, tenant_id, agent_id, version, system_prompt, visible_role_ids, data_scopes, agent_spec, status, published_at)
    values ('agent-version-ae03-multirole-1', ${tenantId}, ${primaryAgentId}, '9.9.3',
            'Review multi-role work records.', ${database.json(['role-employee'])},
            ${database.json(['enterprise:authorized', 'workspace:authorized'])},
            ${database.json({ data: { state: false, collections: [{ key: 'multirole_review_records',
              scope: 'workspace', schemaVersion: 1, actions: ['propose'], schema: null }] } })},
            'published', now())
  `
  await database`
    insert into workspace_capability_grants (tenant_id, workspace_id, capability_type, capability_version_id)
    values (${tenantId}, 'ws-supply', 'agent', 'agent-version-ae03-review-1'),
           (${tenantId}, 'ws-supply', 'agent', 'agent-version-ae03-multirole-1')
    on conflict do nothing
  `
})

after(async () => { await throwaway.dispose() })

const schema = {
  type: 'object', additionalProperties: false,
  properties: {
    materialCode: { type: 'string' },
    expectedArrivalDate: { type: 'string' },
    status: { type: 'string' },
  },
  required: ['materialCode', 'expectedArrivalDate', 'status'],
}

test('AE-03 shared collection has one generic table, immutable versions, replay safety and current grants', async () => {
  await assert.rejects(service.publishCollection({
    tenantId, key: 'shortage_records', ownerWorkspaceId: 'ws-supply',
    schema, queryFields: ['materialCode'], retentionDays: 30, actorUserId: 'U00001',
  }), (error: unknown) => isCode(error, 'permission_denied'))

  const collectionId = await service.publishCollection({
    tenantId, key: 'shortage_records', ownerWorkspaceId: 'ws-supply',
    schema, queryFields: ['materialCode'], retentionDays: 30, actorUserId: 'U00008',
  })
  await service.setGrant({
    tenantId, collectionId, agentId: primaryAgentId,
    actions: ['create', 'update', 'query'], actorUserId: 'U00008',
  })
  const actor = await runningActor('shared-primary', primaryVersionId, 'ws-supply')
  const initial = {
    materialCode: 'MAT-10086', expectedArrivalDate: '2026-09-25', status: 'supplier_confirmed',
  }
  const created = await service.writeRecord(actor, {
    collectionId, recordKey: 'MAT-10086', data: initial, expectedVersion: 0, operationKey: 'create-shortage',
  })
  assert.equal(created.version, 1)
  assert.deepEqual(await service.writeRecord(actor, {
    collectionId, recordKey: 'MAT-10086', data: initial, expectedVersion: 0, operationKey: 'create-shortage',
  }), created)
  await assert.rejects(service.writeRecord(actor, {
    collectionId, recordKey: 'MAT-10086', data: { ...initial, status: 'changed' },
    expectedVersion: 0, operationKey: 'create-shortage',
  }), (error: unknown) => isCode(error, 'AGENT_DATA_CONFLICT'))
  await assert.rejects(service.writeRecord(actor, {
    collectionId, recordKey: 'MAT-10086', data: { ...initial, unexpected: true },
    expectedVersion: 1, operationKey: 'invalid-schema',
  }), (error: unknown) => isCode(error, 'invalid_request'))
  const updated = await service.writeRecord(actor, {
    collectionId, recordKey: 'MAT-10086', data: { ...initial, status: 'received' },
    expectedVersion: 1, operationKey: 'update-shortage',
  })
  assert.equal(updated.version, 2)
  assert.notEqual(updated.recordVersionId, created.recordVersionId)
  const [firstVersion] = await database<{ data: Record<string, unknown>; attemptId: string }[]>`
    select data_json as data, source_attempt_id as "attemptId" from agent_data_record_versions
     where tenant_id = ${tenantId} and id = ${created.recordVersionId}
  `
  assert.deepEqual(firstVersion?.data, initial)
  assert.equal(firstVersion?.attemptId, actor.attemptId)
  assert.equal((await service.queryRecords(actor, {
    collectionId, field: 'materialCode', equals: 'MAT-10086',
  }))[0]?.recordVersionId, updated.recordVersionId)
  const concurrent = await Promise.allSettled([
    service.writeRecord(actor, {
      collectionId, recordKey: 'MAT-CONCURRENT', data: { ...initial, materialCode: 'MAT-CONCURRENT' },
      expectedVersion: 0, operationKey: 'concurrent-a',
    }),
    service.writeRecord(actor, {
      collectionId, recordKey: 'MAT-CONCURRENT', data: { ...initial, materialCode: 'MAT-CONCURRENT' },
      expectedVersion: 0, operationKey: 'concurrent-b',
    }),
  ])
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(concurrent.filter(result => result.status === 'rejected' && isCode(result.reason, 'AGENT_DATA_CONFLICT')).length, 1)
  await assert.rejects(service.queryRecords(actor, {
    collectionId, field: 'status', equals: 'received',
  }), (error: unknown) => isCode(error, 'permission_denied'))

  const peer = await runningActor('shared-peer', 'agent-version-ae03-peer-1', 'ws-supply')
  await assert.rejects(service.queryRecords(peer, { collectionId }), (error: unknown) => isCode(error, 'permission_denied'))
  await service.setGrant({ tenantId, collectionId, agentId: 'agent-ae03-peer', actions: ['query'], actorUserId: 'U00008' })
  assert.equal((await service.queryRecords(peer, {
    collectionId, field: 'materialCode', equals: 'MAT-10086',
  }))[0]?.recordVersionId, updated.recordVersionId)
  await service.setGrant({ tenantId, collectionId, agentId: 'agent-ae03-peer', actions: [], actorUserId: 'U00008' })
  await assert.rejects(service.queryRecords(peer, { collectionId }), (error: unknown) => isCode(error, 'permission_denied'))
  await assert.rejects(service.queryRecords({ ...actor, workspaceId: 'ws-operations' }, { collectionId }),
    (error: unknown) => isCode(error, 'permission_denied'))
})

test('AE-03 deleting a record preserves body-free operation tombstones against replay', async () => {
  const collectionId = await service.publishCollection({ tenantId, key: 'deleted_replay_records',
    ownerWorkspaceId: 'ws-supply', schema, queryFields: [], retentionDays: 30, actorUserId: 'U00008' })
  await service.setGrant({ tenantId, collectionId, agentId: primaryAgentId,
    actions: ['create', 'transition'], actorUserId: 'U00008' })
  const actor = await runningActor('delete-replay', primaryVersionId, 'ws-supply')
  const data = { materialCode: 'MAT-DELETED', expectedArrivalDate: '2026-09-25', status: 'open' }
  const created = await service.writeRecord(actor, { collectionId, recordKey: 'MAT-DELETED', data,
    expectedVersion: 0, operationKey: 'create-deleted' })
  await service.transitionRecord(actor, { collectionId, recordKey: 'MAT-DELETED',
    expectedVersion: 1, expectedStatus: 'open', nextStatus: 'closed', operationKey: 'transition-deleted' })
  await service.deleteRecord({ tenantId, recordId: created.recordId, actorUserId: 'U00008' })
  await assert.rejects(service.writeRecord(actor, { collectionId, recordKey: 'MAT-DELETED', data,
    expectedVersion: 0, operationKey: 'create-deleted' }),
  (error: unknown) => isCode(error, 'AGENT_DATA_CONFLICT'))
  await assert.rejects(service.transitionRecord(actor, { collectionId, recordKey: 'MAT-DELETED',
    expectedVersion: 1, expectedStatus: 'open', nextStatus: 'closed', operationKey: 'transition-deleted' }),
  (error: unknown) => isCode(error, 'AGENT_DATA_CONFLICT'))
  const [result] = await database<{ records: number; tombstones: number }[]>`
    select (select count(*)::integer from agent_data_records
      where tenant_id = ${tenantId} and collection_id = ${collectionId}) as records,
      (select count(*)::integer from agent_data_record_operations
      where tenant_id = ${tenantId} and source_attempt_id = ${actor.attemptId}
        and record_version_id is null and deleted_at is not null) as tombstones
  `
  assert.equal(result?.records, 0)
  assert.equal(result?.tombstones, 2)
})

test('AE-03 private collection and state stay within their Agent installation', async () => {
  const collectionId = await service.publishCollection({
    tenantId, key: 'private_work_notes', privateAgentId: primaryAgentId,
    schema, queryFields: ['materialCode'], retentionDays: 7, actorUserId: 'U00008',
  })
  await assert.rejects(service.setGrant({
    tenantId, collectionId, agentId: 'agent-ae03-peer', actions: ['query'], actorUserId: 'U00008',
  }), (error: unknown) => isCode(error, 'permission_denied'))
  const actor = await runningActor('private-state', primaryVersionId, 'ws-supply')
  assert.equal(await service.putState(actor, {
    namespace: 'cursor', key: 'last-page', value: { page: 1 }, expectedVersion: 0, ttlSeconds: 3600,
  }), 1)
  assert.deepEqual(await service.getState(actor, 'cursor', 'last-page'), { value: { page: 1 }, version: 1 })
  const [first, second] = await Promise.allSettled([
    service.putState(actor, { namespace: 'cursor', key: 'last-page', value: { page: 2 }, expectedVersion: 1, ttlSeconds: 3600 }),
    service.putState(actor, { namespace: 'cursor', key: 'last-page', value: { page: 3 }, expectedVersion: 1, ttlSeconds: 3600 }),
  ])
  assert.equal([first, second].filter(result => result.status === 'fulfilled').length, 1)
  assert.equal([first, second].filter(result => result.status === 'rejected').length, 1)
  const peer = await runningActor('private-peer', 'agent-version-ae03-peer-1', 'ws-supply')
  assert.equal(await service.getState(peer, 'cursor', 'last-page'), null)
  await database`
    update execution_principals set status = 'disabled'
     where tenant_id = ${tenantId} and id = ${peer.principalId}
  `
  await assert.rejects(service.getState(peer, 'cursor', 'last-page'), (error: unknown) => isCode(error, 'permission_denied'))
  await runs.transitionAttempt(tenantId, actor.attemptId, 'succeeded')
  await runs.transitionRun(tenantId, actor.runId, 'succeeded')
  await assert.rejects(service.getState(actor, 'cursor', 'last-page'), (error: unknown) => isCode(error, 'permission_denied'))
})

test('AE-03 expired state reactivation still observes the 500 live-key limit', async () => {
  const [peerPrincipal] = await database<{ id: string }[]>`
    select id from execution_principals where tenant_id = ${tenantId} and agent_id = 'agent-ae03-peer' and kind = 'agent'
  `
  await database`update execution_principals set status = 'active'
    where tenant_id = ${tenantId} and id = ${peerPrincipal!.id}`
  const actor = await runningActor('state-reactivation-quota', 'agent-version-ae03-peer-1', 'ws-supply')
  const [installation] = await database<{ id: string }[]>`
    select id from agent_installations where tenant_id = ${tenantId} and agent_id = 'agent-ae03-peer'
  `
  assert.ok(installation)
  await service.putState(actor, { namespace: 'reactivation-quota', key: 'expired', value: 1,
    expectedVersion: 0, ttlSeconds: 60 })
  await database`update agent_state set expires_at = now() - interval '1 minute'
    where tenant_id = ${tenantId} and agent_installation_id = ${installation.id}
      and namespace = 'reactivation-quota' and key = 'expired'`
  await database`
    insert into agent_state (tenant_id, agent_installation_id, namespace, key, value_json, version,
                             expires_at, updated_by_principal_id, source_run_id, source_attempt_id)
    select ${tenantId}, ${installation.id}, 'reactivation-quota', 'key-' || n,
           '1'::jsonb, 1, now() + interval '1 day', ${actor.principalId}, ${actor.runId}, ${actor.attemptId}
      from generate_series(1, 500) as n
  `
  await assert.rejects(service.putState(actor, { namespace: 'reactivation-quota', key: 'expired',
    value: 2, expectedVersion: 0, ttlSeconds: 60 }), (error: unknown) => isCode(error, 'invalid_request'))
  const [count] = await database<{ total: number }[]>`
    select count(*)::integer as total from agent_state where tenant_id = ${tenantId}
      and agent_installation_id = ${installation.id} and (expires_at is null or expires_at > now())
  `
  assert.equal(count?.total, 500)
  await database`delete from agent_state where tenant_id = ${tenantId}
    and agent_installation_id = ${installation.id} and namespace = 'reactivation-quota'`
})

test('AE-03 multi-role proposals approve concurrently against one collection', async () => {
  const collectionId = await service.publishCollection({ tenantId, key: 'multirole_review_records',
    ownerWorkspaceId: 'ws-supply', schema, queryFields: ['materialCode'], retentionDays: 30, actorUserId: 'U00008' })
  await service.setGrant({ tenantId, collectionId, agentId: primaryAgentId,
    actions: ['propose'], actorUserId: 'U00008' })
  const actor = await runningActor('multirole-proposal', 'agent-version-ae03-multirole-1',
    'ws-supply', [], ['role-employee', 'role-platform-admin'])
  await database`insert into user_roles (tenant_id, user_id, role_id)
    values (${tenantId}, 'U00001', 'role-platform-admin') on conflict do nothing`
  await database`insert into agent_principal_role_grants (tenant_id, principal_id, role_id)
    values (${tenantId}, ${actor.principalId}, 'role-platform-admin') on conflict do nothing`
  const proposals = await Promise.all([1, 2].map(index => service.proposeRecord(actor, {
    collectionId, recordKey: `MAT-MULTI-${index}`,
    data: { materialCode: `MAT-MULTI-${index}`, expectedArrivalDate: '2026-09-25', status: 'open' },
    expectedVersion: 0, operationKey: `multirole-${index}`,
  })))
  await runs.transitionAttempt(tenantId, actor.attemptId, 'succeeded')
  await runs.transitionRun(tenantId, actor.runId, 'succeeded')
  const reviews = await Promise.allSettled(proposals.map(item => service.reviewProposal({
    tenantId, proposalId: item.proposalId, decision: 'approved', actorUserId: 'U00008',
  })))
  assert.equal(reviews.filter(item => item.status === 'fulfilled').length, 2,
    `Concurrent reviews failed: ${reviews.filter(item => item.status === 'rejected').map(item => String(item.reason)).join('; ')}`)
  const [count] = await database<{ total: number }[]>`
    select count(*)::integer as total from agent_data_records
     where tenant_id = ${tenantId} and collection_id = ${collectionId}
  `
  assert.equal(count?.total, 2)
})

test('AE-03 proposal review, transition, schema evolution and retention preserve governed evidence', async () => {
  const collectionId = await service.publishCollection({ tenantId, key: 'reviewed_work_records',
    ownerWorkspaceId: 'ws-supply', schema, queryFields: ['materialCode'], retentionDays: 7, actorUserId: 'U00008' })
  await service.setGrant({ tenantId, collectionId, agentId: primaryAgentId,
    actions: ['propose', 'transition', 'query'], actorUserId: 'U00008' })
  const actor = await runningActor('proposal-review', 'agent-version-ae03-review-1', 'ws-supply')
  const data = { materialCode: 'MAT-REVIEW', expectedArrivalDate: '2026-09-25', status: 'supplier_confirmed' }
  const proposed = await service.proposeRecord(actor, { collectionId, recordKey: 'MAT-REVIEW', data,
    expectedVersion: 0, operationKey: 'propose-review' })
  assert.deepEqual(await service.proposeRecord(actor, { collectionId, recordKey: 'MAT-REVIEW', data,
    expectedVersion: 0, operationKey: 'propose-review' }), proposed)
  await assert.rejects(service.proposeRecord(actor, { collectionId, recordKey: 'MAT-REVIEW',
    data: { ...data, status: 'changed' }, expectedVersion: 0, operationKey: 'propose-review' }),
  (error: unknown) => isCode(error, 'AGENT_DATA_CONFLICT'))
  await runs.transitionAttempt(tenantId, actor.attemptId, 'succeeded')
  await runs.transitionRun(tenantId, actor.runId, 'succeeded')
  await service.setGrant({ tenantId, collectionId, agentId: primaryAgentId,
    actions: [], actorUserId: 'U00008' })
  await assert.rejects(service.reviewProposal({ tenantId, proposalId: proposed.proposalId,
    decision: 'approved', actorUserId: 'U00008' }), (error: unknown) => isCode(error, 'permission_denied'))
  await service.setGrant({ tenantId, collectionId, agentId: primaryAgentId,
    actions: ['propose', 'transition', 'query'], actorUserId: 'U00008' })
  await database`
    insert into workspace_agent_members
      (id, tenant_id, workspace_id, agent_id, agent_version_id, status, added_by)
    values ('member-ae03-review', ${tenantId}, 'ws-supply', ${primaryAgentId},
            'agent-version-ae03-review-1', 'disabled', 'U00008')
  `
  await assert.rejects(service.reviewProposal({ tenantId, proposalId: proposed.proposalId,
    decision: 'approved', actorUserId: 'U00008' }), (error: unknown) => isCode(error, 'permission_denied'))
  await database`update workspace_agent_members set status = 'available'
     where tenant_id = ${tenantId} and id = 'member-ae03-review'`
  await database`delete from agent_principal_role_grants
     where tenant_id = ${tenantId} and principal_id = ${actor.principalId} and role_id = 'role-employee'`
  await assert.rejects(service.reviewProposal({ tenantId, proposalId: proposed.proposalId,
    decision: 'approved', actorUserId: 'U00008' }), (error: unknown) => isCode(error, 'permission_denied'))
  await database`insert into agent_principal_role_grants (tenant_id, principal_id, role_id)
     values (${tenantId}, ${actor.principalId}, 'role-employee')`
  await database`delete from agent_principal_scope_grants
     where tenant_id = ${tenantId} and principal_id = ${actor.principalId} and scope_value = 'workspace:authorized'`
  await assert.rejects(service.reviewProposal({ tenantId, proposalId: proposed.proposalId,
    decision: 'approved', actorUserId: 'U00008' }), (error: unknown) => isCode(error, 'permission_denied'))
  await database`insert into agent_principal_scope_grants (tenant_id, principal_id, scope_value)
     values (${tenantId}, ${actor.principalId}, 'workspace:authorized')`
  await database`update user_roles set valid_until = now() - interval '1 minute'
     where tenant_id = ${tenantId} and user_id = 'U00001' and role_id = 'role-employee'`
  await assert.rejects(service.reviewProposal({ tenantId, proposalId: proposed.proposalId,
    decision: 'approved', actorUserId: 'U00008' }), (error: unknown) => isCode(error, 'permission_denied'))
  await database`update user_roles set valid_until = null
     where tenant_id = ${tenantId} and user_id = 'U00001' and role_id = 'role-employee'`
  await database`update data_scope_grants set scope_value = 'workspace:revoked-test'
     where tenant_id = ${tenantId} and id = 'grant-role-employee-workspace'`
  await assert.rejects(service.reviewProposal({ tenantId, proposalId: proposed.proposalId,
    decision: 'approved', actorUserId: 'U00008' }), (error: unknown) => isCode(error, 'permission_denied'))
  await database`update data_scope_grants set scope_value = 'workspace:authorized'
     where tenant_id = ${tenantId} and id = 'grant-role-employee-workspace'`
  const reviewed = await service.reviewProposal({ tenantId, proposalId: proposed.proposalId,
    decision: 'approved', actorUserId: 'U00008' })
  assert.ok(reviewed.recordVersionId)
  assert.deepEqual(await service.reviewProposal({ tenantId, proposalId: proposed.proposalId,
    decision: 'approved', actorUserId: 'U00008' }), reviewed)
  await assert.rejects(service.reviewProposal({ tenantId, proposalId: proposed.proposalId,
    decision: 'rejected', actorUserId: 'U00008' }), (error: unknown) => isCode(error, 'AGENT_DATA_CONFLICT'))
  const nextActor = await runningActor('transition-review', primaryVersionId, 'ws-supply')
  const transitioned = await service.transitionRecord(nextActor, { collectionId, recordKey: 'MAT-REVIEW',
    expectedVersion: 1, expectedStatus: 'supplier_confirmed', nextStatus: 'received', operationKey: 'receive' })
  assert.equal(transitioned.version, 2)
  assert.deepEqual(await service.transitionRecord(nextActor, { collectionId, recordKey: 'MAT-REVIEW',
    expectedVersion: 1, expectedStatus: 'supplier_confirmed', nextStatus: 'received', operationKey: 'receive' }), transitioned)
  await assert.rejects(service.transitionRecord(nextActor, { collectionId, recordKey: 'MAT-REVIEW',
    expectedVersion: 1, expectedStatus: 'supplier_confirmed', nextStatus: 'other', operationKey: 'receive' }),
  (error: unknown) => isCode(error, 'AGENT_DATA_CONFLICT'))
  const nextSchema = { ...schema, properties: { ...schema.properties, note: { type: 'string' } } }
  const staleActor = await runningActor('stale-schema-review', 'agent-version-ae03-review-1', 'ws-supply')
  const staleProposal = await service.proposeRecord(staleActor, { collectionId, recordKey: 'MAT-STALE', data,
    expectedVersion: 0, operationKey: 'stale-proposal' })
  await runs.transitionAttempt(tenantId, staleActor.attemptId, 'succeeded')
  await runs.transitionRun(tenantId, staleActor.runId, 'succeeded')
  assert.equal(await service.evolveCollection({ tenantId, collectionId, expectedVersion: 1,
    schema: nextSchema, queryFields: ['materialCode'], actorUserId: 'U00008' }), 2)
  await assert.rejects(service.reviewProposal({ tenantId, proposalId: staleProposal.proposalId,
    decision: 'approved', actorUserId: 'U00008' }), (error: unknown) => isCode(error, 'permission_denied'))
  const [oldSchema] = await database<{ schema: Record<string, unknown> }[]>`
    select schema_json as schema from agent_data_collection_schema_versions
     where tenant_id = ${tenantId} and collection_id = ${collectionId} and version = 1
  `
  assert.deepEqual(oldSchema?.schema, schema)
  await runs.transitionAttempt(tenantId, nextActor.attemptId, 'succeeded')
  await runs.transitionRun(tenantId, nextActor.runId, 'succeeded')
  const conversations = new PostgresConversationRepository(database)
  assert.equal((await conversations.getTaskResultOutcomes([nextActor.runId])).get(nextActor.runId), 'achieved')
  await database`update agent_data_records set updated_at = now() - interval '8 days'
     where tenant_id = ${tenantId} and id = ${transitioned.recordId}`
  assert.equal(await service.purgeExpiredRecords(tenantId), 1)
  const checkActor = await runningActor('retention-check', primaryVersionId, 'ws-supply')
  assert.equal((await service.queryRecords(checkActor, { collectionId })).length, 0)
  const [deletion] = await database<{ reason: string; digest: string }[]>`
    select reason, content_sha256 as digest from agent_data_record_deletions
     where tenant_id = ${tenantId} and version_id = ${transitioned.recordVersionId}
  `
  assert.equal(deletion?.reason, 'retention')
  assert.match(deletion?.digest ?? '', /^[a-f0-9]{64}$/)
  assert.equal((await conversations.getTaskResultOutcomes([nextActor.runId])).get(nextActor.runId), 'achieved')
})

test('AE-03 DSH tool entry requires pinned definition, live grant and current collection schema', async () => {
  const collectionId = await service.publishCollection({ tenantId, key: 'runtime_data_records',
    ownerWorkspaceId: 'ws-supply', schema, queryFields: ['materialCode'], retentionDays: 30, actorUserId: 'U00008' })
  await service.setGrant({ tenantId, collectionId, agentId: primaryAgentId,
    actions: ['query', 'create'], actorUserId: 'U00008' })
  const actor = await runningActor('runtime-data-tools', 'agent-version-ae03-data-1', 'ws-supply', ['data_query', 'data_create'])
  const [row] = await database<{ manifest: RuntimeManifest }[]>`
    select manifest from run_attempts where tenant_id = ${tenantId} and id = ${actor.attemptId}
  `
  const manifest = row!.manifest
  const input = { collectionKey: 'runtime_data_records', recordKey: 'MAT-RUNTIME',
    data: { materialCode: 'MAT-RUNTIME', expectedArrivalDate: '2026-09-25', status: 'open' },
    operationKey: 'create-runtime' }
  const created = await service.invokeFromAttempt('data_create', input, manifest) as { recordVersionId: string }
  assert.ok(created.recordVersionId)
  const page = await service.invokeFromAttempt('data_query', { collectionKey: 'runtime_data_records', limit: 1 }, manifest) as {
    records: Array<{ recordVersionId: string }>; nextCursor: string | null
  }
  assert.equal(page.records[0]?.recordVersionId, created.recordVersionId)
  assert.equal(page.nextCursor, null)
  await service.setGrant({ tenantId, collectionId, agentId: primaryAgentId, actions: [], actorUserId: 'U00008' })
  await assert.rejects(service.invokeFromAttempt('data_query', { collectionKey: 'runtime_data_records' }, manifest),
    (error: unknown) => isCode(error, 'permission_denied'))
  await service.setGrant({ tenantId, collectionId, agentId: primaryAgentId,
    actions: ['query', 'create'], actorUserId: 'U00008' })
  await service.evolveCollection({ tenantId, collectionId, expectedVersion: 1,
    schema: { ...schema, properties: { ...schema.properties, note: { type: 'string' } } },
    queryFields: ['materialCode'], actorUserId: 'U00008' })
  await assert.rejects(service.invokeFromAttempt('data_query', { collectionKey: 'runtime_data_records' }, manifest),
    (error: unknown) => isCode(error, 'permission_denied'))
})

test('AE-03 admin API publishes a governed collection and rejects non-admin writes', async () => {
  let admin = true
  const router = new Router({ authenticateApi: async (request, audience) => {
    const identity = await prototypeApiAuthenticator(request, audience)
    return admin ? identity : { ...identity, userId: 'U00001', permissions: ['admin:read'] }
  } })
  registerAdminAgentDataRoutes(router, service)
  const server = createServer((request, response) => void router.handle(request, response))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}/api/admin/v1/agent-data`
  try {
    const created = await fetch(`${base}/collections`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'api_governed_records', ownerWorkspaceId: 'ws-supply', schema,
        queryFields: ['materialCode'], retentionDays: 30 }) })
    assert.equal(created.status, 201)
    const payload = await created.json() as { data: { id: string } }
    assert.ok(payload.data.id)
    const grants = await fetch(`${base}/collections/${payload.data.id}/grants/${primaryAgentId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actions: ['query'] }),
    })
    assert.equal(grants.status, 200)
    const listed = await fetch(`${base}/collections`)
    assert.equal(listed.status, 200)
    admin = false
    const denied = await fetch(`${base}/collections`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'api_denied_records', schema, queryFields: [], retentionDays: 30 }) })
    assert.equal(denied.status, 403)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('AE-03 service rejects an administrator whose role was disabled after request authentication', async () => {
  await database`update roles set status = 'disabled'
     where tenant_id = ${tenantId} and id = 'role-platform-admin'`
  try {
    await assert.rejects(service.publishCollection({ tenantId, key: 'disabled_admin_records',
      schema, queryFields: [], retentionDays: 30, actorUserId: 'U00008' }),
    (error: unknown) => isCode(error, 'permission_denied'))
  } finally {
    await database`update roles set status = 'active'
       where tenant_id = ${tenantId} and id = 'role-platform-admin'`
  }
})

test('AE-03 forty Agent installations reuse fixed tables without per-Agent DDL', async () => {
  const [before] = await database<{ total: number }[]>`
    select count(*)::integer as total from pg_tables
     where schemaname = current_schema() and tablename like 'agent_%'
  `
  await database`
    insert into agents (id, tenant_id, name, description, owner_user_id, created_by, status)
    select 'agent-ae03-scale-' || lpad(n::text, 3, '0'), ${tenantId},
           'Scale Agent ' || n, 'AE-03 reusable installation', 'U00008', 'U00008', 'published'
      from generate_series(1, 40) as n
  `
  const [installed] = await database<{ total: number }[]>`
    select count(*)::integer as total from agent_installations
     where tenant_id = ${tenantId} and agent_id like 'agent-ae03-scale-%'
  `
  const [after] = await database<{ total: number }[]>`
    select count(*)::integer as total from pg_tables
     where schemaname = current_schema() and tablename like 'agent_%'
  `
  assert.equal(installed?.total, 40)
  assert.equal(after?.total, before?.total)
})

test('AE-03 maintenance removes expired state and unreviewed proposal bodies', async () => {
  const actor = await runningActor('maintenance-state', primaryVersionId, 'ws-supply')
  await service.putState(actor, { namespace: 'maintenance', key: 'expired', value: { cursor: 1 },
    expectedVersion: 0, ttlSeconds: 60 })
  await database`update agent_state set expires_at = now() - interval '1 minute'
     where tenant_id = ${tenantId} and namespace = 'maintenance' and key = 'expired'`
  assert.equal(await service.purgeExpiredState(tenantId), 1)
  assert.equal(await service.getState(actor, 'maintenance', 'expired'), null)
  const collectionId = await service.publishCollection({ tenantId, key: 'maintenance_proposals',
    schema, queryFields: [], retentionDays: 30, actorUserId: 'U00008' })
  await service.setGrant({ tenantId, collectionId, agentId: primaryAgentId,
    actions: ['propose'], actorUserId: 'U00008' })
  const proposal = await service.proposeRecord(actor, { collectionId, recordKey: 'MAT-OLD',
    data: { materialCode: 'MAT-OLD', expectedArrivalDate: '2026-09-25', status: 'open' },
    expectedVersion: 0, operationKey: 'old-proposal' })
  await database`update agent_data_proposals set created_at = now() - interval '31 days'
     where tenant_id = ${tenantId} and id = ${proposal.proposalId}`
  assert.equal(await service.purgeExpiredProposals(tenantId), 1)
  assert.equal((await service.listProposals(tenantId, 'U00008')).some(item => item.id === proposal.proposalId), false)
})

test('AE-03 write-rate quota is atomic and idempotent replay does not consume it', async () => {
  const actor = await runningActor('rate-limit', primaryVersionId, 'ws-supply')
  const collectionId = await service.publishCollection({ tenantId, key: 'rate_limit_records',
    schema, queryFields: [], retentionDays: 30, actorUserId: 'U00008' })
  await service.setGrant({ tenantId, collectionId, agentId: primaryAgentId,
    actions: ['create'], actorUserId: 'U00008' })
  const data = { materialCode: 'MAT-RATE', expectedArrivalDate: '2026-09-25', status: 'open' }
  const first = await service.writeRecord(actor, { collectionId, recordKey: 'MAT-RATE-1', data,
    expectedVersion: 0, operationKey: 'rate-1' })
  await database`update agent_data_write_counters set used = 119
     where tenant_id = ${tenantId} and scope_key = ${`collection:${collectionId}`}`
  const competing = await Promise.allSettled(['MAT-RATE-2', 'MAT-RATE-3'].map((recordKey, index) =>
    service.writeRecord(actor, { collectionId, recordKey, data, expectedVersion: 0,
      operationKey: `rate-${index + 2}` })))
  assert.equal(competing.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(competing.filter(item => item.status === 'rejected' && isCode(item.reason, 'invalid_request')).length, 1)
  assert.deepEqual(await service.writeRecord(actor, { collectionId, recordKey: 'MAT-RATE-1', data,
    expectedVersion: 0, operationKey: 'rate-1' }), first)
  const [installation] = await database<{ id: string }[]>`
    select id from agent_installations where tenant_id = ${tenantId} and agent_id = ${primaryAgentId}
  `
  await database`update agent_data_write_counters set used = 119
     where tenant_id = ${tenantId} and agent_installation_id = ${installation!.id} and scope_key = 'state'`
  assert.equal(await service.putState(actor, { namespace: 'rate', key: 'last', value: 1,
    expectedVersion: 0, ttlSeconds: 60 }), 1)
  await assert.rejects(service.putState(actor, { namespace: 'rate', key: 'next', value: 2,
    expectedVersion: 0, ttlSeconds: 60 }), (error: unknown) => isCode(error, 'invalid_request'))
  await database`update agent_data_write_counters set bucket_at = now() - interval '3 days'
     where tenant_id = ${tenantId} and scope_key = ${`collection:${collectionId}`}`
  assert.equal(await service.purgeExpiredWriteCounters(tenantId), 1)
})

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

async function runningActor(label: string, agentVersionId: string, workspaceId: string,
  toolIds: string[] = [], roleIds: string[] = ['role-employee']): Promise<AgentDataActor> {
  const correlationKey = `${label}-${randomUUID()}`
  const task = await tasks.createTask({
    tenantId, requestedBy: 'U00001', sourceType: 'api', correlationKey, workspaceId,
  })
  const run = await runs.createRun({
    tenantId, taskId: task.id, sessionId: null, workspaceId, requestedBy: task.requestedBy,
    idempotencyKey: correlationKey,
  })
  const [principal] = await database<{ id: string; authorizationVersion: number }[]>`
    select ep.id, ep.authorization_version as "authorizationVersion"
      from agent_versions av join execution_principals ep
        on ep.tenant_id = av.tenant_id and ep.agent_id = av.agent_id and ep.kind = 'agent'
     where av.tenant_id = ${tenantId} and av.id = ${agentVersionId}
  `
  assert.ok(principal)
  const manifest: RuntimeManifest = {
    manifest_version: '1.0', run_id: run.id, attempt_id: `attempt-${randomUUID()}`,
    task_id: task.id, session_id: null, workspace_id: workspaceId,
    agent_version_id: agentVersionId,
    agent_configuration: { system_prompt: 'You are an AE-03 test Agent with governed data access.', skill_instructions: [] },
    user_context: { user_id: 'U00001', tenant_id: tenantId, role_ids: roleIds },
    principal_context: {
      initiated_by: task.initiatedByPrincipalId!, executed_as: principal.id,
      disclosure_user_id: 'U00001', executor_authorization_version: principal.authorizationVersion,
    },
    permission_policy: { approval_mode: 'never', network_policy: 'deny', write_policy: 'workspace_only' },
    skills: [], tools: toolIds.map(id => ({ id, version: '1.0.0' })),
    data_scopes: ['enterprise:authorized', 'workspace:authorized'], knowledge_context: [],
    input: { message: 'Use approved data.', file_mounts: [] },
    budget: {
      scope_task_id: task.id,
      cumulative_limits: { max_duration_ms: null, max_tool_calls: null, max_output_bytes: null },
      reservation: { duration_ms: 30_000, tool_calls: 1, output_bytes: 4096 },
      enforcement: { duration: 'hard', tool_calls: 'hard', output_bytes: 'hard', tokens: 'unsupported', cost: 'unsupported' },
    },
    limits: { timeout_seconds: 30, max_tool_calls: 1, max_output_bytes: 4096 },
    created_at: new Date().toISOString(), trace_id: `trace-${correlationKey}`,
  }
  const compiled = compileRuntimeManifest(manifest)
  await runs.createAttempt({
    attemptId: manifest.attempt_id, tenantId, runId: run.id, runtimeId: 'runtime-local-01',
    manifest: JSON.parse(compiled.canonicalJson) as JsonObject, manifestSha256: compiled.sha256,
    modelRouteSnapshot: {},
  })
  await runs.transitionAttempt(tenantId, manifest.attempt_id, 'running')
  await runs.transitionRun(tenantId, run.id, 'running')
  return {
    tenantId, agentVersionId, principalId: principal.id, runId: run.id,
    attemptId: manifest.attempt_id, userId: 'U00001', workspaceId,
  }
}
