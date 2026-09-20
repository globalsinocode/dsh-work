import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { toolBindingDigest, toManifestToolBinding } from '../../domain/tool-binding.ts'
import { PostgresToolConnectorService } from '../../modules/tool/postgres-tool-connector-service.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

/**
 * B-03 / I-04 平台工具绑定修订：
 *  - 首次解析按当前真实配置物化 active 修订；同摘要重复解析复用同一行；
 *  - 语义字段（连接器/端点/身份策略/授权范围等）漂移轮换新修订并取代旧行；
 *  - 停用工具撤销 active 修订；固定的 pin 在执行复核中拒绝撤销/取代/漂移/错配；
 *  - DSH Runtime 内生工具不产生绑定记录。
 */

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let service: PostgresToolConnectorService

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_tool_binding_test', maxConnections: 3 })
  database = throwaway.client
  service = new PostgresToolConnectorService(database)
})

after(async () => {
  await throwaway.dispose()
})

test('首次解析物化 active 修订，同摘要重复解析复用同一行', async () => {
  const [first] = await service.resolveToolBindings(['read@1.0.0'])
  assert.ok(first)
  assert.equal(first.tool, 'read@1.0.0')
  assert.equal(first.revision, 1)
  assert.equal(first.status, 'active')
  assert.match(first.bindingId, /^tool-binding-/)
  assert.match(first.digest, /^[a-f0-9]{64}$/)
  // 密钥值不进入解析结果：凭据槽位引用仅为标识。
  assert.equal(first.credentialRef, null)

  const [second] = await service.resolveToolBindings(['read@1.0.0'])
  assert.equal(second?.bindingId, first.bindingId)
  assert.equal(second?.revision, first.revision)

  const listed = await service.listToolBindings()
  assert.ok(listed.some(item => item.bindingId === first.bindingId && item.status === 'active'))
})

test('语义字段漂移轮换新修订并取代旧 active 行', async () => {
  const [before] = await service.resolveToolBindings(['glob@1.0.0'])
  assert.ok(before)

  // 授权范围是绑定语义字段：收窄角色应轮换修订而非原地改写。
  await service.updateToolPermissions({
    toolId: 'glob',
    allowedRoles: ['role-platform-admin'],
    dataScopes: ['workspace:authorized'],
    approvalPolicy: 'none',
    actor: 'U00008',
  })
  const [after] = await service.resolveToolBindings(['glob@1.0.0'])
  assert.ok(after)
  assert.notEqual(after.bindingId, before.bindingId)
  assert.equal(after.revision, before.revision + 1)
  assert.notEqual(after.digest, before.digest)

  const rows = (await service.listToolBindings()).filter(item => item.tool === 'glob@1.0.0')
  const oldRow = rows.find(item => item.bindingId === before.bindingId)
  assert.equal(oldRow?.status, 'superseded')
  assert.equal(rows.filter(item => item.status === 'active').length, 1)
})

test('执行复核拒绝被取代/漂移/错配的固定 pin，接受当前 active pin', async () => {
  const [stale] = await service.resolveToolBindings(['grep@1.0.0'])
  assert.ok(stale)
  const stalePin = toManifestToolBinding(stale)

  // 当前 active pin 通过复核。
  await service.assertActiveToolBindings([stalePin])

  // 语义漂移后旧 pin 被取代：行级状态与摘要比对双重拒绝。
  await service.updateToolPermissions({
    toolId: 'grep',
    allowedRoles: ['role-platform-admin'],
    dataScopes: ['enterprise:authorized'],
    approvalPolicy: 'none',
    actor: 'U00008',
  })
  await assert.rejects(service.assertActiveToolBindings([stalePin]), { code: 'permission_denied' })

  // 错配字段逐条拒绝：不存在的绑定行、错误修订号、伪造摘要。
  await assert.rejects(service.assertActiveToolBindings([{ ...stalePin, binding_id: 'tool-binding-missing' }]), { code: 'permission_denied' })
  const [current] = await service.resolveToolBindings(['grep@1.0.0'])
  assert.ok(current)
  await assert.rejects(service.assertActiveToolBindings([{ ...toManifestToolBinding(current), revision: current.revision + 1 }]), { code: 'permission_denied' })
  await assert.rejects(service.assertActiveToolBindings([{ ...toManifestToolBinding(current), digest: '0'.repeat(64) }]), { code: 'permission_denied' })
  // 错配工具版本（绑定行属于 read@1.0.0）同样拒绝。
  await assert.rejects(service.assertActiveToolBindings([{ ...toManifestToolBinding(current), tool: 'read@1.0.0' }]), { code: 'permission_denied' })
})

test('停用工具撤销 active 修订，复核与解析一并拒绝', async () => {
  const [binding] = await service.resolveToolBindings(['write@1.0.0'])
  assert.ok(binding)
  const pin = toManifestToolBinding(binding)

  await service.setToolStatus({ toolId: 'write', status: 'disabled', actor: 'U00008' })
  const rows = (await service.listToolBindings()).filter(item => item.tool === 'write@1.0.0')
  assert.equal(rows.find(item => item.bindingId === binding.bindingId)?.status, 'revoked')
  await assert.rejects(service.assertActiveToolBindings([pin]), { code: 'permission_denied' })
  await assert.rejects(service.resolveToolBindings(['write@1.0.0']), /已停用|无法解析绑定/)

  await service.setToolStatus({ toolId: 'write', status: 'available', actor: 'U00008' })
  const [restored] = await service.resolveToolBindings(['write@1.0.0'])
  assert.ok(restored)
  assert.equal(restored.status, 'active')
  assert.equal(restored.revision, binding.revision + 1)
})

test('DSH Runtime 内生工具不产生绑定记录；不存在/未发布的引用解析拒绝', async () => {
  const resolved = await service.resolveToolBindings(['activate_skill@1.0.0', 'python_execute@1.0.0'])
  assert.equal(resolved.length, 0)
  assert.equal((await service.listToolBindings()).every(item => !item.tool.startsWith('activate_skill@')), true)

  await assert.rejects(service.resolveToolBindings(['ghost.tool@1.0.0']), /无法解析绑定/)
})

test('凭据槽位标识入摘要、密钥值不入摘要：槽位轮换产生新修订，值轮换不产生', async () => {
  // toolBindingDigest 的输入只含 credentialRef 槽位标识——凭据值从不进入快照，
  // 因此密钥值轮换（槽位标识不变）不产生语义修订；槽位本身切换则产生。
  const base = {
    toolId: 'read', toolVersion: '1.0.0', connectorId: 'connector-dsh-workspace',
    executor: 'read', endpoint: 'dsh://workspace', credentialRef: 'cred-slot-a',
    identityPolicy: 'Runtime Manifest + Sandbox', environment: 'default',
    allowedRoleIds: ['role-employee'], dataScopes: ['workspace:authorized'],
    approvalPolicy: 'none',
  }
  assert.equal(toolBindingDigest(base), toolBindingDigest({ ...base }))
  assert.notEqual(toolBindingDigest(base), toolBindingDigest({ ...base, credentialRef: 'cred-slot-b' }))
  // 授权范围顺序不影响语义摘要。
  assert.equal(
    toolBindingDigest({ ...base, allowedRoleIds: ['role-employee', 'role-platform-admin'], dataScopes: ['a', 'b'] }),
    toolBindingDigest({ ...base, allowedRoleIds: ['role-platform-admin', 'role-employee'], dataScopes: ['b', 'a'] }),
  )
})
