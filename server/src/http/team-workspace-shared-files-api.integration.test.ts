import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'

import type { RequestIdentity } from '../modules/identity/types.ts'
import { PostgresAuthorizationService } from '../modules/authorization/postgres-authorization-service.ts'
import { AuthorizationDeniedError, isAuthorizationDenial } from '../modules/authorization/authorization-errors.ts'
import type { DatabaseClient } from '../infrastructure/postgres/database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../infrastructure/postgres/test-database.ts'
import { PostgresContentService } from '../modules/workbench/application/postgres-content-service.ts'
import { PostgresRunRepository } from '../modules/run/postgres-run-repository.ts'
import { PostgresWorkspaceMemberService } from '../modules/workbench/application/postgres-workspace-member-service.ts'
import { Router, classifyHttpError } from './router.ts'
import { registerContentRoutes } from './workbench/content-routes.ts'

const tenantId = 'tenant-dsh-work'

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let authorization: PostgresAuthorizationService
let content: PostgresContentService
let workspaceMembers: PostgresWorkspaceMemberService
let server: ReturnType<typeof createServer>
let baseUrl = ''
let storageRoot = ''

before(async () => {
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_shared_files_api_test', maxConnections: 8 })
  database = throwaway.client
  // 本套件只验证列表/移除/下载门禁，不需要真实解析：给一个临时存储根即可。
  storageRoot = await mkdtemp(join(tmpdir(), 'dsh-work-shared-files-'))
  authorization = new PostgresAuthorizationService(database)
  content = new PostgresContentService(database, storageRoot, authorization)
  workspaceMembers = new PostgresWorkspaceMemberService(database, authorization)
  const router = new Router({ authenticateApi: testApiAuthenticator })
  registerContentRoutes(router, content, authorization)
  server = createServer((request, response) => void router.handle(request, response))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
})

after(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  await throwaway.dispose()
})

// ---------------------------------------------------------------------------
// 共享文件列表与逻辑移除（1B-T3）
// ---------------------------------------------------------------------------

test('共享文件列表支持名称搜索与游标分页，且不含已移除文件', async () => {
  const workspaceId = 'ws-files-list'
  const ownerId = `${workspaceId}-owner`
  await seedUser(ownerId, '文件负责人')
  await seedTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  for (const index of [1, 2, 3]) {
    await seedFile({
      id: `${workspaceId}-f${index}`,
      workspaceId,
      name: `巡检记录-${index}.xlsx`,
      uploadedBy: ownerId,
      createdAt: `2026-09-0${index}T00:00:00.000Z`,
    })
  }
  await seedFile({ id: `${workspaceId}-other`, workspaceId, name: '无关文件.pdf', uploadedBy: ownerId, createdAt: '2026-09-05T00:00:00.000Z' })
  const removed = `${workspaceId}-removed`
  await seedFile({ id: removed, workspaceId, name: '巡检记录-移除.xlsx', uploadedBy: ownerId, createdAt: '2026-09-06T00:00:00.000Z' })
  await database`update file_objects set removed_at = now() where tenant_id = ${tenantId} and id = ${removed}`

  const filtered = await content.listWorkspaceFiles({ workspaceId, actorUserId: ownerId, query: '巡检记录' })
  assert.deepEqual(filtered.items.map(item => item.id), [`${workspaceId}-f3`, `${workspaceId}-f2`, `${workspaceId}-f1`])

  const first = await content.listWorkspaceFiles({ workspaceId, actorUserId: ownerId, limit: 2 })
  assert.equal(first.items.length, 2)
  assert.ok(first.nextCursor, '还有更多时返回游标')
  const second = await content.listWorkspaceFiles({ workspaceId, actorUserId: ownerId, limit: 2, cursor: first.nextCursor ?? undefined })
  const seen = [...first.items, ...second.items].map(item => item.id)
  assert.equal(new Set(seen).size, 4, '两页覆盖全部 4 个未移除文件且不重复')
  assert.equal(second.nextCursor, null, '到末尾不再返回游标')
})

test('可选动作由服务端按角色判定：负责人可移除全部，成员仅自己上传的，只读成员不可移除', async () => {
  const workspaceId = 'ws-files-perms'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  const viewerId = `${workspaceId}-viewer`
  await seedUser(ownerId, '权限负责人')
  await seedUser(memberId, '权限成员')
  await seedUser(viewerId, '权限只读')
  await seedTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
    { userId: viewerId, role: 'viewer' },
  ])
  await seedFile({ id: `${workspaceId}-by-owner`, workspaceId, name: '负责人上传.xlsx', uploadedBy: ownerId, createdAt: '2026-09-01T00:00:00.000Z' })
  await seedFile({ id: `${workspaceId}-by-member`, workspaceId, name: '成员上传.xlsx', uploadedBy: memberId, createdAt: '2026-09-02T00:00:00.000Z' })

  const asOwner = await content.listWorkspaceFiles({ workspaceId, actorUserId: ownerId })
  assert.deepEqual(asOwner.items.map(item => [item.id, item.removable]), [
    [`${workspaceId}-by-member`, true],
    [`${workspaceId}-by-owner`, true],
  ], '负责人可移除两个文件')

  const asMember = await content.listWorkspaceFiles({ workspaceId, actorUserId: memberId })
  assert.deepEqual(asMember.items.map(item => [item.id, item.removable]), [
    [`${workspaceId}-by-member`, true],
    [`${workspaceId}-by-owner`, false],
  ])

  const asViewer = await content.listWorkspaceFiles({ workspaceId, actorUserId: viewerId })
  assert.equal(asViewer.items.every(item => item.removable), false, '只读成员不可移除任何文件')
  assert.equal(asViewer.items.every(item => item.canDownload), true, '只读成员仍可下载')

  await assert.rejects(
    content.removeWorkspaceFile(workspaceId, `${workspaceId}-by-owner`, memberId),
    /只有负责人、管理员或上传人本人/,
  )
  await assert.rejects(
    content.removeWorkspaceFile(workspaceId, `${workspaceId}-by-member`, viewerId),
    /只有负责人、管理员或上传人本人/,
  )
})

test('逻辑移除保留对象与历史引用，旧 ID 下载被拒绝', async () => {
  const workspaceId = 'ws-files-remove'
  const ownerId = `${workspaceId}-owner`
  await seedUser(ownerId, '移除负责人')
  await seedTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  const fileId = `${workspaceId}-file`
  await seedFile({ id: fileId, workspaceId, name: '待移除.xlsx', uploadedBy: ownerId })
  // 历史 Run 引用该文件，移除后必须仍可追溯。
  const sessionId = `${workspaceId}-session`
  await database`
    insert into sessions (id, tenant_id, workspace_id, created_by, agent_version_id, title, status)
    values (${sessionId}, ${tenantId}, ${workspaceId}, ${ownerId}, 'agent-version-dsh-work-assistant-1', '历史会话', 'active')
  `
  const runId = `${workspaceId}-run`
  const attemptId = `${runId}-attempt`
  // runs.current_attempt_id 有可延迟外键，两行必须在同一事务内提交。
  await database.begin(async transaction => {
    await transaction`
      insert into runs (id, tenant_id, session_id, requested_by, idempotency_key, status, current_attempt_id)
      values (${runId}, ${tenantId}, ${sessionId}, ${ownerId}, ${`idem-${runId}`}, 'succeeded', ${attemptId})
    `
    await transaction`
      insert into run_attempts (id, tenant_id, run_id, attempt_no, runtime_id, manifest, manifest_sha256, model_route_snapshot, status)
      values (${attemptId}, ${tenantId}, ${runId}, 1, 'runtime-local-01', ${database.json({})}, 'x', ${database.json({})}, 'succeeded')
    `
  })
  const extractionId = `${runId}-extraction`
  await database`
    insert into file_extractions (
      id, tenant_id, file_id, extractor_version, detected_type, status,
      text_storage_key, text_sha256, character_count, created_at
    ) values (
      ${extractionId}, ${tenantId}, ${fileId}, 'v1', 'xlsx', 'succeeded',
      ${`storage/${extractionId}.txt`}, ${'b'.repeat(64)}, 12, now()
    )
  `
  await database`
    insert into run_input_files (id, tenant_id, run_id, attempt_id, file_id, extraction_id, mount_path)
    values (${`${runId}-input`}, ${tenantId}, ${runId}, ${attemptId}, ${fileId}, ${extractionId}, '/workspace/input/待移除.txt')
  `

  const removed = await content.removeWorkspaceFile(workspaceId, fileId, ownerId)
  assert.deepEqual(removed, { id: fileId, removed: true })

  // 对象仍在，历史引用仍在。
  const [row] = await database<{ removedAt: Date | null; count: number }[]>`
    select f.removed_at as "removedAt",
           (select count(*)::integer from run_input_files rif
             where rif.tenant_id = f.tenant_id and rif.file_id = f.id) as count
      from file_objects f where f.tenant_id = ${tenantId} and f.id = ${fileId}
  `
  assert.ok(row?.removedAt, '保留移除时间戳')
  assert.equal(row?.count, 1, '历史 Run 的文件引用保留')

  // 列表不再出现，旧 ID 下载被拒绝。
  const listed = await content.listWorkspaceFiles({ workspaceId, actorUserId: ownerId })
  assert.equal(listed.items.some(item => item.id === fileId), false)
  await assert.rejects(content.readFile(fileId, ownerId), /文件不存在或不可访问/)

  // 已移除文件的重复移除是幂等的。
  assert.deepEqual(await content.removeWorkspaceFile(workspaceId, fileId, ownerId), { id: fileId, removed: true })
})

test('非成员与个人空间不能列出或移除共享文件', async () => {
  const workspaceId = 'ws-files-access'
  const ownerId = `${workspaceId}-owner`
  const outsiderId = `${workspaceId}-outsider`
  await seedUser(ownerId, '访问文件负责人')
  await seedUser(outsiderId, '访问文件外部人')
  await seedTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  await seedFile({ id: `${workspaceId}-file`, workspaceId, name: '共享.xlsx', uploadedBy: ownerId })

  await assert.rejects(
    content.listWorkspaceFiles({ workspaceId, actorUserId: outsiderId }),
    /工作空间不存在、已归档或当前用户无权访问/,
  )

  const personalUserId = 'user-files-personal'
  await seedUser(personalUserId, '文件个人空间用户')
  const personalWorkspaceId = `ws-personal-${personalUserId}`
  await assert.rejects(
    content.listWorkspaceFiles({ workspaceId: personalWorkspaceId, actorUserId: personalUserId }),
    /仅支持团队工作空间/,
  )
})

// ---------------------------------------------------------------------------
// 文件与结果读取收权（1B-T4 / AC-09；个人空间 AC-23）
// ---------------------------------------------------------------------------

test('被移出团队的成员不能再下载团队会话文件，现任成员可读共享会话附件（TW-10）', async () => {
  const workspaceId = 'ws-revoke-file'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  const currentId = `${workspaceId}-current`
  await seedUser(ownerId, '收权负责人')
  await seedUser(memberId, '收权成员')
  await seedUser(currentId, '收权现任成员')
  await seedTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
    { userId: currentId, role: 'member' },
  ])
  const sessionId = await seedSession(workspaceId, memberId)
  const fileId = `${workspaceId}-session-file`
  await seedStoredFile({
    id: fileId, workspaceId, sessionId, uploadedBy: memberId, name: '巡检结论.txt', content: '团队会话文件正文',
  })

  // 移除前：本人（会话作者）可下载，同时让授权缓存进入已授予状态，以便验证成员
  // 变更后的撤权修订号能立即失效缓存，而不是靠 TTL 过期。
  assert.equal((await content.readFile(fileId, memberId)).bytes.toString('utf8'), '团队会话文件正文')
  // TW-10 共享会话：附件随会话对空间现任成员可读。
  assert.equal((await content.readFile(fileId, currentId)).bytes.toString('utf8'), '团队会话文件正文')

  await workspaceMembers.removeMember(workspaceId, memberId, ownerId)

  await assert.rejects(content.readFile(fileId, memberId), /文件不存在或不可访问/)

  // 空间共享文件（session_id 为空）对现任成员保持可下载——收权检查不能过宽。
  const sharedFileId = `${workspaceId}-shared-file`
  await seedFile({ id: sharedFileId, workspaceId, name: '共享巡检.txt', uploadedBy: ownerId })
  await storeSharedFileBytes(sharedFileId, '共享正文')
  assert.equal((await content.readFile(sharedFileId, currentId)).bytes.toString('utf8'), '共享正文')
  assert.equal((await content.readFile(sharedFileId, ownerId)).bytes.toString('utf8'), '共享正文')
})

test('主动退出团队的成员同样不能下载团队文件与成果', async () => {
  const workspaceId = 'ws-exit-file'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  await seedUser(ownerId, '退出负责人')
  await seedUser(memberId, '退出成员')
  await seedTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
  ])
  const sessionId = await seedSession(workspaceId, memberId)
  const fileId = `${workspaceId}-session-file`
  await seedStoredFile({
    id: fileId, workspaceId, sessionId, uploadedBy: memberId, name: '退出前文件.txt', content: '退出前正文',
  })
  const runId = await seedRun(sessionId, memberId)
  const artifactId = `${workspaceId}-artifact`
  await seedArtifact({ artifactId, workspaceId, sessionId, createdBy: memberId, fileId, runId })

  assert.equal(await content.artifactFileId(artifactId, 1, memberId), fileId)

  await workspaceMembers.exitWorkspace(workspaceId, memberId)

  await assert.rejects(content.readFile(fileId, memberId), /文件不存在或不可访问/)
  await assert.rejects(content.artifactFileId(artifactId, undefined, memberId), /Artifact 不存在或不可访问/)
})

test('被移出团队的成员不能再下载本人团队成果与历史版本，现任成员的成果不受影响', async () => {
  const workspaceId = 'ws-revoke-artifact'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  const currentId = `${workspaceId}-current`
  await seedUser(ownerId, '成果负责人')
  await seedUser(memberId, '成果成员')
  await seedUser(currentId, '成果现任成员')
  await seedTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
    { userId: currentId, role: 'member' },
  ])
  const sessionId = await seedSession(workspaceId, memberId)
  const runId = await seedRun(sessionId, memberId)
  const fileId = `${workspaceId}-artifact-file`
  await seedStoredFile({
    id: fileId, workspaceId, sessionId, uploadedBy: memberId, name: '成果.txt', content: '成果正文',
  })
  const artifactId = `${workspaceId}-artifact`
  await seedArtifact({ artifactId, workspaceId, sessionId, createdBy: memberId, fileId, runId })

  // 现任成员（成果作者）在移除前可下载 artifact 与指定版本（检查不能过宽）。
  assert.equal(await content.artifactFileId(artifactId, undefined, memberId), fileId)
  assert.equal(await content.artifactFileId(artifactId, 1, memberId), fileId)
  assert.equal(
    (await content.readFile(await content.artifactFileId(artifactId, 1, memberId), memberId)).bytes.toString('utf8'),
    '成果正文',
  )

  // 同一成员的个人空间成果：用于验证成果列表在失权后只过滤团队成果（AC-23）。
  const personalWorkspace = `ws-personal-${memberId}`
  const personalSession = await seedSession(personalWorkspace, memberId)
  const personalRun = await seedRun(personalSession, memberId)
  const personalFile = `${personalWorkspace}-file`
  await seedStoredFile({
    id: personalFile, workspaceId: personalWorkspace, sessionId: personalSession, uploadedBy: memberId, name: '个人成果.txt', content: '个人正文',
  })
  const personalArtifact = `${personalWorkspace}-artifact`
  await seedArtifact({
    artifactId: personalArtifact, workspaceId: personalWorkspace, sessionId: personalSession, createdBy: memberId,
    fileId: personalFile, runId: personalRun,
  })
  assert.deepEqual(
    new Set((await content.listArtifacts(memberId)).map(artifact => artifact.id)),
    new Set([artifactId, personalArtifact]),
    '失权前团队成果与个人成果都可见',
  )

  await workspaceMembers.removeMember(workspaceId, memberId, ownerId)

  await assert.rejects(content.artifactFileId(artifactId, undefined, memberId), /Artifact 不存在或不可访问/)
  await assert.rejects(content.artifactFileId(artifactId, 1, memberId), /Artifact 不存在或不可访问/)
  // 失权成员命中 artifact 的旧文件 ID 也必须被拒绝（artifactFileId → readFile 双重口径）。
  await assert.rejects(content.readFile(fileId, memberId), /文件不存在或不可访问/)
  // 失权后：团队成果不再返回，同一成员的个人成果保留。
  assert.deepEqual(
    (await content.listArtifacts(memberId)).map(artifact => artifact.id),
    [personalArtifact],
    '被移出成员的团队成果不再返回，个人成果保留',
  )

  // TW-10 共享会话：另一名现任成员能看到并下载共享会话中的全部成果；
  // 被移出成员的成果不因空间仍在而对**他自己**放行（上方已断言）。
  const currentSession = await seedSession(workspaceId, currentId)
  const currentRun = await seedRun(currentSession, currentId)
  const currentFile = `${workspaceId}-current-file`
  await seedStoredFile({
    id: currentFile, workspaceId, sessionId: currentSession, uploadedBy: currentId, name: '现任成果.txt', content: '现任正文',
  })
  const currentArtifact = `${workspaceId}-current-artifact`
  await seedArtifact({
    artifactId: currentArtifact, workspaceId, sessionId: currentSession, createdBy: currentId, fileId: currentFile, runId: currentRun,
  })
  assert.equal(await content.artifactFileId(currentArtifact, 1, currentId), currentFile)
  // 成员也可读其他成员共享会话产出的成果。
  assert.equal(await content.artifactFileId(artifactId, 1, currentId), fileId)
  assert.deepEqual(
    new Set((await content.listArtifacts(currentId)).map(artifact => artifact.id)),
    new Set([artifactId, currentArtifact]),
    '成员可见同一空间共享会话的全部成果',
  )
})

test('Run 输入挂载：同空间共享会话附件可挂（TW-10），跨空间与个人会话附件仍拒绝', async () => {
  const workspaceId = 'ws-mount-scope'
  const ownerId = `${workspaceId}-owner`
  const authorId = `${workspaceId}-author`
  const otherId = `${workspaceId}-other`
  await seedUser(ownerId, '挂载负责人')
  await seedUser(authorId, '挂载作者')
  await seedUser(otherId, '挂载他人')
  await seedTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: authorId, role: 'member' },
    { userId: otherId, role: 'member' },
  ])

  // TW-10 共享会话：author 的会话附件对同一空间的现任成员可挂载。
  const authorSession = await seedSession(workspaceId, authorId)
  const sessionFileId = `${workspaceId}-session-file`
  await seedStoredFile({
    id: sessionFileId, workspaceId, sessionId: authorSession, uploadedBy: authorId, name: '共享会话附件.txt', content: '共享会话附件正文',
  })
  await seedExtraction(sessionFileId, '共享会话附件解析正文')

  const otherSession = await seedSession(workspaceId, otherId)
  for (const actorId of [otherId, ownerId]) {
    const mountedShared = await content.prepareRuntimeFiles({ sessionId: otherSession, fileIds: [sessionFileId], userId: actorId })
    assert.equal(mountedShared.length, 1, `${actorId} 可挂载同一空间共享会话的附件（TW-10）`)
  }

  // 跨空间会话附件仍拒绝：另一个团队空间的会话附件不属于本空间共享讨论。
  const foreignWorkspaceId = 'ws-mount-scope-foreign'
  await seedTeamWorkspace(foreignWorkspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: authorId, role: 'member' },
  ])
  const foreignSession = await seedSession(foreignWorkspaceId, authorId)
  const foreignFileId = `${workspaceId}-foreign-file`
  await seedStoredFile({
    id: foreignFileId, workspaceId: foreignWorkspaceId, sessionId: foreignSession, uploadedBy: authorId, name: '跨空间.txt', content: '跨空间正文',
  })
  await seedExtraction(foreignFileId, '跨空间解析正文')
  const foreignDenial = await content.prepareRuntimeFiles({ sessionId: otherSession, fileIds: [foreignFileId], userId: otherId })
    .then(() => null, (error: unknown) => error)
  assert.ok(foreignDenial instanceof AuthorizationDeniedError, '跨空间会话附件挂载必须是类型化授权拒绝')
  assert.match(foreignDenial.message, /不存在、不可访问或解析未成功/)

  // 个人空间会话附件仍属私有：非作者不得挂载。
  const personalWorkspaceId = `ws-personal-${authorId}`
  const personalSession = await seedSession(personalWorkspaceId, authorId)
  const personalFileId = `${workspaceId}-personal-file`
  await seedStoredFile({
    id: personalFileId, workspaceId: personalWorkspaceId, sessionId: personalSession, uploadedBy: authorId, name: '个人.txt', content: '个人正文',
  })
  await seedExtraction(personalFileId, '个人解析正文')
  const personalDenial = await content.prepareRuntimeFiles({ sessionId: otherSession, fileIds: [personalFileId], userId: otherId })
    .then(() => null, (error: unknown) => error)
  assert.ok(personalDenial instanceof AuthorizationDeniedError, '个人会话附件挂载必须是类型化授权拒绝')
  assert.match(personalDenial.message, /不存在、不可访问或解析未成功/)

  const authorOwn = await content.prepareRuntimeFiles({ sessionId: authorSession, fileIds: [sessionFileId], userId: authorId })
  assert.equal(authorOwn.length, 1, '作者本人仍可挂载自己的会话附件')

  // 作者把**自己另一个会话**的附件挂进自己的新会话：既有行为，保持可用（AC-23）。
  const authorSecondSession = await seedSession(workspaceId, authorId)
  const crossSession = await content.prepareRuntimeFiles({
    sessionId: authorSecondSession, fileIds: [sessionFileId], userId: authorId,
  })
  assert.equal(crossSession.length, 1, '本人跨会话附件仍可挂载')

  // 空间共享文件（session_id 为空）：现任成员可挂载。
  const sharedFileId = `${workspaceId}-shared-mount`
  await seedFile({ id: sharedFileId, workspaceId, name: '共享挂载.txt', uploadedBy: ownerId })
  await seedExtraction(sharedFileId, '共享解析正文')
  const mounted = await content.prepareRuntimeFiles({ sessionId: otherSession, fileIds: [sharedFileId], userId: otherId })
  assert.equal(mounted.length, 1, '空间共享文件对现任成员保持可挂载')
})

test('归档空间：共享文件列表仍可读，但会话附件上传与共享文件上传仍被拒绝', async () => {
  const workspaceId = 'ws-archived-file-write'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  await seedUser(ownerId, '归档文件负责人')
  await seedUser(memberId, '归档文件成员')
  await seedTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }, { userId: memberId, role: 'member' }])
  const sessionId = await seedSession(workspaceId, memberId)
  const sharedFileId = `${workspaceId}-shared`
  await seedFile({ id: sharedFileId, workspaceId, name: '归档共享.txt', uploadedBy: ownerId })

  await database`
    update workspaces set status = 'archived' where tenant_id = ${tenantId} and id = ${workspaceId}
  `

  // 读取轨（P1-1）：路由闸门此前仍在执行轨，归档现任成员在路由层被 403，
  // 服务层读轨代码不可达；服务层直调测试给了假绿。这里必须走真实 HTTP。
  const list = await fetch(`${baseUrl}/api/workbench/v1/workspaces/${workspaceId}/files`, {
    headers: { 'x-test-user-id': memberId },
  })
  assert.equal(list.status, 200, '归档空间的共享文件列表对现任成员必须可读')
  const listed = await list.json() as { data: { items: Array<{ id: string }> } }
  const sharedRow = listed.data.items.find(item => item.id === sharedFileId)
  assert.ok(sharedRow, '归档空间应能列出共享文件')
  // 可移除属执行轨：归档空间必须回报 removable=false，否则前端渲染必然失败的入口。
  // 断言必须用**本来有权移除的视角**（上传人/负责人）才具鉴别力：若用普通成员看他人上传的
  // 文件，removable 因「非上传人」就已是 false，即使归档判断被删掉也照样通过（验证代理 D2）。
  const asOwnerList = await fetch(`${baseUrl}/api/workbench/v1/workspaces/${workspaceId}/files`, {
    headers: { 'x-test-user-id': ownerId },
  })
  assert.equal(asOwnerList.status, 200)
  const ownerRow = (await asOwnerList.json() as { data: { items: Array<{ id: string; removable?: boolean }> } })
    .data.items.find(item => item.id === sharedFileId)
  assert.equal(ownerRow?.removable, false, '归档空间即使对负责人也必须 removable=false（否则断言不具鉴别力）')

  // 执行轨（P1-2）：上传属写操作，归档空间必须拒绝——此前会话附件上传返回 201。
  const upload = await fetch(`${baseUrl}/api/workbench/v1/sessions/${sessionId}/files`, {
    method: 'POST',
    headers: {
      'x-test-user-id': memberId,
      'x-file-name': encodeURIComponent('归档后仍可上传.txt'),
      'content-type': 'text/plain',
    },
    body: 'archived upload attempt',
  })
  assert.equal(upload.status, 403, '归档空间不得上传会话附件')

  const sharedUpload = await fetch(`${baseUrl}/api/workbench/v1/workspaces/${workspaceId}/files`, {
    method: 'POST',
    headers: {
      'x-test-user-id': memberId,
      'x-file-name': encodeURIComponent('归档后共享上传.txt'),
      'content-type': 'text/plain',
    },
    body: 'archived shared upload attempt',
  })
  assert.equal(sharedUpload.status, 403, '归档空间不得上传共享文件')
})

test('个人空间作者的文件与成果下载保持现状（AC-23）', async () => {
  const userId = 'user-personal-read'
  await seedUser(userId, '个人空间作者')
  // users 触发器已自动开通个人空间（migration 0013）。
  const workspaceId = `ws-personal-${userId}`
  const sessionId = await seedSession(workspaceId, userId)
  const fileId = `${workspaceId}-file`
  await seedStoredFile({
    id: fileId, workspaceId, sessionId, uploadedBy: userId, name: '个人文件.txt', content: '个人文件正文',
  })
  const runId = await seedRun(sessionId, userId)
  const artifactId = `${workspaceId}-artifact`
  await seedArtifact({ artifactId, workspaceId, sessionId, createdBy: userId, fileId, runId })

  assert.equal((await content.readFile(fileId, userId)).bytes.toString('utf8'), '个人文件正文')
  assert.equal(await content.artifactFileId(artifactId, undefined, userId), fileId)
  assert.equal(await content.artifactFileId(artifactId, 1, userId), fileId)
  const listed = await content.listArtifacts(userId)
  assert.deepEqual(listed.map(artifact => artifact.id), [artifactId])
})

test('下载接口在失权后返回 403，且与不存在同口径不泄露对象存在性', async () => {
  const workspaceId = 'ws-revoke-http'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  await seedUser(ownerId, '接口负责人')
  await seedUser(memberId, '接口成员')
  await seedTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
  ])
  const sessionId = await seedSession(workspaceId, memberId)
  const fileId = `${workspaceId}-file`
  await seedStoredFile({
    id: fileId, workspaceId, sessionId, uploadedBy: memberId, name: '接口文件.txt', content: '接口正文',
  })
  const runId = await seedRun(sessionId, memberId)
  const artifactId = `${workspaceId}-artifact`
  await seedArtifact({ artifactId, workspaceId, sessionId, createdBy: memberId, fileId, runId })

  const beforeRemoval = await fetch(`${baseUrl}/api/workbench/v1/files/${fileId}/download`, {
    headers: { 'x-test-user-id': memberId },
  })
  assert.equal(beforeRemoval.status, 200)

  await workspaceMembers.removeMember(workspaceId, memberId, ownerId)

  const fileResponse = await fetch(`${baseUrl}/api/workbench/v1/files/${fileId}/download`, {
    headers: { 'x-test-user-id': memberId },
  })
  assert.equal(fileResponse.status, 403)
  assert.match(await fileResponse.text(), /文件不存在或不可访问/)

  const artifactResponse = await fetch(`${baseUrl}/api/workbench/v1/artifacts/${artifactId}/download`, {
    headers: { 'x-test-user-id': memberId },
  })
  assert.equal(artifactResponse.status, 403)
  assert.match(await artifactResponse.text(), /Artifact 不存在或不可访问/)
})

test('归档团队空间：现任成员仍可读文件/成果/列表，非成员仍拒绝（3-T1 读取轨）', async () => {
  const workspaceId = 'ws-archived-read'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  const outsiderId = `${workspaceId}-outsider`
  await seedUser(ownerId, '归档负责人')
  await seedUser(memberId, '归档成员')
  await seedUser(outsiderId, '归档外部人')
  await seedTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
  ])
  const sessionId = await seedSession(workspaceId, memberId)
  const fileId = `${workspaceId}-session-file`
  await seedStoredFile({
    id: fileId, workspaceId, sessionId, uploadedBy: memberId, name: '归档前文件.txt', content: '归档前正文',
  })
  const sharedFileId = `${workspaceId}-shared-file`
  await seedFile({ id: sharedFileId, workspaceId, name: '归档共享.txt', uploadedBy: ownerId })
  await storeSharedFileBytes(sharedFileId, '共享正文')
  const runId = await seedRun(sessionId, memberId)
  const artifactId = `${workspaceId}-artifact`
  await seedArtifact({ artifactId, workspaceId, sessionId, createdBy: memberId, fileId, runId })

  // 归档前先读一次，把授权缓存预热到「已授予」——归档不提升 team_auth_revision，
  // 因此读取轨不得依赖缓存 TTL 才能放行。
  assert.equal((await content.readFile(fileId, memberId)).bytes.toString('utf8'), '归档前正文')
  assert.equal(await content.artifactFileId(artifactId, 1, memberId), fileId)

  await archiveWorkspace(workspaceId)

  // 归档=只读保留：现任成员（这里覆盖负责人与普通成员）仍可读文件与成果。
  // 共享文件（session_id 为空）对空间现任成员可读；他人私有会话附件仍不可读
  // （与「他人私有对话不得读取」一致，归档不放宽）。
  assert.equal((await content.readFile(sharedFileId, ownerId)).bytes.toString('utf8'), '共享正文')
  assert.equal((await content.readFile(fileId, memberId)).bytes.toString('utf8'), '归档前正文')
  assert.equal(await content.artifactFileId(artifactId, undefined, memberId), fileId)
  const artifacts = await content.listArtifacts(memberId)
  assert.deepEqual(artifacts.map(artifact => artifact.id), [artifactId], '归档空间成果仍出现在列表')
  const files = await content.listWorkspaceFiles({ workspaceId, actorUserId: memberId })
  assert.deepEqual(files.items.map(item => item.id), [sharedFileId], '归档空间共享文件列表仍可读')

  // HTTP 下载同样走读取轨。
  const fileResponse = await fetch(`${baseUrl}/api/workbench/v1/files/${fileId}/download`, {
    headers: { 'x-test-user-id': memberId },
  })
  assert.equal(fileResponse.status, 200)
  assert.equal(await fileResponse.text(), '归档前正文')

  const artifactResponse = await fetch(`${baseUrl}/api/workbench/v1/artifacts/${artifactId}/download`, {
    headers: { 'x-test-user-id': memberId },
  })
  assert.equal(artifactResponse.status, 200)

  // 非成员仍拒绝，且不可枚举（与「不存在」同文案）。
  // 5-T4：这条「不存在或不可访问」的拒绝已类型化，HTTP 仍是 403 permission_denied。
  const fileDenial = await content.readFile(fileId, outsiderId).then(() => null, (error: unknown) => error)
  assert.ok(fileDenial instanceof AuthorizationDeniedError, `必须是类型化授权拒绝，实际：${String(fileDenial)}`)
  assert.equal(fileDenial.status, 403)
  assert.equal(fileDenial.code, 'permission_denied')
  assert.match(fileDenial.message, /文件不存在或不可访问/)
  assert.equal(isAuthorizationDenial(fileDenial), true, '类型化后撤权分类器必须识别')
  assert.equal(classifyHttpError(fileDenial, `/api/workbench/v1/files/${fileId}/download`).status, 403)

  const artifactDenial = await content.artifactFileId(artifactId, undefined, outsiderId)
    .then(() => null, (error: unknown) => error)
  assert.ok(artifactDenial instanceof AuthorizationDeniedError, `必须是类型化授权拒绝，实际：${String(artifactDenial)}`)
  assert.equal(artifactDenial.status, 403)
  assert.equal(artifactDenial.code, 'permission_denied')
  assert.match(artifactDenial.message, /Artifact 不存在或不可访问/)

  // 接口层复核：类型化后响应仍是 403 + permission_denied（状态码与 code 均不变）。
  const outsiderFileResponse = await fetch(`${baseUrl}/api/workbench/v1/files/${fileId}/download`, {
    headers: { 'x-test-user-id': outsiderId },
  })
  assert.equal(outsiderFileResponse.status, 403)
  assert.equal(
    ((await outsiderFileResponse.json()) as { error?: { code?: string } }).error?.code,
    'permission_denied',
  )
  const outsiderArtifactResponse = await fetch(`${baseUrl}/api/workbench/v1/artifacts/${artifactId}/download`, {
    headers: { 'x-test-user-id': outsiderId },
  })
  assert.equal(outsiderArtifactResponse.status, 403)
  assert.equal(
    ((await outsiderArtifactResponse.json()) as { error?: { code?: string } }).error?.code,
    'permission_denied',
  )

  assert.deepEqual(await content.listArtifacts(outsiderId), [], '非成员看不到归档空间成果')
  await assert.rejects(
    content.listWorkspaceFiles({ workspaceId, actorUserId: outsiderId }),
    /工作空间不存在、已归档或当前用户无权访问/,
  )
})

test('归档团队空间：被移出的成员读取文件/成果仍拒绝（AC-09 不因归档放宽）', async () => {
  const workspaceId = 'ws-archived-read-revoked'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  await seedUser(ownerId, '归档收权负责人')
  await seedUser(memberId, '归档收权成员')
  await seedTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
  ])
  const sessionId = await seedSession(workspaceId, memberId)
  const fileId = `${workspaceId}-session-file`
  await seedStoredFile({
    id: fileId, workspaceId, sessionId, uploadedBy: memberId, name: '归档收权.txt', content: '归档收权正文',
  })
  const runId = await seedRun(sessionId, memberId)
  const artifactId = `${workspaceId}-artifact`
  await seedArtifact({ artifactId, workspaceId, sessionId, createdBy: memberId, fileId, runId })

  await archiveWorkspace(workspaceId)
  await database`
    delete from workspace_members
     where tenant_id = ${tenantId} and workspace_id = ${workspaceId} and user_id = ${memberId}
  `

  await assert.rejects(content.readFile(fileId, memberId), /文件不存在或不可访问/)
  await assert.rejects(content.artifactFileId(artifactId, undefined, memberId), /Artifact 不存在或不可访问/)
  assert.deepEqual(await content.listArtifacts(memberId), [], '被移出成员不得再从成果列表读回归档空间成果')
  await assert.rejects(
    content.listWorkspaceFiles({ workspaceId, actorUserId: memberId }),
    /工作空间不存在、已归档或当前用户无权访问/,
  )
})

test('归档团队空间：上传与移除文件仍走执行轨被拒绝（3-T1 执行轨）', async () => {
  const workspaceId = 'ws-archived-write'
  const ownerId = `${workspaceId}-owner`
  await seedUser(ownerId, '归档写入负责人')
  await seedTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  const fileId = `${workspaceId}-file`
  await seedFile({ id: fileId, workspaceId, name: '待移除.txt', uploadedBy: ownerId })
  await archiveWorkspace(workspaceId)

  await assert.rejects(
    content.storeWorkspaceFile(workspaceId, '上传.txt', 'text/plain', Buffer.from('上传正文'), ownerId),
    /工作空间不存在、已归档或当前用户无权访问/,
  )
  await assert.rejects(
    content.removeWorkspaceFile(workspaceId, fileId, ownerId),
    /工作空间不存在、已归档或当前用户无权访问/,
  )
  // HTTP 上传端点同样拒绝，确认路由层没有绕过服务层的执行轨判定。
  const upload = await fetch(`${baseUrl}/api/workbench/v1/workspaces/${workspaceId}/files`, {
    method: 'POST',
    headers: { 'x-test-user-id': ownerId, 'x-file-name': encodeURIComponent('上传.txt'), 'content-type': 'text/plain' },
    body: '上传正文',
  })
  assert.equal(upload.status, 403, '归档空间不得通过 HTTP 上传文件')
})

test('会话附件回收只清理未被 Run 引用的上传对象', async () => {
  const workspaceId = 'ws-session-file-discard'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  await seedUser(ownerId, '回收负责人')
  await seedUser(memberId, '回收成员')
  await seedTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
  ])
  const sessionId = await seedSession(workspaceId, memberId)
  const orphanFileId = `${workspaceId}-orphan-file`
  await seedStoredFile({
    id: orphanFileId, workspaceId, sessionId, uploadedBy: memberId, name: '未引用.txt', content: '未引用正文',
  })

  const discarded = await fetch(`${baseUrl}/api/workbench/v1/sessions/${sessionId}/files/${orphanFileId}`, {
    method: 'DELETE',
    headers: { 'x-test-user-id': memberId },
  })
  assert.equal(discarded.status, 200)
  assert.deepEqual((await discarded.json()).data, { id: orphanFileId, removed: true })
  await assert.rejects(content.readFile(orphanFileId, memberId), /文件不存在或不可访问/)

  const referencedFileId = `${workspaceId}-referenced-file`
  await seedStoredFile({
    id: referencedFileId, workspaceId, sessionId, uploadedBy: memberId, name: '已引用.txt', content: '已引用正文',
  })
  await seedExtraction(referencedFileId, '已引用解析正文')
  const runId = await seedRun(sessionId, memberId)
  await database`
    insert into run_input_files (id, tenant_id, run_id, attempt_id, file_id, extraction_id, mount_path)
    values (
      ${`${workspaceId}-rif`}, ${tenantId}, ${runId}, ${`${runId}-attempt`},
      ${referencedFileId}, ${`${referencedFileId}-extraction`}, '/input/已引用.txt'
    )
  `
  const retained = await content.discardSessionFile(sessionId, referencedFileId, memberId)
  assert.deepEqual(retained, { id: referencedFileId, removed: false })
  assert.equal((await content.readFile(referencedFileId, memberId)).bytes.toString('utf8'), '已引用正文')
})

test('跨会话挂载的附件可进入 Attempt 且被引用后阻止回收（准入范围由 prepareRuntimeFiles 裁决）', async () => {
  const workspaceId = 'ws-cross-session-mount'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  await seedUser(ownerId, '跨会话负责人')
  await seedUser(memberId, '跨会话成员')
  await seedTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
  ])
  // 附件挂在 author 的会话下，由 member 挂进自己的会话运行（TW-10 同空间共享）。
  const sourceSession = await seedSession(workspaceId, ownerId)
  const targetSession = await seedSession(workspaceId, memberId)
  const fileId = `${workspaceId}-file`
  await seedStoredFile({
    id: fileId, workspaceId, sessionId: sourceSession, uploadedBy: ownerId, name: '跨会话.txt', content: '跨会话正文',
  })
  await seedExtraction(fileId, '跨会话解析正文')
  const prepared = await content.prepareRuntimeFiles({ sessionId: targetSession, fileIds: [fileId], userId: memberId })
  assert.equal(prepared.length, 1, '准入层允许同空间跨会话挂载')

  const runRepository = new PostgresRunRepository(database)
  const run = await runRepository.createRun({
    tenantId, sessionId: targetSession, requestedBy: memberId, idempotencyKey: `idem-${workspaceId}`,
  })
  const attempt = await runRepository.createAttempt({
    tenantId,
    runId: run.id,
    manifest: { purpose: 'workbench', session_id: targetSession, workspace_id: workspaceId },
    manifestSha256: 'x',
    modelRouteSnapshot: {},
    inputFiles: prepared.map(file => ({
      fileId: file.fileId,
      extractionId: file.extractionId,
      mountPath: file.mount.mount_path,
    })),
  })
  assert.ok(attempt.id, '已被准入层放行的跨会话附件必须能创建 Attempt')

  // 一旦被 run_input_files 引用，回收按执行历史保留（跨会话引用同样生效）。
  const retained = await content.discardSessionFile(sourceSession, fileId, ownerId)
  assert.deepEqual(retained, { id: fileId, removed: false })
})

test('createAttempt 范围兜底：跨空间他人附件与已移除文件不得进入 Attempt', async () => {
  const workspaceId = 'ws-attempt-scope'
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  const foreignOwnerId = `${workspaceId}-foreign`
  await seedUser(ownerId, '兜底负责人')
  await seedUser(memberId, '兜底成员')
  await seedUser(foreignOwnerId, '兜底外部人')
  await seedTeamWorkspace(workspaceId, [
    { userId: ownerId, role: 'owner' },
    { userId: memberId, role: 'member' },
  ])
  const sessionId = await seedSession(workspaceId, memberId)
  const runRepository = new PostgresRunRepository(database)
  const createRun = (key: string) => runRepository.createRun({
    tenantId, sessionId, requestedBy: memberId, idempotencyKey: key,
  })
  const mount = (fileId: string) => ({
    fileId, extractionId: `${fileId}-extraction`, mountPath: '/workspace/input/x.txt',
  })
  const tryAttempt = (key: string, fileId: string) => createRun(key).then(run =>
    runRepository.createAttempt({
      tenantId,
      runId: run.id,
      manifest: { session_id: sessionId, workspace_id: workspaceId },
      manifestSha256: 'x',
      modelRouteSnapshot: {},
      inputFiles: [mount(fileId)],
    }),
  )

  // 跨空间的他人会话附件：绕过准入层直传 inputFiles 时，仓储层同样必须拒绝。
  const foreignWorkspaceId = `${workspaceId}-foreign-ws`
  await seedTeamWorkspace(foreignWorkspaceId, [{ userId: foreignOwnerId, role: 'owner' }])
  const foreignSession = await seedSession(foreignWorkspaceId, foreignOwnerId)
  const foreignFileId = `${workspaceId}-foreign-file`
  await seedStoredFile({
    id: foreignFileId, workspaceId: foreignWorkspaceId, sessionId: foreignSession,
    uploadedBy: foreignOwnerId, name: '跨空间.txt', content: 'x',
  })
  await seedExtraction(foreignFileId, 'x')
  await assert.rejects(
    tryAttempt(`${workspaceId}-foreign`, foreignFileId),
    /超出该运行的可挂载范围|不存在/,
    '跨空间他人附件不得进入 Attempt',
  )

  // 已移除与不存在文件拒绝。
  const removedFileId = `${workspaceId}-removed-file`
  await seedStoredFile({
    id: removedFileId, workspaceId, sessionId, uploadedBy: memberId, name: '已移除.txt', content: 'x',
  })
  await seedExtraction(removedFileId, 'x')
  await database`update file_objects set removed_at = now() where tenant_id = ${tenantId} and id = ${removedFileId}`
  await assert.rejects(tryAttempt(`${workspaceId}-removed`, removedFileId), /已被移除/)
  await assert.rejects(tryAttempt(`${workspaceId}-missing`, `${workspaceId}-missing-file`), /不存在/)

  // 本人其它空间的自有会话附件：AC-23 既有行为，仓储层同样放行。
  const ownWorkspaceId = `ws-personal-${memberId}`
  const ownSession = await seedSession(ownWorkspaceId, memberId)
  const ownFileId = `${workspaceId}-own-file`
  await seedStoredFile({
    id: ownFileId, workspaceId: ownWorkspaceId, sessionId: ownSession,
    uploadedBy: memberId, name: '本人跨空间.txt', content: 'x',
  })
  await seedExtraction(ownFileId, 'x')
  const ownAttempt = await tryAttempt(`${workspaceId}-own`, ownFileId)
  assert.ok(ownAttempt.id, '发起人自有会话的跨空间附件必须可进入 Attempt')
})

test('个人空间读取与授权路径完全不受 3-T1 双轨影响（AC-23）', async () => {
  const personalUserId = 'user-archived-personal'
  const personalWorkspaceId = `ws-personal-${personalUserId}`
  await seedUser(personalUserId, '个人空间用户')
  const sessionId = await seedSession(personalWorkspaceId, personalUserId)
  const fileId = `${personalWorkspaceId}-file`
  await seedStoredFile({
    id: fileId, workspaceId: personalWorkspaceId, sessionId, uploadedBy: personalUserId, name: '个人文件.txt', content: '个人正文',
  })
  const runId = await seedRun(sessionId, personalUserId)
  const artifactId = `${personalWorkspaceId}-artifact`
  await seedArtifact({ artifactId, workspaceId: personalWorkspaceId, sessionId, createdBy: personalUserId, fileId, runId })

  // 个人空间保持现状：文件/成果可读可下载，共享文件列表接口仍拒绝（仅团队）。
  assert.equal((await content.readFile(fileId, personalUserId)).bytes.toString('utf8'), '个人正文')
  assert.equal(await content.artifactFileId(artifactId, undefined, personalUserId), fileId)
  assert.deepEqual((await content.listArtifacts(personalUserId)).map(artifact => artifact.id), [artifactId])
  await assert.rejects(
    content.listWorkspaceFiles({ workspaceId: personalWorkspaceId, actorUserId: personalUserId }),
    /仅支持团队工作空间/,
  )
  // 被 3-T1 接入读取轨的解析器不得把个人空间当团队空间（存在性由类型检查收口）。
  const readableType = await authorization.readableWorkspaceTypeOf?.(personalWorkspaceId)
  assert.equal(readableType, 'personal')
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testApiAuthenticator(request: import('node:http').IncomingMessage): Promise<RequestIdentity> {
  const header = request.headers['x-test-user-id']
  const userId = Array.isArray(header) ? header[0] : header
  if (!userId) {
    const error = new Error('请先登录') as Error & { status: number; code: string }
    error.status = 401
    error.code = 'authentication_required'
    throw error
  }
  return Promise.resolve({
    audience: 'workbench',
    applicationId: 'test-workbench',
    sessionHash: `test-session-${userId}`,
    userId,
    subject: `directory:${userId}`,
    profile: {
      id: userId, name: userId, title: '员工', department: '测试部门', avatarText: '测',
      role: 'employee', dataScopes: ['enterprise:authorized'],
    },
    roleIds: ['role-employee'],
    permissions: ['workbench:use'],
    dataScopes: ['enterprise:authorized'],
    authorizationVersion: 1,
    identityProvider: 'ai-hub-oidc',
  })
}

/** 3-T2 的归档 API 尚未实现；测试按既有约定直接用 SQL 落归档态。 */
async function archiveWorkspace(workspaceId: string) {
  await database`
    update workspaces set status = 'archived', archived_at = now()
     where tenant_id = ${tenantId} and id = ${workspaceId}
  `
}

async function seedUser(id: string, displayName: string) {
  await database`
    insert into users (
      id, tenant_id, external_subject, display_name, department_id, status, identity_provider, business_user
    ) values (${id}, ${tenantId}, ${`directory:${id}`}, ${displayName}, null, 'active', 'ai-hub', true)
  `
  await database`
    insert into user_roles (tenant_id, user_id, role_id, source_key)
    values (${tenantId}, ${id}, 'role-employee', 'local') on conflict do nothing
  `
}

async function seedTeamWorkspace(
  workspaceId: string,
  members: Array<{ userId: string; role: 'owner' | 'admin' | 'member' | 'viewer' }>,
) {
  const ownerId = members[0]?.userId ?? 'U00001'
  await database`
    insert into workspaces (id, tenant_id, name, description, workspace_type, created_by, status)
    values (${workspaceId}, ${tenantId}, '1B 共享文件测试空间', '', 'team', ${ownerId}, 'active')
  `
  for (const member of members) {
    await database`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values (${tenantId}, ${workspaceId}, ${member.userId}, ${member.role}, ${ownerId})
    `
  }
}

async function seedFile(input: {
  id: string
  workspaceId: string
  name: string
  uploadedBy: string
  createdAt?: string
}) {
  const createdAt = input.createdAt ?? new Date().toISOString()
  await database`
    insert into file_objects (
      id, tenant_id, workspace_id, session_id, storage_key, original_name, mime_type,
      size_bytes, sha256, scan_status, uploaded_by, created_at
    ) values (
      ${input.id}, ${tenantId}, ${input.workspaceId}, null, ${`storage/${input.id}`}, ${input.name},
      'application/octet-stream', 2048, ${'a'.repeat(64)}, 'clean', ${input.uploadedBy},
      ${createdAt}
    )
  `
  // TW-07：空间共享文件在逻辑文件模型里必须有对应 v1，否则不属于「有效列表」
  // （迁移 0025 只回填迁移前就存在的数据）。
  await database`
    insert into workspace_files (id, tenant_id, workspace_id, name, status, latest_version_no, created_by, created_at)
    values (${`wfile-${input.id}`}, ${tenantId}, ${input.workspaceId}, ${input.name}, 'active', 1, ${input.uploadedBy}, ${createdAt})
  `
  await database`
    insert into workspace_file_versions (id, tenant_id, logical_file_id, version_no, file_object_id, note, parse_status, created_by)
    values (${`wfv-${input.id}`}, ${tenantId}, ${`wfile-${input.id}`}, 1, ${input.id}, null, 'succeeded', ${input.uploadedBy})
  `
}

/** 让共享/会话文件进入可挂载状态：成功的 m4-basic-v1 解析结果。 */
async function seedExtraction(fileId: string, text: string) {
  const extractionId = `${fileId}-extraction`
  const storageKey = `storage/${extractionId}.txt`
  const target = join(storageRoot, storageKey)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, text)
  await database`
    insert into file_extractions (
      id, tenant_id, file_id, extractor_version, detected_type, status,
      text_storage_key, text_sha256, character_count, created_at
    ) values (
      ${extractionId}, ${tenantId}, ${fileId}, 'm4-basic-v1', 'text', 'succeeded',
      ${storageKey}, ${'c'.repeat(64)}, ${text.length}, now()
    )
  `
}

/** 空间共享文件的行由 `seedFile` 建立，这里补上磁盘字节以便真正下载。 */
async function storeSharedFileBytes(fileId: string, content: string) {
  const [row] = await database<{ storageKey: string }[]>`
    select storage_key as "storageKey" from file_objects
     where tenant_id = ${tenantId} and id = ${fileId}
  `
  if (!row) throw new Error(`file object ${fileId} not seeded`)
  const target = join(storageRoot, row.storageKey)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content)
}

/** Real team/personal session owned by `userId`; artifacts/files hang off it. */
async function seedSession(workspaceId: string, userId: string) {
  const sessionId = `session-${randomUUID()}`
  await database`
    insert into sessions (id, tenant_id, workspace_id, created_by, agent_version_id, title, status)
    values (${sessionId}, ${tenantId}, ${workspaceId}, ${userId}, 'agent-version-dsh-work-assistant-1', '收权验证会话', 'active')
  `
  return sessionId
}

/** Terminal run + attempt so `artifact_versions.source_run_id` can be satisfied. */
async function seedRun(sessionId: string, userId: string) {
  const runId = `run-${randomUUID()}`
  const attemptId = `${runId}-attempt`
  await database.begin(async transaction => {
    await transaction`
      insert into runs (id, tenant_id, session_id, requested_by, idempotency_key, status, current_attempt_id)
      values (${runId}, ${tenantId}, ${sessionId}, ${userId}, ${`idem-${runId}`}, 'succeeded', ${attemptId})
    `
    await transaction`
      insert into run_attempts (id, tenant_id, run_id, attempt_no, runtime_id, manifest, manifest_sha256, model_route_snapshot, status)
      values (${attemptId}, ${tenantId}, ${runId}, 1, 'runtime-local-01', ${database.json({})}, 'x', ${database.json({})}, 'succeeded')
    `
  })
  return runId
}

/** File object attached to a session, with the bytes really present on disk. */
async function seedStoredFile(input: {
  id: string
  workspaceId: string
  sessionId: string
  name: string
  uploadedBy: string
  content: string
}) {
  const storageKey = `storage/${input.id}`
  const target = join(storageRoot, storageKey)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, input.content)
  await database`
    insert into file_objects (
      id, tenant_id, workspace_id, session_id, storage_key, original_name, mime_type,
      size_bytes, sha256, scan_status, uploaded_by
    ) values (
      ${input.id}, ${tenantId}, ${input.workspaceId}, ${input.sessionId}, ${storageKey}, ${input.name},
      'text/plain', ${Buffer.byteLength(input.content)}, ${'a'.repeat(64)}, 'clean', ${input.uploadedBy}
    )
  `
}

async function seedArtifact(input: {
  artifactId: string
  workspaceId: string
  sessionId: string
  createdBy: string
  fileId: string
  runId: string
  version?: number
}) {
  await database`
    insert into artifacts (id, tenant_id, workspace_id, session_id, name, artifact_type, created_by)
    values (${input.artifactId}, ${tenantId}, ${input.workspaceId}, ${input.sessionId}, ${`${input.artifactId}.txt`}, 'text', ${input.createdBy})
  `
  await database`
    insert into artifact_versions (id, tenant_id, artifact_id, version_no, file_object_id, source_run_id)
    values (${`${input.artifactId}-v${input.version ?? 1}`}, ${tenantId}, ${input.artifactId}, ${input.version ?? 1}, ${input.fileId}, ${input.runId})
  `
}
