import { randomUUID } from 'node:crypto'

import Ajv2020Module from 'ajv/dist/2020.js'

import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import { authorizationDenied, requestInvalid } from '../authorization/authorization-errors.ts'
import { canonicalJson, sha256 } from '../runtime/canonical-json.ts'
import type { RuntimeManifest } from '../runtime/runtime-types.ts'
import type { AgentDataCollectionRequirement } from '../agent/agent-spec.ts'

const Ajv2020 = Ajv2020Module.default
const maxStateBytes = 16 * 1024
const maxRecordBytes = 64 * 1024
const maxStateKeys = 500
const maxRecordsPerCollection = 10_000
const maxWritesPerMinute = 120
const actions = ['query', 'propose', 'create', 'update', 'transition'] as const

export type CollectionAction = typeof actions[number]

export interface AgentDataActor {
  tenantId: string
  agentVersionId: string
  principalId: string
  runId: string
  attemptId: string
  userId: string
  workspaceId: string
  declaredCollectionSchemaVersion?: number
}

export interface CollectionDefinition {
  tenantId: string
  key: string
  ownerWorkspaceId?: string
  privateAgentId?: string
  schema: Record<string, unknown>
  queryFields: string[]
  retentionDays: number
  actorUserId: string
}

interface CollectionRow {
  id: string
  collectionKey: string
  tenantId: string
  ownerType: 'tenant' | 'workspace'
  ownerWorkspaceId: string | null
  accessScope: 'installation' | 'workspace' | 'tenant'
  privateInstallationId: string | null
  schemaVersion: number
  schemaJson: Record<string, unknown>
  queryFields: string[]
  retentionDays: number
  status: 'active' | 'disabled'
}

interface RecordRow {
  id: string
  currentVersionId: string | null
  currentVersion: number | null
  status: 'active' | 'archived'
}

interface RecordWriteInput {
  collectionId: string
  recordKey: string
  data: Record<string, unknown>
  expectedVersion: number
  operationKey: string
  action?: 'propose' | 'create' | 'update' | 'transition'
  expectedStatus?: string
  requestDigest?: string
}

interface ProposalRow {
  id: string
  collectionId: string
  agentInstallationId: string
  recordKey: string
  data: Record<string, unknown>
  expectedVersion: number
  sourceRunId: string
  sourceAttemptId: string
  operationKey: string
  requestSha256: string
  status: 'pending' | 'approved' | 'rejected'
  recordVersionId: string | null
  principalId: string
  agentVersionId: string
  workspaceId: string
  userId: string
  roleIds: string[]
  dataScopes: string[]
}

export class AgentDataConflict extends Error {
  readonly status = 409
  readonly code = 'AGENT_DATA_CONFLICT'
}

function boundedJson(value: unknown, maxBytes: number): string {
  const json = canonicalJson(value)
  if (!json || Buffer.byteLength(json) > maxBytes) throw requestInvalid(`数据超过 ${maxBytes} 字节上限`)
  return json
}

function assertIdentifier(value: string, label: string, max: number): void {
  if (!value || value.length > max || !/^[a-zA-Z0-9._:-]+$/.test(value)) throw requestInvalid(`${label} 格式无效`)
}

function validateCollectionSchema(schema: Record<string, unknown>, fields: string[]): void {
  if (schema['type'] !== 'object') throw requestInvalid('集合 Schema 顶层必须是 object')
  if (Buffer.byteLength(canonicalJson(schema)) > 32 * 1024) throw requestInvalid('集合 Schema 超过大小上限')
  if (fields.length > 12 || new Set(fields).size !== fields.length) throw requestInvalid('查询字段数量或重复项无效')
  const properties = schema['properties']
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) throw requestInvalid('集合 Schema 必须声明 properties')
  for (const field of fields) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(field) || !(field in properties)) {
      throw requestInvalid(`查询字段未在 Schema 中声明：${field}`)
    }
  }
  try {
    const ajv = new Ajv2020({ strict: true, allErrors: true })
    ajv.compile(schema)
  } catch {
    throw requestInvalid('集合 JSON Schema 无效或包含不支持的引用')
  }
}

/**
 * AE-03 storage kernel. The DSH Bridge must pass the current Runtime
 * authorization gate before invoking an Agent action.
 * Every data operation additionally checks the live Attempt, Principal and
 * collection grant, so a stale Manifest cannot restore a revoked grant.
 */
export class PostgresAgentDataService {
  private readonly database: DatabaseClient

  constructor(database: DatabaseClient) {
    this.database = database
  }

  /** DSH Bridge entry. A definition requests a capability; the current grant decides whether it can run. */
  async invokeFromAttempt(
    name: 'state_get' | 'state_put' | 'data_query' | 'data_create' | 'data_update' | 'data_propose' | 'data_transition',
    input: Record<string, unknown>, manifest: RuntimeManifest,
  ): Promise<unknown> {
    if (!manifest.tools.some(tool => tool.id === name) || !manifest.agent_version_id || !manifest.principal_context) {
      throw authorizationDenied('当前 Attempt 未声明 Agent 数据工具或执行身份')
    }
    const actor: AgentDataActor = {
      tenantId: manifest.user_context.tenant_id,
      agentVersionId: manifest.agent_version_id,
      principalId: manifest.principal_context.executed_as,
      runId: manifest.run_id,
      attemptId: manifest.attempt_id,
      userId: manifest.principal_context.disclosure_user_id,
      workspaceId: manifest.workspace_id,
    }
    const trialOnly = manifest.purpose === 'agent-release-trial'
    const [definition] = await this.database<{ data: { state?: boolean; collections?: AgentDataCollectionRequirement[] } | null }[]>`
      select av.agent_spec -> 'data' as data from agent_versions av
       where av.tenant_id = ${actor.tenantId} and av.id = ${actor.agentVersionId}
         and av.status = ${trialOnly ? 'draft' : 'published'}
    `
    if (!definition) throw authorizationDenied('Agent 数据声明不可用')
    if (name === 'state_get' || name === 'state_put') {
      if (definition.data?.state !== true) throw authorizationDenied('Agent Version 未声明状态服务')
      if (trialOnly) return name === 'state_get'
        ? { found: false, value: null, version: 0, trialOnly: true }
        : { version: 0, trialOnly: true }
      const namespace = String(input['namespace'] ?? '')
      const key = String(input['key'] ?? '')
      if (name === 'state_get') {
        const result = await this.getState(actor, namespace, key)
        return { found: result !== null, value: result?.value ?? null, version: result?.version ?? 0 }
      }
      return { version: await this.putState(actor, {
        namespace, key, value: input['value'],
        expectedVersion: Number(input['expectedVersion']), ttlSeconds: Number(input['ttlSeconds']),
      }) }
    }
    const key = String(input['collectionKey'] ?? '')
    const action: CollectionAction = name === 'data_query' ? 'query'
      : name === 'data_create' ? 'create' : name === 'data_propose' ? 'propose'
        : name === 'data_transition' ? 'transition' : 'update'
    const requirement = definition.data?.collections?.find(item => item.key === key && item.actions.includes(action))
    if (!requirement) throw authorizationDenied('Agent Version 未声明该集合动作')
    actor.declaredCollectionSchemaVersion = requirement.schemaVersion
    const [collection] = await this.database<CollectionRow[]>`
      select id, collection_key as "collectionKey", tenant_id as "tenantId", owner_type as "ownerType",
             owner_workspace_id as "ownerWorkspaceId", access_scope as "accessScope",
             private_installation_id as "privateInstallationId", schema_version as "schemaVersion",
             schema_json as "schemaJson", query_fields as "queryFields", retention_days as "retentionDays", status
        from agent_data_collections where tenant_id = ${actor.tenantId} and collection_key = ${key}
    `
    if (!collection || collection.status !== 'active' || collection.accessScope !== requirement.scope
      || collection.schemaVersion !== requirement.schemaVersion
      || (requirement.schema && sha256(canonicalJson(requirement.schema.body)) !== sha256(canonicalJson(collection.schemaJson)))) {
      throw authorizationDenied('集合未发布或 Schema 与 Agent Version 声明不兼容')
    }
    if (collection.accessScope === 'tenant' && !manifest.data_scopes.includes('enterprise:authorized')) {
      throw authorizationDenied('当前 Attempt 没有企业数据范围')
    }
    if (collection.accessScope === 'workspace' && !manifest.data_scopes.includes('workspace:authorized')) {
      throw authorizationDenied('当前 Attempt 没有工作空间数据范围')
    }
    if (trialOnly) {
      const [grant] = await this.database<{ actions: string[] }[]>`
        select g.actions from agent_data_collection_grants g
          join agent_installations i on i.tenant_id = g.tenant_id and i.id = g.agent_installation_id
          join agent_versions av on av.tenant_id = i.tenant_id and av.agent_id = i.agent_id
         where g.tenant_id = ${actor.tenantId} and g.collection_id = ${collection.id}
           and av.id = ${actor.agentVersionId}
      `
      if (!grant?.actions.includes(action)) throw authorizationDenied('试运行缺少当前集合授权')
      if (name === 'data_create' || name === 'data_update' || name === 'data_propose') {
        const data = input['data']
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw requestInvalid('记录 data 必须为对象')
        this.assertDataSchema(collection.schemaJson, data as Record<string, unknown>)
      }
      return name === 'data_query' ? { records: [], nextCursor: null, trialOnly: true } : { status: 'trial_only' }
    }
    if (name === 'data_query') {
      const limit = typeof input['limit'] === 'number' ? input['limit'] : 20
      const records = await this.queryRecords(actor, {
        collectionId: collection.id,
        field: typeof input['field'] === 'string' ? input['field'] : undefined,
        equals: typeof input['equals'] === 'string' ? input['equals'] : undefined,
        afterRecordKey: typeof input['after'] === 'string' ? input['after'] : undefined,
        limit: limit + 1,
      })
      return { records: records.slice(0, limit), nextCursor: records.length > limit ? records[limit - 1]?.recordKey ?? null : null }
    }
    if (name === 'data_transition') {
      return this.transitionRecord(actor, {
        collectionId: collection.id, recordKey: String(input['recordKey'] ?? ''),
        expectedVersion: Number(input['expectedVersion']), expectedStatus: String(input['expectedStatus'] ?? ''),
        nextStatus: String(input['nextStatus'] ?? ''), operationKey: String(input['operationKey'] ?? ''),
      })
    }
    const data = input['data']
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw requestInvalid('记录 data 必须为对象')
    const expectedVersion = name === 'data_create' ? 0 : Number(input['expectedVersion'])
    if (name === 'data_update' && expectedVersion < 1) throw requestInvalid('修改记录必须提供正数预期版本')
    if (name === 'data_propose') {
      return this.proposeRecord(actor, { collectionId: collection.id, recordKey: String(input['recordKey'] ?? ''),
        data: data as Record<string, unknown>, expectedVersion, operationKey: String(input['operationKey'] ?? '') })
    }
    return this.writeRecord(actor, {
      collectionId: collection.id, recordKey: String(input['recordKey'] ?? ''),
      data: data as Record<string, unknown>, expectedVersion,
      operationKey: String(input['operationKey'] ?? ''),
    })
  }

  async publishCollection(input: CollectionDefinition): Promise<string> {
    assertIdentifier(input.key, '集合 key', 80)
    if (!/^[a-z][a-z0-9_]{2,79}$/.test(input.key)) throw requestInvalid('集合 key 格式无效')
    if (!Number.isInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > 3650) {
      throw requestInvalid('保留期限必须在 1～3650 天之间')
    }
    validateCollectionSchema(input.schema, input.queryFields)
    return this.database.begin(async tx => {
      await this.assertAdministrator(tx, input.tenantId, input.actorUserId)
      const privateInstallationId = input.privateAgentId
        ? await this.installationForAgent(tx, input.tenantId, input.privateAgentId)
        : null
      if (input.ownerWorkspaceId) {
        const [workspace] = await tx<{ id: string }[]>`
          select id from workspaces where tenant_id = ${input.tenantId} and id = ${input.ownerWorkspaceId} and status = 'active'
        `
        if (!workspace) throw authorizationDenied('集合所属 Workspace 不可用')
      }
      const id = `agent-data-collection-${randomUUID()}`
      const [row] = await tx<{ id: string }[]>`
        insert into agent_data_collections
          (id, tenant_id, collection_key, owner_type, owner_workspace_id, access_scope,
           private_installation_id, schema_version, schema_json, query_fields, retention_days, created_by)
        values (${id}, ${input.tenantId}, ${input.key}, ${input.ownerWorkspaceId ? 'workspace' : 'tenant'},
                ${input.ownerWorkspaceId ?? null},
                ${privateInstallationId ? 'installation' : input.ownerWorkspaceId ? 'workspace' : 'tenant'},
                ${privateInstallationId}, 1, ${tx.json(JSON.parse(canonicalJson(input.schema)))}, ${input.queryFields},
                ${input.retentionDays}, ${input.actorUserId})
        returning id
      `
      await tx`
        insert into agent_data_collection_schema_versions
          (tenant_id, collection_id, version, schema_json, query_fields, published_by)
        values (${input.tenantId}, ${id}, 1, ${tx.json(JSON.parse(canonicalJson(input.schema)))},
                ${input.queryFields}, ${input.actorUserId})
      `
      return row!.id
    })
  }

  async setGrant(input: {
    tenantId: string; collectionId: string; agentId: string; actions: CollectionAction[]; actorUserId: string
  }): Promise<void> {
    if (new Set(input.actions).size !== input.actions.length || input.actions.some(action => !actions.includes(action))) {
      throw requestInvalid('集合授权动作无效')
    }
    await this.database.begin(async tx => {
      await this.assertAdministrator(tx, input.tenantId, input.actorUserId)
      const installationId = await this.installationForAgent(tx, input.tenantId, input.agentId)
      const collection = await this.collection(tx, input.tenantId, input.collectionId)
      if (collection.accessScope === 'installation' && collection.privateInstallationId !== installationId) {
        throw authorizationDenied('私有集合不能授权给其他 Agent')
      }
      if (!input.actions.length) {
        await tx`
          delete from agent_data_collection_grants
           where tenant_id = ${input.tenantId} and collection_id = ${input.collectionId}
             and agent_installation_id = ${installationId}
        `
        return
      }
      await tx`
        insert into agent_data_collection_grants
          (tenant_id, collection_id, agent_installation_id, actions, granted_by)
        values (${input.tenantId}, ${input.collectionId}, ${installationId}, ${input.actions}, ${input.actorUserId})
        on conflict (tenant_id, collection_id, agent_installation_id)
        do update set actions = excluded.actions, granted_by = excluded.granted_by, created_at = now()
      `
    })
  }

  async getState(actor: AgentDataActor, namespace: string, key: string): Promise<{ value: unknown; version: number } | null> {
    assertIdentifier(namespace, '命名空间', 80)
    assertIdentifier(key, '状态 key', 160)
    return this.database.begin(async tx => {
      const installationId = await this.assertLiveActor(tx, actor)
      const [row] = await tx<{ value: unknown; version: number }[]>`
        select value_json as value, version from agent_state
         where tenant_id = ${actor.tenantId} and agent_installation_id = ${installationId}
           and namespace = ${namespace} and key = ${key}
           and (expires_at is null or expires_at > now())
      `
      return row ?? null
    })
  }

  async putState(actor: AgentDataActor, input: {
    namespace: string; key: string; value: unknown; expectedVersion: number; ttlSeconds: number
  }): Promise<number> {
    assertIdentifier(input.namespace, '命名空间', 80)
    assertIdentifier(input.key, '状态 key', 160)
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) throw requestInvalid('状态预期版本无效')
    if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 60 || input.ttlSeconds > 90 * 86400) {
      throw requestInvalid('状态 TTL 必须在 60 秒至 90 天之间')
    }
    const json = boundedJson(input.value, maxStateBytes)
    return this.database.begin(async tx => {
      const installationId = await this.assertLiveActor(tx, actor)
      // Serialize the per-installation quota across different state keys.
      await tx`select id from agent_installations where tenant_id = ${actor.tenantId} and id = ${installationId} for update`
      await tx`select pg_advisory_xact_lock(43, hashtext(${`${actor.tenantId}:${installationId}:${input.namespace}:${input.key}`}))`
      const [existing] = await tx<{ version: number; expired: boolean }[]>`
        select version, expires_at <= now() as expired from agent_state
         where tenant_id = ${actor.tenantId} and agent_installation_id = ${installationId}
           and namespace = ${input.namespace} and key = ${input.key} for update
      `
      const currentVersion = existing && !existing.expired ? existing.version : 0
      if (currentVersion !== input.expectedVersion) throw new AgentDataConflict('状态版本已变化')
      if (!existing || existing.expired) {
        const [count] = await tx<{ total: number }[]>`
          select count(*)::integer as total from agent_state
           where tenant_id = ${actor.tenantId} and agent_installation_id = ${installationId}
             and (expires_at is null or expires_at > now())
        `
        if ((count?.total ?? 0) >= maxStateKeys) throw requestInvalid('Agent 状态条目已达容量上限')
      }
      const nextVersion = currentVersion + 1
      await this.reserveWriteCapacity(tx, actor.tenantId, installationId, 'state')
      await tx`
        insert into agent_state
          (tenant_id, agent_installation_id, namespace, key, value_json, version, expires_at,
           updated_by_principal_id, source_run_id, source_attempt_id)
        values (${actor.tenantId}, ${installationId}, ${input.namespace}, ${input.key}, ${tx.json(JSON.parse(json))},
                ${nextVersion}, now() + ${input.ttlSeconds} * interval '1 second',
                ${actor.principalId}, ${actor.runId}, ${actor.attemptId})
        on conflict (tenant_id, agent_installation_id, namespace, key)
        do update set value_json = excluded.value_json, version = excluded.version,
                      expires_at = excluded.expires_at, updated_at = now(),
                      updated_by_principal_id = excluded.updated_by_principal_id,
                      source_run_id = excluded.source_run_id, source_attempt_id = excluded.source_attempt_id
      `
      return nextVersion
    })
  }

  async writeRecord(actor: AgentDataActor, input: RecordWriteInput): Promise<{ recordId: string; recordVersionId: string; version: number }> {
    return this.database.begin(async tx => {
      const installationId = await this.assertLiveActor(tx, actor)
      return this.writeRecordInTransaction(tx, actor, input, installationId)
    })
  }

  private async writeRecordInTransaction(tx: DatabaseTransaction, actor: AgentDataActor, input: RecordWriteInput,
    installationId: string): Promise<{ recordId: string; recordVersionId: string; version: number }> {
    assertIdentifier(input.recordKey, '记录 key', 160)
    assertIdentifier(input.operationKey, '操作 key', 160)
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) throw requestInvalid('记录预期版本无效')
    const json = boundedJson(input.data, maxRecordBytes)
    const requestDigest = input.requestDigest ?? sha256(canonicalJson({ collectionId: input.collectionId, recordKey: input.recordKey,
      data: input.data, expectedVersion: input.expectedVersion, action: input.action ?? (input.expectedVersion === 0 ? 'create' : 'update'),
      expectedStatus: input.expectedStatus ?? null }))
      await tx`select id from agent_data_collections where tenant_id = ${actor.tenantId} and id = ${input.collectionId} for update`
      const collection = await this.authorizedCollection(tx, actor, installationId, input.collectionId,
        input.action ?? (input.expectedVersion === 0 ? 'create' : 'update'))
      this.assertDataSchema(collection.schemaJson, input.data)
      // The collection lock makes its record-count quota deterministic when
      // different operation keys create different records concurrently.
      await tx`select pg_advisory_xact_lock(44, hashtext(${`${actor.tenantId}:${actor.attemptId}:${input.operationKey}`}))`
      const [replay] = await tx<{ requestSha256: string; recordVersionId: string | null; recordId: string | null; version: number | null }[]>`
        select o.request_sha256 as "requestSha256", o.record_version_id as "recordVersionId",
               v.record_id as "recordId", v.version
          from agent_data_record_operations o
          left join agent_data_record_versions v on v.tenant_id = o.tenant_id and v.id = o.record_version_id
         where o.tenant_id = ${actor.tenantId} and o.source_attempt_id = ${actor.attemptId}
           and o.operation_key = ${input.operationKey}
      `
      if (replay) {
        if (replay.requestSha256 !== requestDigest) throw new AgentDataConflict('操作键已用于不同的记录请求')
        if (!replay.recordId || !replay.recordVersionId || replay.version === null) {
          throw new AgentDataConflict('记录已删除，原操作不得重放')
        }
        return { recordId: replay.recordId, recordVersionId: replay.recordVersionId, version: replay.version }
      }
      const scopeKey = collection.ownerType === 'workspace' ? `workspace:${collection.ownerWorkspaceId}` : 'tenant'
      await tx`select pg_advisory_xact_lock(45, hashtext(${`${actor.tenantId}:${collection.id}:${scopeKey}:${input.recordKey}`}))`
      const [existing] = await tx<RecordRow[]>`
        select r.id, r.current_version_id as "currentVersionId", v.version as "currentVersion", r.status
          from agent_data_records r
          left join agent_data_record_versions v on v.tenant_id = r.tenant_id and v.id = r.current_version_id
         where r.tenant_id = ${actor.tenantId} and r.collection_id = ${collection.id}
           and r.scope_key = ${scopeKey} and r.record_key = ${input.recordKey}
         for update of r
      `
      if ((existing?.currentVersion ?? 0) !== input.expectedVersion || existing?.status === 'archived') {
        throw new AgentDataConflict('记录版本已变化或记录已归档')
      }
      if (!existing) {
        const [count] = await tx<{ total: number }[]>`
          select count(*)::integer as total from agent_data_records
           where tenant_id = ${actor.tenantId} and collection_id = ${collection.id}
        `
        if ((count?.total ?? 0) >= maxRecordsPerCollection) throw requestInvalid('集合记录数已达容量上限')
      }
      await this.reserveWriteCapacity(tx, actor.tenantId, installationId, `collection:${collection.id}`)
      const recordId = existing?.id ?? `agent-data-record-${randomUUID()}`
      const recordVersionId = `agent-data-version-${randomUUID()}`
      if (!existing) {
        await tx`
          insert into agent_data_records
            (id, tenant_id, collection_id, scope_key, record_key, created_by_principal_id)
          values (${recordId}, ${actor.tenantId}, ${collection.id}, ${scopeKey}, ${input.recordKey}, ${actor.principalId})
        `
      }
      const version = input.expectedVersion + 1
      await tx`
        insert into agent_data_record_versions
          (id, tenant_id, record_id, version, schema_version, data_json, content_sha256,
           written_by_principal_id, source_run_id, source_attempt_id)
        values (${recordVersionId}, ${actor.tenantId}, ${recordId}, ${version}, ${collection.schemaVersion},
                ${tx.json(JSON.parse(json))}, ${sha256(json)}, ${actor.principalId}, ${actor.runId}, ${actor.attemptId})
      `
      await tx`
        update agent_data_records set current_version_id = ${recordVersionId}, updated_at = now()
         where tenant_id = ${actor.tenantId} and id = ${recordId}
      `
      await tx`
        insert into agent_data_record_operations
          (tenant_id, source_attempt_id, operation_key, request_sha256, record_version_id)
        values (${actor.tenantId}, ${actor.attemptId}, ${input.operationKey}, ${requestDigest}, ${recordVersionId})
      `
      return { recordId, recordVersionId, version }
  }

  async proposeRecord(actor: AgentDataActor, input: RecordWriteInput): Promise<{ proposalId: string; status: 'pending_admin_review' }> {
    assertIdentifier(input.recordKey, '记录 key', 160)
    assertIdentifier(input.operationKey, '操作 key', 160)
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) throw requestInvalid('记录预期版本无效')
    const json = boundedJson(input.data, maxRecordBytes)
    const digest = sha256(canonicalJson({ collectionId: input.collectionId, recordKey: input.recordKey,
      data: input.data, expectedVersion: input.expectedVersion }))
    return this.database.begin(async tx => {
      const installationId = await this.assertLiveActor(tx, actor)
      const collection = await this.authorizedCollection(tx, actor, installationId, input.collectionId, 'propose')
      this.assertDataSchema(collection.schemaJson, input.data)
      await tx`select pg_advisory_xact_lock(46, hashtext(${`${actor.tenantId}:${actor.attemptId}:${input.operationKey}`}))`
      const [prior] = await tx<{ id: string; requestSha256: string }[]>`
        select id, request_sha256 as "requestSha256" from agent_data_proposals
         where tenant_id = ${actor.tenantId} and source_attempt_id = ${actor.attemptId} and operation_key = ${input.operationKey}
      `
      if (prior) {
        if (prior.requestSha256 !== digest) throw new AgentDataConflict('提案操作键已用于不同请求')
        return { proposalId: prior.id, status: 'pending_admin_review' as const }
      }
      await this.reserveWriteCapacity(tx, actor.tenantId, installationId, `collection:${collection.id}`)
      const id = `agent-data-proposal-${randomUUID()}`
      await tx`
        insert into agent_data_proposals
          (id, tenant_id, collection_id, agent_installation_id, record_key, data_json,
           expected_version, source_run_id, source_attempt_id, operation_key, request_sha256)
        values (${id}, ${actor.tenantId}, ${input.collectionId}, ${installationId}, ${input.recordKey},
                ${tx.json(JSON.parse(json))}, ${input.expectedVersion}, ${actor.runId}, ${actor.attemptId},
                ${input.operationKey}, ${digest})
      `
      return { proposalId: id, status: 'pending_admin_review' as const }
    })
  }

  async transitionRecord(actor: AgentDataActor, input: {
    collectionId: string; recordKey: string; expectedVersion: number; expectedStatus: string;
    nextStatus: string; operationKey: string
  }): Promise<{ recordId: string; recordVersionId: string; version: number }> {
    assertIdentifier(input.expectedStatus, '原状态', 80)
    assertIdentifier(input.nextStatus, '目标状态', 80)
    if (input.expectedStatus === input.nextStatus || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw requestInvalid('状态转换参数无效')
    }
    return this.database.begin(async tx => {
      const installationId = await this.assertLiveActor(tx, actor)
      await tx`select id from agent_data_collections where tenant_id = ${actor.tenantId} and id = ${input.collectionId} for update`
      const collection = await this.authorizedCollection(tx, actor, installationId, input.collectionId, 'transition')
      const requestDigest = sha256(canonicalJson(input))
      const [prior] = await tx<{ requestSha256: string; recordVersionId: string | null; recordId: string | null; version: number | null }[]>`
        select o.request_sha256 as "requestSha256", o.record_version_id as "recordVersionId",
               v.record_id as "recordId", v.version from agent_data_record_operations o
          left join agent_data_record_versions v on v.tenant_id = o.tenant_id and v.id = o.record_version_id
         where o.tenant_id = ${actor.tenantId} and o.source_attempt_id = ${actor.attemptId}
           and o.operation_key = ${input.operationKey}
      `
      if (prior) {
        if (prior.requestSha256 !== requestDigest) throw new AgentDataConflict('操作键已用于不同的状态转换')
        if (!prior.recordId || !prior.recordVersionId || prior.version === null) {
          throw new AgentDataConflict('记录已删除，原操作不得重放')
        }
        return { recordId: prior.recordId, recordVersionId: prior.recordVersionId, version: prior.version }
      }
      if (!('status' in (collection.schemaJson['properties'] as Record<string, unknown>))) {
        throw requestInvalid('集合 Schema 没有 status 字段')
      }
      const scopeKey = collection.ownerType === 'workspace' ? `workspace:${collection.ownerWorkspaceId}` : 'tenant'
      const [current] = await tx<{ data: Record<string, unknown>; version: number }[]>`
        select v.data_json as data, v.version from agent_data_records r
          join agent_data_record_versions v on v.tenant_id = r.tenant_id and v.id = r.current_version_id
         where r.tenant_id = ${actor.tenantId} and r.collection_id = ${collection.id}
           and r.scope_key = ${scopeKey} and r.record_key = ${input.recordKey} and r.status = 'active'
         for update of r
      `
      if (!current || current.version !== input.expectedVersion || current.data['status'] !== input.expectedStatus) {
        throw new AgentDataConflict('记录版本或状态已变化')
      }
      return this.writeRecordInTransaction(tx, actor, { ...input, data: { ...current.data, status: input.nextStatus },
        action: 'transition', requestDigest }, installationId)
    })
  }

  async listCollections(tenantId: string, actorUserId: string): Promise<Array<{
    id: string; key: string; scope: string; ownerWorkspaceId: string | null; privateInstallationId: string | null;
    schemaVersion: number; schema: Record<string, unknown>; queryFields: string[]; retentionDays: number; status: string
  }>> {
    await this.database.begin(tx => this.assertAdministrator(tx, tenantId, actorUserId))
    return this.database`
      select id, collection_key as key, access_scope as scope, owner_workspace_id as "ownerWorkspaceId",
             private_installation_id as "privateInstallationId", schema_version as "schemaVersion",
             schema_json as schema, query_fields as "queryFields", retention_days as "retentionDays", status
        from agent_data_collections where tenant_id = ${tenantId} order by created_at desc, id desc
    `
  }

  async listGrants(tenantId: string, collectionId: string, actorUserId: string): Promise<Array<{
    agentId: string; agentName: string; actions: CollectionAction[]; grantedAt: Date
  }>> {
    await this.database.begin(async tx => {
      await this.assertAdministrator(tx, tenantId, actorUserId)
      await this.collection(tx, tenantId, collectionId)
    })
    return this.database`
      select i.agent_id as "agentId", a.name as "agentName", g.actions, g.created_at as "grantedAt"
        from agent_data_collection_grants g
        join agent_installations i on i.tenant_id = g.tenant_id and i.id = g.agent_installation_id
        join agents a on a.tenant_id = i.tenant_id and a.id = i.agent_id
       where g.tenant_id = ${tenantId} and g.collection_id = ${collectionId}
       order by a.name asc, i.agent_id asc
    `
  }

  async listRecordsForAdministration(input: {
    tenantId: string; collectionId: string; actorUserId: string; after?: string; limit?: number
  }): Promise<{ items: Array<{ id: string; recordKey: string; versionId: string; version: number;
    schemaVersion: number; data: Record<string, unknown>; sourceRunId: string; sourceAttemptId: string }>;
    nextCursor: string | null }> {
    const limit = input.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw requestInvalid('查询上限必须在 1～100 之间')
    if (input.after !== undefined) assertIdentifier(input.after, '分页游标', 160)
    await this.database.begin(async tx => {
      await this.assertAdministrator(tx, input.tenantId, input.actorUserId)
      const [row] = await tx<{ id: string }[]>`
        select id from agent_data_collections where tenant_id = ${input.tenantId} and id = ${input.collectionId}
      `
      if (!row) throw requestInvalid('集合不存在')
    })
    const rows = await this.database<Array<{ id: string; recordKey: string; versionId: string;
      version: number; schemaVersion: number; data: Record<string, unknown>; sourceRunId: string; sourceAttemptId: string }>>`
      select r.id, r.record_key as "recordKey", v.id as "versionId", v.version,
             v.schema_version as "schemaVersion", v.data_json as data,
             v.source_run_id as "sourceRunId", v.source_attempt_id as "sourceAttemptId"
        from agent_data_records r
        join agent_data_record_versions v on v.tenant_id = r.tenant_id and v.id = r.current_version_id
       where r.tenant_id = ${input.tenantId} and r.collection_id = ${input.collectionId}
         and (${input.after ?? null}::text is null or r.record_key > ${input.after ?? ''})
       order by r.record_key asc limit ${limit + 1}
    `
    return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1]?.recordKey ?? null : null }
  }

  async evolveCollection(input: {
    tenantId: string; collectionId: string; expectedVersion: number; schema: Record<string, unknown>;
    queryFields: string[]; actorUserId: string
  }): Promise<number> {
    validateCollectionSchema(input.schema, input.queryFields)
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw requestInvalid('集合预期版本无效')
    return this.database.begin(async tx => {
      await this.assertAdministrator(tx, input.tenantId, input.actorUserId)
      const [current] = await tx<{ schemaVersion: number }[]>`
        select schema_version as "schemaVersion" from agent_data_collections
         where tenant_id = ${input.tenantId} and id = ${input.collectionId} and status = 'active' for update
      `
      if (!current) throw requestInvalid('集合不存在或已停用')
      if (current.schemaVersion !== input.expectedVersion) throw new AgentDataConflict('集合 Schema 版本已变化')
      const next = current.schemaVersion + 1
      await tx`
        update agent_data_collections set schema_version = ${next},
               schema_json = ${tx.json(JSON.parse(canonicalJson(input.schema)))},
               query_fields = ${input.queryFields}, updated_at = now()
         where tenant_id = ${input.tenantId} and id = ${input.collectionId}
      `
      await tx`
        insert into agent_data_collection_schema_versions
          (tenant_id, collection_id, version, schema_json, query_fields, published_by)
        values (${input.tenantId}, ${input.collectionId}, ${next},
                ${tx.json(JSON.parse(canonicalJson(input.schema)))}, ${input.queryFields}, ${input.actorUserId})
      `
      return next
    })
  }

  async setCollectionStatus(input: {
    tenantId: string; collectionId: string; status: 'active' | 'disabled'; actorUserId: string
  }): Promise<void> {
    await this.database.begin(async tx => {
      await this.assertAdministrator(tx, input.tenantId, input.actorUserId)
      const [row] = await tx<{ id: string }[]>`
        update agent_data_collections set status = ${input.status}, updated_at = now()
         where tenant_id = ${input.tenantId} and id = ${input.collectionId} returning id
      `
      if (!row) throw requestInvalid('集合不存在')
    })
  }

  async purgeExpiredRecords(tenantId: string, limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw requestInvalid('清理批量无效')
    return this.database.begin(async tx => {
      const candidates = await tx<{ id: string }[]>`
        select r.id from agent_data_records r
          join agent_data_collections c on c.tenant_id = r.tenant_id and c.id = r.collection_id
         where r.tenant_id = ${tenantId}
           and r.updated_at < now() - c.retention_days * interval '1 day'
           and not exists (
             select 1 from agent_data_record_versions v
               join runs source on source.tenant_id = v.tenant_id and source.id = v.source_run_id
              where v.tenant_id = r.tenant_id and v.record_id = r.id
                and source.status not in ('succeeded', 'failed', 'cancelled')
           )
         order by r.updated_at asc, r.id asc limit ${limit} for update of r skip locked
      `
      for (const candidate of candidates) await this.deleteRecordInTransaction(tx, tenantId, candidate.id, 'retention', null)
      return candidates.length
    })
  }

  async purgeExpiredState(tenantId: string, limit = 500): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw requestInvalid('清理批量无效')
    const rows = await this.database<{ tenantId: string }[]>`
      delete from agent_state where (tenant_id, agent_installation_id, namespace, key) in (
        select tenant_id, agent_installation_id, namespace, key from agent_state
         where tenant_id = ${tenantId} and expires_at <= now()
         order by expires_at asc limit ${limit} for update skip locked
      ) returning tenant_id as "tenantId"
    `
    return rows.length
  }

  async purgeExpiredProposals(tenantId: string, limit = 500): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw requestInvalid('清理批量无效')
    const rows = await this.database<{ id: string }[]>`
      delete from agent_data_proposals where id in (
        select id from agent_data_proposals where tenant_id = ${tenantId}
          and (status = 'pending' and created_at < now() - interval '30 days'
               or status <> 'pending' and reviewed_at < now() - interval '90 days')
         order by created_at asc limit ${limit} for update skip locked
      ) returning id
    `
    return rows.length
  }

  async purgeExpiredWriteCounters(tenantId: string, limit = 1000): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw requestInvalid('清理批量无效')
    const rows = await this.database<{ scopeKey: string }[]>`
      delete from agent_data_write_counters where (tenant_id, agent_installation_id, scope_key, bucket_at) in (
        select tenant_id, agent_installation_id, scope_key, bucket_at from agent_data_write_counters
         where tenant_id = ${tenantId} and bucket_at < now() - interval '2 days'
         order by bucket_at asc limit ${limit} for update skip locked
      ) returning scope_key as "scopeKey"
    `
    return rows.length
  }

  async deleteRecord(input: { tenantId: string; recordId: string; actorUserId: string }): Promise<void> {
    await this.database.begin(async tx => {
      await this.assertAdministrator(tx, input.tenantId, input.actorUserId)
      await this.deleteRecordInTransaction(tx, input.tenantId, input.recordId, 'administrator', input.actorUserId)
    })
  }

  private async deleteRecordInTransaction(tx: DatabaseTransaction, tenantId: string, recordId: string,
    reason: 'retention' | 'administrator', actorUserId: string | null): Promise<void> {
    const [record] = await tx<{ collectionId: string; recordKey: string; scopeKey: string }[]>`
      select r.collection_id as "collectionId", r.record_key as "recordKey", r.scope_key as "scopeKey"
        from agent_data_records r
       where r.tenant_id = ${tenantId} and r.id = ${recordId} for update of r
    `
    if (!record) throw requestInvalid('记录不存在')
    const versions = await tx<{ id: string; contentSha256: string; sourceRunId: string; sourceAttemptId: string }[]>`
      select id, content_sha256 as "contentSha256", source_run_id as "sourceRunId",
             source_attempt_id as "sourceAttemptId" from agent_data_record_versions
       where tenant_id = ${tenantId} and record_id = ${recordId} order by version asc
    `
    for (const version of versions) await tx`
      insert into agent_data_record_deletions
        (id, tenant_id, collection_id, record_key, scope_key, version_id,
         content_sha256, source_run_id, source_attempt_id, reason, deleted_by)
      values (${`agent-data-deletion-${randomUUID()}`}, ${tenantId}, ${record.collectionId},
              ${record.recordKey}, ${record.scopeKey}, ${version.id}, ${version.contentSha256},
              ${version.sourceRunId}, ${version.sourceAttemptId}, ${reason}, ${actorUserId})
    `
    await tx`
      update agent_data_record_operations set record_version_id = null, deleted_at = now()
       where tenant_id = ${tenantId}
        and record_version_id in (select id from agent_data_record_versions where tenant_id = ${tenantId} and record_id = ${recordId})
    `
    await tx`update agent_data_records set current_version_id = null where tenant_id = ${tenantId} and id = ${recordId}`
    await tx`delete from agent_data_record_versions where tenant_id = ${tenantId} and record_id = ${recordId}`
    await tx`delete from agent_data_records where tenant_id = ${tenantId} and id = ${recordId}`
  }

  async listProposals(tenantId: string, actorUserId: string, status?: 'pending' | 'approved' | 'rejected'): Promise<Array<{
    id: string; collectionId: string; recordKey: string; data: Record<string, unknown>; expectedVersion: number;
    sourceRunId: string; sourceAttemptId: string; status: string; recordVersionId: string | null
  }>> {
    await this.database.begin(tx => this.assertAdministrator(tx, tenantId, actorUserId))
    return this.database`
      select id, collection_id as "collectionId", record_key as "recordKey", data_json as data,
             expected_version as "expectedVersion", source_run_id as "sourceRunId",
             source_attempt_id as "sourceAttemptId", status, record_version_id as "recordVersionId"
        from agent_data_proposals
       where tenant_id = ${tenantId} and (${status ?? null}::text is null or status = ${status ?? ''})
       order by created_at desc, id desc limit 100
    `
  }

  async reviewProposal(input: {
    tenantId: string; proposalId: string; decision: 'approved' | 'rejected'; actorUserId: string
  }): Promise<{ id: string; status: 'approved' | 'rejected'; recordVersionId: string | null }> {
    return this.database.begin(async tx => {
      await this.assertAdministrator(tx, input.tenantId, input.actorUserId)
      const [proposal] = await tx<ProposalRow[]>`
        select p.id, p.collection_id as "collectionId", p.agent_installation_id as "agentInstallationId",
               p.record_key as "recordKey", p.data_json as data, p.expected_version as "expectedVersion",
               p.source_run_id as "sourceRunId", p.source_attempt_id as "sourceAttemptId",
               p.operation_key as "operationKey", p.request_sha256 as "requestSha256",
               p.status, p.record_version_id as "recordVersionId",
               ra.manifest #>> '{principal_context,executed_as}' as "principalId",
               ra.manifest ->> 'agent_version_id' as "agentVersionId",
               ra.manifest ->> 'workspace_id' as "workspaceId", r.requested_by as "userId",
               coalesce(ra.manifest #> '{user_context,role_ids}', '[]'::jsonb) as "roleIds",
               coalesce(ra.manifest -> 'data_scopes', '[]'::jsonb) as "dataScopes"
          from agent_data_proposals p
          join run_attempts ra on ra.tenant_id = p.tenant_id and ra.id = p.source_attempt_id
          join runs r on r.tenant_id = p.tenant_id and r.id = p.source_run_id
         where p.tenant_id = ${input.tenantId} and p.id = ${input.proposalId}
         for update of p
      `
      if (!proposal) throw requestInvalid('提案不存在')
      if (proposal.status !== 'pending') {
        if (proposal.status !== input.decision) throw new AgentDataConflict('提案已作出相反决定')
        return { id: proposal.id, status: proposal.status, recordVersionId: proposal.recordVersionId }
      }
      let recordVersionId: string | null = null
      if (input.decision === 'approved') {
        // Acquire the collection write lock before reading its shared metadata.
        // Concurrent reviews must not both hold SHARE then upgrade to UPDATE.
        await tx`select id from agent_data_collections
          where tenant_id = ${input.tenantId} and id = ${proposal.collectionId} for update`
        const actor: AgentDataActor = {
          tenantId: input.tenantId, agentVersionId: proposal.agentVersionId,
          principalId: proposal.principalId, runId: proposal.sourceRunId,
          attemptId: proposal.sourceAttemptId, workspaceId: proposal.workspaceId, userId: proposal.userId,
        }
        const [source] = await tx<{
          installationId: string; agentId: string; workspaceType: string;
          versionRoleIds: string[]; versionDataScopes: string[];
          dataRequirements: AgentDataCollectionRequirement[];
          collectionKey: string; collectionScope: string; collectionSchemaVersion: number
        }[]>`
          select i.id as "installationId", a.id as "agentId", w.workspace_type as "workspaceType",
                 av.visible_role_ids as "versionRoleIds", av.data_scopes as "versionDataScopes",
                 coalesce(av.agent_spec #> '{data,collections}', '[]'::jsonb) as "dataRequirements",
                 c.collection_key as "collectionKey", c.access_scope as "collectionScope",
                 c.schema_version as "collectionSchemaVersion"
            from agent_installations i
          join tenants t on t.id = i.tenant_id and t.status = 'active'
          join agents a on a.tenant_id = i.tenant_id and a.id = i.agent_id and a.status = 'published'
          join agent_versions av on av.tenant_id = a.tenant_id and av.agent_id = a.id and av.id = ${actor.agentVersionId} and av.status = 'published'
          join execution_principals ep on ep.tenant_id = a.tenant_id and ep.agent_id = a.id and ep.id = ${actor.principalId} and ep.status = 'active'
          join users u on u.tenant_id = a.tenant_id and u.id = ${actor.userId} and u.status = 'active'
          join workspaces w on w.tenant_id = a.tenant_id and w.id = ${actor.workspaceId} and w.status = 'active'
          join agent_data_collections c on c.tenant_id = i.tenant_id and c.id = ${proposal.collectionId} and c.status = 'active'
          join runs r on r.tenant_id = i.tenant_id and r.id = ${actor.runId} and r.status = 'succeeded'
          join run_attempts ra on ra.tenant_id = r.tenant_id and ra.id = ${actor.attemptId}
            and ra.run_id = r.id and ra.status = 'succeeded'
         where i.tenant_id = ${input.tenantId} and i.id = ${proposal.agentInstallationId}
           and (w.workspace_type = 'personal' and w.created_by = u.id
                or w.workspace_type = 'team' and exists (
                  select 1 from workspace_members wm where wm.tenant_id = w.tenant_id and wm.workspace_id = w.id and wm.user_id = u.id))
         for share of t, a, av, ep, u, w, r, ra
        `
        if (!source) throw authorizationDenied('提案来源身份或工作空间的当前授权已撤销')
        await this.assertReviewSourceAuthorization(tx, actor, proposal, source)
        const result = await this.writeRecordInTransaction(tx, actor, {
          collectionId: proposal.collectionId, recordKey: proposal.recordKey,
          data: proposal.data, expectedVersion: proposal.expectedVersion,
          operationKey: `review-${proposal.id}`, action: 'propose',
        }, source.installationId)
        recordVersionId = result.recordVersionId
      }
      await tx`
        update agent_data_proposals set status = ${input.decision}, record_version_id = ${recordVersionId},
               reviewed_by = ${input.actorUserId}, reviewed_at = now()
         where tenant_id = ${input.tenantId} and id = ${input.proposalId}
      `
      return { id: proposal.id, status: input.decision, recordVersionId }
    })
  }

  async queryRecords(actor: AgentDataActor, input: {
    collectionId: string; field?: string; equals?: string; limit?: number; afterRecordKey?: string
  }): Promise<Array<{ recordKey: string; recordVersionId: string; version: number; schemaVersion: number; data: Record<string, unknown> }>> {
    const limit = input.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 101) throw requestInvalid('查询上限必须在 1～100 之间')
    if (input.afterRecordKey !== undefined) assertIdentifier(input.afterRecordKey, '分页游标', 160)
    if ((input.field === undefined) !== (input.equals === undefined)) throw requestInvalid('查询字段与值必须同时提供')
    return this.database.begin(async tx => {
      const installationId = await this.assertLiveActor(tx, actor)
      const collection = await this.authorizedCollection(tx, actor, installationId, input.collectionId, 'query')
      if (input.field && !collection.queryFields.includes(input.field)) throw authorizationDenied('集合字段未开放查询')
      const scopeKey = collection.ownerType === 'workspace' ? `workspace:${collection.ownerWorkspaceId}` : 'tenant'
      return tx<{ recordKey: string; recordVersionId: string; version: number; schemaVersion: number; data: Record<string, unknown> }[]>`
        select r.record_key as "recordKey", v.id as "recordVersionId", v.version,
               v.schema_version as "schemaVersion", v.data_json as data
          from agent_data_records r
          join agent_data_record_versions v on v.tenant_id = r.tenant_id and v.id = r.current_version_id
         where r.tenant_id = ${actor.tenantId} and r.collection_id = ${collection.id}
           and r.scope_key = ${scopeKey} and r.status = 'active'
           and (${input.field ?? null}::text is null or v.data_json ->> ${input.field ?? ''} = ${input.equals ?? ''})
           and (${input.afterRecordKey ?? null}::text is null or r.record_key > ${input.afterRecordKey ?? ''})
         order by r.record_key asc limit ${limit}
      `
    })
  }

  private assertDataSchema(schema: Record<string, unknown>, data: Record<string, unknown>): void {
    const ajv = new Ajv2020({ strict: true, allErrors: true })
    const validate = ajv.compile(schema)
    if (!validate(data)) throw requestInvalid('记录数据不符合已发布的集合 Schema')
  }

  private async reserveWriteCapacity(tx: DatabaseTransaction, tenantId: string, installationId: string,
    scopeKey: string): Promise<void> {
    const [reserved] = await tx<{ used: number }[]>`
      insert into agent_data_write_counters
        (tenant_id, agent_installation_id, scope_key, bucket_at, used)
      values (${tenantId}, ${installationId}, ${scopeKey}, date_trunc('minute', now()), 1)
      on conflict (tenant_id, agent_installation_id, scope_key, bucket_at)
      do update set used = agent_data_write_counters.used + 1
       where agent_data_write_counters.used < ${maxWritesPerMinute}
      returning used
    `
    if (!reserved) throw requestInvalid('Agent 数据写入频率已达每分钟上限')
  }

  private async assertAdministrator(tx: DatabaseTransaction, tenantId: string, userId: string): Promise<void> {
    const [row] = await tx<{ id: string }[]>`
      select u.id from users u join user_roles ur on ur.tenant_id = u.tenant_id and ur.user_id = u.id
        join roles role on role.tenant_id = ur.tenant_id and role.id = ur.role_id
       where u.tenant_id = ${tenantId} and u.id = ${userId} and u.status = 'active'
         and (ur.valid_until is null or ur.valid_until > now())
         and role.status = 'active'
         and (role.permissions ? 'admin:*' or role.permissions ? 'admin:write')
       limit 1 for share of u, ur, role
    `
    if (!row) throw authorizationDenied('只有当前有权管理员可发布集合或修改授权')
  }

  private async assertReviewSourceAuthorization(tx: DatabaseTransaction, actor: AgentDataActor,
    proposal: ProposalRow, source: {
      agentId: string; workspaceType: string; versionRoleIds: string[]; versionDataScopes: string[];
      dataRequirements: AgentDataCollectionRequirement[];
      collectionKey: string; collectionScope: string; collectionSchemaVersion: number
    }): Promise<void> {
    const required = source.dataRequirements.find(item => item.key === source.collectionKey
      && item.scope === source.collectionScope && item.actions.includes('propose'))
    if (!required || required.schemaVersion !== source.collectionSchemaVersion) {
      throw authorizationDenied('提案来源 Agent Version 的集合声明或 Schema 版本已失效')
    }
    actor.declaredCollectionSchemaVersion = required.schemaVersion
    if (!proposal.roleIds.length || !proposal.dataScopes.length
      || !proposal.roleIds.some(id => source.versionRoleIds.includes(id))
      || proposal.dataScopes.some(scope => !source.versionDataScopes.includes(scope))) {
      throw authorizationDenied('提案来源权限快照已失效')
    }
    const currentUserRoles = await tx<{ id: string; permissions: string[] }[]>`
      select role.id, role.permissions from user_roles ur
        join roles role on role.tenant_id = ur.tenant_id and role.id = ur.role_id
       where ur.tenant_id = ${actor.tenantId} and ur.user_id = ${actor.userId}
         and ur.source_key = 'local' and (ur.valid_until is null or ur.valid_until > now())
         and role.status = 'active'
       for share of ur, role
    `
    const currentAgentRoles = await tx<{ id: string }[]>`
      select g.role_id as id from agent_principal_role_grants g
        join roles role on role.tenant_id = g.tenant_id and role.id = g.role_id
       where g.tenant_id = ${actor.tenantId} and g.principal_id = ${actor.principalId}
         and role.status = 'active'
       for share of g, role
    `
    const userRoleIds = new Set(currentUserRoles.map(row => row.id))
    const agentRoleIds = new Set(currentAgentRoles.map(row => row.id))
    if (proposal.roleIds.some(id => !userRoleIds.has(id) || !agentRoleIds.has(id))
      || !currentUserRoles.some(row => proposal.roleIds.includes(row.id)
        && row.permissions.includes('workbench:use'))) {
      throw authorizationDenied('提案来源的当前用户或 Agent 角色授权已撤销')
    }
    const userScopes = await tx<{ scopeValue: string }[]>`
      select scope_value as "scopeValue" from data_scope_grants
       where tenant_id = ${actor.tenantId}
         and (subject_type = 'user' and subject_id = ${actor.userId}
           or subject_type = 'role' and subject_id = any(${proposal.roleIds}::text[])
           or subject_type = 'workspace' and subject_id = ${actor.workspaceId})
       for share
    `
    const agentScopes = await tx<{ scopeValue: string }[]>`
      select scope_value as "scopeValue" from agent_principal_scope_grants
       where tenant_id = ${actor.tenantId} and principal_id = ${actor.principalId}
       for share
    `
    const humanScopes = new Set(userScopes.map(row => row.scopeValue))
    const principalScopes = new Set(agentScopes.map(row => row.scopeValue))
    if (proposal.dataScopes.some(scope => !humanScopes.has(scope) || !principalScopes.has(scope))) {
      throw authorizationDenied('提案来源的当前用户或 Agent 数据范围授权已撤销')
    }
    if (source.workspaceType === 'team') {
      const [member] = await tx<{ role: string }[]>`
        select member_role as role from workspace_members
         where tenant_id = ${actor.tenantId} and workspace_id = ${actor.workspaceId}
           and user_id = ${actor.userId} for share
      `
      const [agentMember] = await tx<{ status: string }[]>`
        select status from workspace_agent_members
         where tenant_id = ${actor.tenantId} and workspace_id = ${actor.workspaceId}
           and agent_id = ${source.agentId} for share
      `
      const [workspaceGrant] = await tx<{ capabilityVersionId: string }[]>`
        select capability_version_id as "capabilityVersionId" from workspace_capability_grants
         where tenant_id = ${actor.tenantId} and workspace_id = ${actor.workspaceId}
           and capability_type = 'agent' and capability_version_id = ${actor.agentVersionId}
         for share
      `
      if (!member || member.role === 'viewer' || (agentMember && agentMember.status !== 'available') || !workspaceGrant) {
        throw authorizationDenied('提案来源的团队 Agent 或执行权限已撤销')
      }
    }
  }

  private async installationForAgent(tx: DatabaseTransaction, tenantId: string, agentId: string): Promise<string> {
    const [row] = await tx<{ id: string }[]>`
      select i.id from agent_installations i join agents a on a.tenant_id = i.tenant_id and a.id = i.agent_id
       where i.tenant_id = ${tenantId} and i.agent_id = ${agentId} and a.status <> 'disabled'
    `
    if (!row) throw authorizationDenied('Agent 安装实例不可用')
    return row.id
  }

  private async assertLiveActor(tx: DatabaseTransaction, actor: AgentDataActor): Promise<string> {
    const [row] = await tx<{ installationId: string }[]>`
      select i.id as "installationId" from run_attempts ra
      join runs r on r.tenant_id = ra.tenant_id and r.id = ra.run_id
      join agent_versions av on av.tenant_id = ra.tenant_id and av.id = ${actor.agentVersionId}
      join agents a on a.tenant_id = av.tenant_id and a.id = av.agent_id
      join agent_installations i on i.tenant_id = a.tenant_id and i.agent_id = a.id
      join execution_principals p on p.tenant_id = a.tenant_id and p.agent_id = a.id
      join users u on u.tenant_id = r.tenant_id and u.id = r.requested_by
      join workspaces w on w.tenant_id = r.tenant_id and w.id = ${actor.workspaceId}
       where ra.tenant_id = ${actor.tenantId} and ra.id = ${actor.attemptId}
         and ra.run_id = ${actor.runId} and ra.status = 'running'
         and r.status = 'running' and r.current_attempt_id = ra.id
         and r.requested_by = ${actor.userId} and u.status = 'active'
         and w.status = 'active'
         and a.status = 'published' and av.status = 'published'
         and p.id = ${actor.principalId} and p.status = 'active'
         and ra.manifest ->> 'agent_version_id' = av.id
         and ra.manifest ->> 'workspace_id' = ${actor.workspaceId}
         and (ra.manifest ->> 'purpose' is null or ra.manifest ->> 'purpose' = 'automation')
         and ra.manifest #>> '{principal_context,executed_as}' = p.id
         and ra.manifest #>> '{principal_context,disclosure_user_id}' = u.id
         for share of ra, r, av, a, p, u, w
    `
    if (!row) throw authorizationDenied('当前 Attempt 或 Agent 执行身份不可用')
    const [workspaceAccess] = await tx<{ id: string }[]>`
      select w.id from workspaces w
       where w.tenant_id = ${actor.tenantId} and w.id = ${actor.workspaceId}
         and (
           (w.workspace_type = 'personal' and w.created_by = ${actor.userId})
           or (w.workspace_type = 'team' and exists (
             select 1 from workspace_members wm where wm.tenant_id = w.tenant_id
               and wm.workspace_id = w.id and wm.user_id = ${actor.userId}
           ))
         )
    `
    if (!workspaceAccess) throw authorizationDenied('发起人已无当前 Workspace 访问权')
    return row.installationId
  }

  private async collection(tx: DatabaseTransaction, tenantId: string, collectionId: string): Promise<CollectionRow> {
    const [row] = await tx<CollectionRow[]>`
      select id, collection_key as "collectionKey", tenant_id as "tenantId", owner_type as "ownerType", owner_workspace_id as "ownerWorkspaceId",
             access_scope as "accessScope", private_installation_id as "privateInstallationId",
             schema_version as "schemaVersion", schema_json as "schemaJson", query_fields as "queryFields", retention_days as "retentionDays", status
        from agent_data_collections where tenant_id = ${tenantId} and id = ${collectionId} for share
    `
    if (!row || row.status !== 'active') throw authorizationDenied('集合不存在或已停用')
    return row
  }

  private async authorizedCollection(
    tx: DatabaseTransaction, actor: AgentDataActor, installationId: string,
    collectionId: string, action: CollectionAction,
  ): Promise<CollectionRow> {
    const collection = await this.collection(tx, actor.tenantId, collectionId)
    if (actor.declaredCollectionSchemaVersion !== undefined
      && collection.schemaVersion !== actor.declaredCollectionSchemaVersion) {
      throw authorizationDenied('集合 Schema 已在 Attempt 执行期间变化')
    }
    if (collection.ownerType === 'workspace' && collection.ownerWorkspaceId !== actor.workspaceId) {
      throw authorizationDenied('集合不属于当前 Workspace')
    }
    if (collection.privateInstallationId && collection.privateInstallationId !== installationId) {
      throw authorizationDenied('当前 Agent 不能访问私有集合')
    }
    const [grant] = await tx<{ actions: string[] }[]>`
      select actions from agent_data_collection_grants
       where tenant_id = ${actor.tenantId} and collection_id = ${collectionId}
         and agent_installation_id = ${installationId}
       for share
    `
    if (!grant?.actions.includes(action)) throw authorizationDenied('当前 Agent 未获准执行该集合动作')
    return collection
  }
}
