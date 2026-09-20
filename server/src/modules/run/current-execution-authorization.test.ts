import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RuntimeManifest } from '../runtime/runtime-types.ts'
import { authorizationDenied } from '../authorization/authorization-errors.ts'
import { assertCurrentExecutionAuthorization, AuthorizationCheckUnavailableError } from './current-execution-authorization.ts'

type Port = Parameters<typeof assertCurrentExecutionAuthorization>[0]
const manifest = { workspace_id: 'ws-personal-u1', agent_version_id: 'agent-v1',
  user_context: { user_id: 'u1', tenant_id: 'tenant-dsh-work', role_ids: [] },
  skills: [{ id: 'selected', version: '1.0.0' }], data_scopes: ['scope:one'],
  input: { message: 'synthetic', file_mounts: [] },
} as unknown as RuntimeManifest
function ports(changes: Partial<Port> = {}): Port {
  const decision = { userId: 'u1', workspaceId: 'ws-personal-u1', roleIds: [], permissions: [], dataScopes: ['scope:one'], agentVersionId: 'agent-v1' }
  return {
    async workspaceTypeOf() { return 'personal' }, async authorizeRuntime() { return decision },
    async authorizeTeamRunExecution() { return decision },
    async requireAdminReader() { return { id: 'u1', displayName: '', department: '' } },
    async requirePlatformAdmin() { return { id: 'u1', displayName: '', department: '' } }, ...changes,
  }
}
test('personal checks exact Agent and extra Skill references without mutating the Manifest', async () => {
  const original = JSON.stringify(manifest)
  let count = 0
  const auth = ports()
  await assertCurrentExecutionAuthorization(ports({ async authorizeRuntime(input) {
    count++; assert.equal(input.agentVersionId, 'agent-v1')
    assert.deepEqual(input.additionalSkillReferences, ['selected@1.0.0'])
    return auth.authorizeRuntime(input)
  } }), undefined, manifest)
  assert.equal(count, 1); assert.equal(JSON.stringify(manifest), original)
})
test('team-specific membership gate is preserved', async () => {
  await assert.rejects(assertCurrentExecutionAuthorization(ports({ async workspaceTypeOf() { return 'team' },
    async authorizeTeamRunExecution() { throw authorizationDenied('removed') },
  }), undefined, manifest), { code: 'permission_denied' })
})
test('pinned scopes cannot survive revoked grants', async () => {
  const auth = ports()
  await assert.rejects(assertCurrentExecutionAuthorization(ports({ async authorizeRuntime(input) {
    return { ...await auth.authorizeRuntime(input), dataScopes: [] }
  } }), undefined, manifest), { code: 'permission_denied' })
})
test('missing space, removed files and missing input checker all fail closed', async () => {
  await assert.rejects(assertCurrentExecutionAuthorization(ports({ async workspaceTypeOf() { return null } }), undefined, manifest), { code: 'permission_denied' })
  const input = { ...manifest, input: { ...manifest.input, file_mounts: [{ file_id: 'file-1' }] as RuntimeManifest['input']['file_mounts'] } }
  await assert.rejects(assertCurrentExecutionAuthorization(ports(), undefined, input), AuthorizationCheckUnavailableError)
  await assert.rejects(assertCurrentExecutionAuthorization(ports(), { async recheckRuntimeFiles() { throw authorizationDenied('removed') } }, input), { code: 'permission_denied' })
})
test('infrastructure outage is distinguishable and never treated as a grant', async () => {
  await assert.rejects(assertCurrentExecutionAuthorization(ports({ async authorizeRuntime() { throw new Error('database unavailable') } }), undefined, manifest), AuthorizationCheckUnavailableError)
})
test('agent-release-trial is admin-side: platform-admin check, never workspace checks', async () => {
  const trial = { ...manifest, purpose: 'agent-release-trial', workspace_id: '', agent_version_id: 'draft-v1' } as RuntimeManifest
  let adminCalls = 0
  await assertCurrentExecutionAuthorization(ports({
    async requirePlatformAdmin() { adminCalls += 1; return { id: 'u1', displayName: '', department: '' } },
    async workspaceTypeOf() { throw new Error('must not reach workspace checks') },
  }), undefined, trial)
  assert.equal(adminCalls, 1)
})
test('automation purpose is workspace-bound: never reaches the admin branch', async () => {
  const automation = { ...manifest, purpose: 'automation' } as RuntimeManifest
  let runtimeCalls = 0
  await assertCurrentExecutionAuthorization(ports({
    async authorizeRuntime() { runtimeCalls += 1; return { userId: 'u1', workspaceId: 'ws-personal-u1', roleIds: [], permissions: [], dataScopes: ['scope:one'], agentVersionId: 'agent-v1' } },
    async requirePlatformAdmin() { throw new Error('automation is not an admin purpose') },
  }), undefined, automation)
  assert.equal(runtimeCalls, 1)
})

test('B-03/I-04: pinned tool bindings recheck before any purpose branch, fail-closed without a port', async () => {
  const pin = { tool: 'read@1.0.0', binding_id: 'tool-binding-1', revision: 1, digest: 'a'.repeat(64) }
  const pinned = { ...manifest, tool_bindings: [pin] } as RuntimeManifest
  // Manifest 声明了 pin 但复核端口未接线：不可用而非放行。
  await assert.rejects(assertCurrentExecutionAuthorization(ports(), undefined, pinned), AuthorizationCheckUnavailableError)
  // 管理目的分支同样在绑定复核之后：pin 失效在 requirePlatformAdmin 之前拒绝。
  const trial = { ...pinned, purpose: 'agent-release-trial', workspace_id: '', agent_version_id: 'draft-v1' } as RuntimeManifest
  await assert.rejects(assertCurrentExecutionAuthorization(ports(), undefined, trial), AuthorizationCheckUnavailableError)
  // 接线后 pin 逐条交回复核端口；拒绝即授权失败。
  let checked = 0
  const bindings = { async assertActiveToolBindings(pins: unknown) { checked++; assert.deepEqual(pins, [pin]) } }
  await assertCurrentExecutionAuthorization(ports(), undefined, pinned, bindings)
  assert.equal(checked, 1)
  const rejecting = { async assertActiveToolBindings() { throw authorizationDenied('revoked') } }
  await assert.rejects(assertCurrentExecutionAuthorization(ports(), undefined, pinned, rejecting), { code: 'permission_denied' })
  // 无 pin 的 Manifest 不触碰复核端口。
  await assertCurrentExecutionAuthorization(ports(), undefined, manifest, rejecting)
})
