import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'

import type { RequestIdentity } from '../modules/identity/types.ts'
import { PostgresAuthorizationService } from '../modules/authorization/postgres-authorization-service.ts'
import { RequestValidationError } from '../domain/authorization-errors.ts'
import { WorkspaceStateConflictError } from '../modules/workbench/application/workspace-state-conflict-error.ts'
import type { DatabaseClient } from '../infrastructure/postgres/database.ts'
import { runMigrations } from '../infrastructure/postgres/migration-runner.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from '../infrastructure/postgres/test-database.ts'
import { PostgresContentService, type UploadedWorkspaceFileVersion } from '../modules/workbench/application/postgres-content-service.ts'
import { PostgresWorkspaceMemberService } from '../modules/workbench/application/postgres-workspace-member-service.ts'
import { Router } from './router.ts'
import { registerContentRoutes } from './workbench/content-routes.ts'
import { LocalObjectStorage } from '../infrastructure/storage/local-object-storage.ts'

const tenantId = 'tenant-dsh-work'
const suffix = randomUUID().replaceAll('-', '').slice(0, 8)
const migrationsDirectory = resolve(import.meta.dirname, '../../migrations')

// 回填夹具 ID（升级前写入，供 before 的 0025 升级回填）。
const legacyWorkspaceId = `ws-legacy-${suffix}`
const legacyOwnerId = `legacy-owner-${suffix}`
const legacyParsedObjectId = `file-legacy-parsed-${suffix}`
const legacyUnparsedObjectId = `file-legacy-unparsed-${suffix}`
const legacyRemovedObjectId = `file-legacy-removed-${suffix}`
const legacyPersonalObjectId = `file-legacy-personal-${suffix}`
const legacyAttachmentObjectId = `file-legacy-attachment-${suffix}`

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let authorization: PostgresAuthorizationService
let content: PostgresContentService
let workspaceMembers: PostgresWorkspaceMemberService
let server: ReturnType<typeof createServer>
let baseUrl = ''
let storageRoot = ''
let baselineDirectory = ''
let fileObjectColumnsBeforeUpgrade: string[] = []

before(async () => {
  // 与 team-workspace-upgrade 同法：先生成 0001~0024 的基线目录，构造「已有数据、
  // 0025 尚未应用」的升级场景，回填断言才有意义（全新库没有可回填数据）。
  baselineDirectory = await mkdtemp(resolve(tmpdir(), 'dsh-work-file-versions-migrations-'))
  for (const file of (await readdir(migrationsDirectory)).sort()) {
    if (file < '0025') await copyFile(resolve(migrationsDirectory, file), resolve(baselineDirectory, file))
  }

  throwaway = await createThrowawayDatabase({
    namePrefix: 'dsh_work_file_versions_api_test',
    maxConnections: 10,
    migrate: false,
  })
  database = throwaway.client
  await runMigrations(database, baselineDirectory)
  fileObjectColumnsBeforeUpgrade = await fileObjectColumns()
  await seedLegacySharedFiles()

  // 应用真实迁移链：只应新增 0025（基线已记录 0001~0024）。
  await runMigrations(database, migrationsDirectory)

  storageRoot = await mkdtemp(join(tmpdir(), 'dsh-work-file-versions-'))
  authorization = new PostgresAuthorizationService(database)
  content = new PostgresContentService(database, new LocalObjectStorage(storageRoot), authorization)
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
  if (baselineDirectory) await rm(baselineDirectory, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 迁移回填（AC-13 / 方案 §6.4：仅团队共享文件回填为 v1）
// ---------------------------------------------------------------------------

test('迁移 0025：现有团队共享文件回填为 v1，个人文件与会话附件不动，file_objects 结构不变', async () => {
  // file_objects 保持不可变：迁移不得给它加列（AC-13「历史 Run 可追溯」）。
  assert.deepEqual(await fileObjectColumns(), fileObjectColumnsBeforeUpgrade, 'file_objects 结构不得被 0025 改动')

  const logical = await database<{
    id: string
    name: string
    status: string
    latestVersionNo: number
  }[]>`
    select id, name, status, latest_version_no as "latestVersionNo"
      from workspace_files
     where tenant_id = ${tenantId}
     order by id
  `
  assert.deepEqual(
    logical.map(row => [row.id, row.name, row.status, row.latestVersionNo]),
    [
      [`wfile-${legacyParsedObjectId}`, '历史已解析.txt', 'active', 1],
      [`wfile-${legacyUnparsedObjectId}`, '历史未解析.txt', 'active', 0],
    ],
    '每个未移除的团队共享文件回填一个逻辑文件；解析成功的记 v1，未解析记录保留但不前移有效版本号',
  )

  const versions = await database<{ logicalFileId: string; versionNo: number; fileObjectId: string; parseStatus: string }[]>`
    select logical_file_id as "logicalFileId", version_no as "versionNo",
           file_object_id as "fileObjectId", parse_status as "parseStatus"
      from workspace_file_versions
     where tenant_id = ${tenantId}
     order by logical_file_id
  `
  assert.deepEqual(versions.map(row => [row.logicalFileId, row.versionNo, row.fileObjectId, row.parseStatus]), [
    [`wfile-${legacyParsedObjectId}`, 1, legacyParsedObjectId, 'succeeded'],
    [`wfile-${legacyUnparsedObjectId}`, 1, legacyUnparsedObjectId, 'pending'],
  ])

  // 个人空间文件（session_id 为空）与会话附件（session_id 非空）都不进入逻辑文件。
  const leaked = await database<{ count: number }[]>`
    select count(*)::integer as count
      from workspace_files
     where tenant_id = ${tenantId}
       and (
         id in (${`wfile-${legacyPersonalObjectId}`}, ${`wfile-${legacyAttachmentObjectId}`}, ${`wfile-${legacyRemovedObjectId}`})
       )
  `
  assert.equal(leaked[0]?.count, 0, '个人文件、会话附件与已移除文件不得回填为逻辑文件')

  // 回填不得改写不可变对象本身：原始字节指纹与移除标记保持原样。
  const [legacyObject] = await database<{ sha256: string; removedAt: Date | null }[]>`
    select sha256, removed_at as "removedAt" from file_objects
     where tenant_id = ${tenantId} and id = ${legacyParsedObjectId}
  `
  assert.equal(legacyObject?.sha256, 'a'.repeat(64))
  assert.equal(legacyObject?.removedAt, null)
})

test('历史解析从未成功的团队共享文件必须仍出现在列表里（带失败状态），不得因回填而消失', async () => {
  // TW-05 把「解析失败」列为可见状态；回填后这类文件的 latest_version_no 停在 0，
  // 若列表按它关联就会让文件整条消失——这是本次实现自查发现并修掉的回归。
  const listed = await content.listWorkspaceFiles({
    workspaceId: legacyWorkspaceId,
    actorUserId: legacyOwnerId,
    limit: 20,
  })
  const unparsed = listed.items.find(item => item.logicalFileId === `wfile-${legacyUnparsedObjectId}`)
  assert.ok(unparsed, '未解析的历史共享文件必须仍在有效列表里（可见失败状态）')
  assert.equal(unparsed?.versionNo, 1, '展示其唯一版本')
  assert.equal(unparsed?.scanStatus, 'clean', '安全扫描通过，失败的是解析而非扫描')

  // 对照：解析成功的历史文件同样可见，且指向 v1。
  const parsed = listed.items.find(item => item.logicalFileId === `wfile-${legacyParsedObjectId}`)
  assert.equal(parsed?.versionNo, 1, '解析成功的历史文件指向 v1')
})

// ---------------------------------------------------------------------------
// 新版本上传（TW-07 / AC-13 / AC-29）
// ---------------------------------------------------------------------------

test('上传 v2 前移最新有效版本，v1 仍可下载，列表每逻辑文件只出现一行并带版本信息', async () => {
  const workspaceId = uniqueWorkspace('advance')
  const ownerId = `${workspaceId}-owner`
  await seedUser(ownerId, '版本负责人')
  await seedTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])

  const v1 = await uploadInitialFile(workspaceId, '季度报告.txt', '第一版正文', ownerId)
  assert.ok(v1.logicalFileId, '初次上传必须建立逻辑文件')
  assert.equal(v1.versionNo, 1)

  const v2 = await content.uploadWorkspaceFileVersion({
    workspaceId,
    logicalFileId: v1.logicalFileId,
    name: '季度报告-修订.txt',
    mimeType: 'text/plain',
    bytes: Buffer.from('第二版正文'),
    note: '补充了 Q3 数据',
    actorUserId: ownerId,
  })
  assert.equal(v2.versionNo, 2)
  assert.equal(v2.logicalFileId, v1.logicalFileId)

  // 两个不可变对象都能按 ID 读回各自字节：旧版本没有被覆盖。
  assert.equal((await content.readFile(v1.id, ownerId)).bytes.toString('utf8'), '第一版正文')
  assert.equal((await content.readFile(v2.id, ownerId)).bytes.toString('utf8'), '第二版正文')

  const listed = await content.listWorkspaceFiles({ workspaceId, actorUserId: ownerId })
  assert.equal(listed.items.length, 1, '同一逻辑文件的多个版本在列表中只占一行（AC-29 无重复计数）')
  assert.deepEqual(
    listed.items.map(item => [item.id, item.logicalFileId, item.versionNo, item.versionCount]),
    [[v2.id, v1.logicalFileId, 2, 2]],
    '列表返回最新有效版本，并带上逻辑文件 ID/版本号/版本数',
  )

  const versions = await content.listWorkspaceFileVersions({ workspaceId, logicalFileId: v1.logicalFileId, actorUserId: ownerId })
  assert.equal(versions.name, '季度报告.txt')
  assert.equal(versions.latestVersionNo, 2)
  assert.equal(versions.versionCount, 2)
  assert.deepEqual(
    versions.items.map(item => [item.versionNo, item.fileId, item.note, item.current]),
    [[2, v2.id, '补充了 Q3 数据', true], [1, v1.id, null, false]],
    '版本列表按版本号倒序，最新有效版本标记 current，更新说明保留',
  )
})

test('失败的 v2 保留失败记录但不前移最新有效版本，v1 仍可读可挂载', async () => {
  const workspaceId = uniqueWorkspace('failed-version')
  const ownerId = `${workspaceId}-owner`
  await seedUser(ownerId, '失败版本负责人')
  await seedTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  const v1 = await uploadInitialFile(workspaceId, '基线.txt', '基线正文', ownerId)

  // 只有空白字符的 txt：通过安全扫描与大小校验，但解析后无可提取文本 → 解析失败。
  const failure = await content.uploadWorkspaceFileVersion({
    workspaceId,
    logicalFileId: v1.logicalFileId,
    name: '空白.txt',
    mimeType: 'text/plain',
    bytes: Buffer.from('   '),
    note: null,
    actorUserId: ownerId,
  }).then(() => null, (error: unknown) => error)
  assert.ok(failure instanceof RequestValidationError, `解析失败必须是类型化 422，实际：${String(failure)}`)
  assert.equal((failure as RequestValidationError).status, 422)

  const [logical] = await database<{ latestVersionNo: number }[]>`
    select latest_version_no as "latestVersionNo" from workspace_files
     where tenant_id = ${tenantId} and id = ${v1.logicalFileId}
  `
  assert.equal(logical?.latestVersionNo, 1, '失败版本不得前移 latest_version_no')

  const [failed] = await database<{ versionNo: number; parseStatus: string; fileObjectId: string }[]>`
    select version_no as "versionNo", parse_status as "parseStatus", file_object_id as "fileObjectId"
      from workspace_file_versions
     where tenant_id = ${tenantId} and logical_file_id = ${v1.logicalFileId} and version_no = 2
  `
  assert.deepEqual(
    [failed?.versionNo, failed?.parseStatus],
    [2, 'failed'],
    '失败版本保留记录（版本号已分配、对象已落库）',
  )
  const [failedExtraction] = await database<{ status: string }[]>`
    select status from file_extractions
     where tenant_id = ${tenantId} and file_id = ${failed?.fileObjectId ?? ''}
  `
  assert.equal(failedExtraction?.status, 'failed', '失败原因以解析记录保留')

  // v1 的可读性与可挂载性不受影响（初次上传已带成功解析结果）。
  assert.equal((await content.readFile(v1.id, ownerId)).bytes.toString('utf8'), '基线正文')
  const mounted = await content.prepareRuntimeFiles({ sessionId: await seedSession(workspaceId, ownerId), fileIds: [v1.id], userId: ownerId })
  assert.equal(mounted.length, 1, '失败的新版本不得破坏旧版本作为 Run 输入')

  const listed = await content.listWorkspaceFiles({ workspaceId, actorUserId: ownerId })
  assert.deepEqual(
    listed.items.map(item => [item.logicalFileId, item.versionNo, item.versionCount]),
    [[v1.logicalFileId, 1, 2]],
    '列表仍展示 v1 为最新有效版本，同时版本总数包含失败版本',
  )
  const versions = await content.listWorkspaceFileVersions({ workspaceId, logicalFileId: v1.logicalFileId, actorUserId: ownerId })
  assert.equal(versions.items.find(item => item.versionNo === 2)?.parseStatus, 'failed')
  assert.equal(versions.items.find(item => item.versionNo === 2)?.canDownload, true, '失败版本的对象仍可下载（字节完好）')
})

test('版本上传的 HTTP 接口：成功 201 带版本信息，解析失败 422，归档空间 403', async () => {
  const workspaceId = uniqueWorkspace('version-http')
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  await seedUser(ownerId, '接口版本负责人')
  await seedUser(memberId, '接口版本成员')
  await seedTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }, { userId: memberId, role: 'member' }])
  const v1 = await uploadInitialFile(workspaceId, '接口基线.txt', '接口基线', ownerId)

  const ok = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/files/${v1.logicalFileId}/versions`, {
    as: memberId,
    raw: Buffer.from('成员上传的第二版'),
    headers: {
      'content-type': 'text/plain',
      'x-file-name': encodeURIComponent('接口第二版.txt'),
      'x-file-note': encodeURIComponent('成员补充'),
    },
  })
  assert.equal(ok.status, 201, `版本上传应成功：${JSON.stringify(ok.body)}`)
  assert.equal((ok.body as { data: { versionNo: number; logicalFileId: string } }).data.versionNo, 2)

  const failed = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/files/${v1.logicalFileId}/versions`, {
    as: memberId,
    raw: Buffer.from('   '),
    headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('空白.txt') },
  })
  assert.equal(failed.status, 422, '解析失败必须是 422，而不是 500/403')

  await archiveWorkspace(workspaceId)
  const archived = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/files/${v1.logicalFileId}/versions`, {
    as: ownerId,
    raw: Buffer.from('归档后上传'),
    headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('归档.txt') },
  })
  assert.equal(archived.status, 403, '归档空间不得上传新版本（执行轨）')
})

test('历史 Run 的输入固定到实际使用的对象与版本（AC-13）', async () => {
  const workspaceId = uniqueWorkspace('pinned-run')
  const ownerId = `${workspaceId}-owner`
  await seedUser(ownerId, '固定版本负责人')
  await seedTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  const v1 = await uploadInitialFile(workspaceId, '追溯.txt', '被 Run 引用的第一版', ownerId)
  const extractionId = await succeededExtractionIdOf(v1.id)

  const sessionId = await seedSession(workspaceId, ownerId)
  const runId = await seedRun(sessionId, ownerId)
  await database`
    insert into run_input_files (id, tenant_id, run_id, attempt_id, file_id, extraction_id, mount_path)
    values (${`${runId}-input`}, ${tenantId}, ${runId}, ${`${runId}-attempt`}, ${v1.id},
            ${extractionId}, '/workspace/input/追溯.txt')
  `

  // v2 上传后，历史 Run 的引用不改写，且能反查到当时使用的版本号。
  await content.uploadWorkspaceFileVersion({
    workspaceId,
    logicalFileId: v1.logicalFileId,
    name: '追溯-第二版.txt',
    mimeType: 'text/plain',
    bytes: Buffer.from('第二版不应改写历史'),
    note: null,
    actorUserId: ownerId,
  })

  assert.deepEqual(await content.getRunInputFileIds(runId), [v1.id], 'run_input_files 仍指向原不可变对象')
  const [trace] = await database<{ versionNo: number; objectId: string }[]>`
    select wfv.version_no as "versionNo", wfv.file_object_id as "objectId"
      from run_input_files rif
      join workspace_file_versions wfv
        on wfv.tenant_id = rif.tenant_id and wfv.file_object_id = rif.file_id
     where rif.tenant_id = ${tenantId} and rif.run_id = ${runId}
  `
  assert.deepEqual([trace?.versionNo, trace?.objectId], [1, v1.id], '由 run_input_files 反查到实际输入版本 v1')
})

// ---------------------------------------------------------------------------
// 并发版本分配（TW-07 并发要求）
// ---------------------------------------------------------------------------

test('并发上传新版本：版本号互不覆盖，全部成功且各自字节独立', async () => {
  const workspaceId = uniqueWorkspace('concurrent')
  const ownerId = `${workspaceId}-owner`
  await seedUser(ownerId, '并发版本负责人')
  await seedTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  const v1 = await uploadInitialFile(workspaceId, '并发基线.txt', '并发基线', ownerId)

  const results = await Promise.allSettled([2, 3, 4].map(index => content.uploadWorkspaceFileVersion({
    workspaceId,
    logicalFileId: v1.logicalFileId,
    name: `并发-${index}.txt`,
    mimeType: 'text/plain',
    bytes: Buffer.from(`并发正文-${index}`),
    note: null,
    actorUserId: ownerId,
  })))

  const fulfilled = results.filter((result): result is PromiseFulfilledResult<UploadedWorkspaceFileVersion> => result.status === 'fulfilled')
  assert.equal(fulfilled.length, 3, `三个并发上传都应在行锁内串行分配到不同版本号：${JSON.stringify(results.map(result => result.status === 'fulfilled' ? 'ok' : String(result.reason)))}`)
  assert.deepEqual(
    fulfilled.map(result => result.value.versionNo).sort((left, right) => left - right),
    [2, 3, 4],
    '版本号必须互不重复（无覆盖、无丢失更新）',
  )

  const rows = await database<{ versionNo: number; fileObjectId: string }[]>`
    select version_no as "versionNo", file_object_id as "fileObjectId"
      from workspace_file_versions
     where tenant_id = ${tenantId} and logical_file_id = ${v1.logicalFileId}
     order by version_no
  `
  assert.equal(rows.length, 4, '每个并发上传都保留独立版本行')
  const [logical] = await database<{ latestVersionNo: number }[]>`
    select latest_version_no as "latestVersionNo" from workspace_files
     where tenant_id = ${tenantId} and id = ${v1.logicalFileId}
  `
  assert.equal(logical?.latestVersionNo, 4)
  for (const result of fulfilled) {
    const bytes = (await content.readFile(result.value.id, ownerId)).bytes.toString('utf8')
    assert.match(bytes, /^并发正文-[234]$/, `版本 ${result.value.versionNo} 的字节不得被其它上传覆盖`)
  }
})

test('版本号分配串行在逻辑文件行锁上：外部持有行锁时上传不得完成（判别性）', async () => {
  const workspaceId = uniqueWorkspace('row-lock')
  const ownerId = `${workspaceId}-owner`
  await seedUser(ownerId, '行锁负责人')
  await seedTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  const v1 = await uploadInitialFile(workspaceId, '行锁基线.txt', '行锁基线', ownerId)

  let releaseLock: () => void = () => undefined
  let lockHeld: () => void = () => undefined
  const held = new Promise<void>(resolveHeld => { lockHeld = resolveHeld })
  const release = new Promise<void>(resolveRelease => { releaseLock = resolveRelease })

  // 一个「竞态赢家」版本对象，由持锁事务在锁内写为 v2。
  const winnerObjectId = `file-winner-${suffix}`
  await database`
    insert into file_objects (
      id, tenant_id, workspace_id, session_id, storage_key, original_name, mime_type,
      size_bytes, sha256, scan_status, uploaded_by
    ) values (
      ${winnerObjectId}, ${tenantId}, ${workspaceId}, null, ${`storage/${winnerObjectId}`},
      '竞态赢家.txt', 'text/plain', 3, ${'a'.repeat(64)}, 'clean', ${ownerId}
    )
  `

  const holder = database.begin(async transaction => {
    await transaction`
      select id from workspace_files
       where tenant_id = ${tenantId} and id = ${v1.logicalFileId}
       for update
    `
    lockHeld()
    await release
    // 持锁期间「另一个上传」占用了 v2：正确实现（先取行锁再算版本号）会在释放后
    // 重新读取最大版本号并分配 v3；只读快照的实现（无 for update）已经把 v2 算好，
    // 释放后插入必然撞唯一约束（409）。
    await transaction`
      insert into workspace_file_versions (
        id, tenant_id, logical_file_id, version_no, file_object_id, note, parse_status, created_by
      ) values (
        ${`wfv-winner-${suffix}`}, ${tenantId}, ${v1.logicalFileId}, 2, ${winnerObjectId}, null, 'succeeded', ${ownerId}
      )
    `
    await transaction`
      update workspace_files set latest_version_no = 2
       where tenant_id = ${tenantId} and id = ${v1.logicalFileId}
    `
  })
  await held

  const upload = content.uploadWorkspaceFileVersion({
    workspaceId,
    logicalFileId: v1.logicalFileId,
    name: '行锁-第三版.txt',
    mimeType: 'text/plain',
    bytes: Buffer.from('行锁第三版'),
    note: null,
    actorUserId: ownerId,
  })

  await delay(300)
  releaseLock()
  await holder
  const uploaded = await upload
  assert.equal(
    uploaded.versionNo,
    3,
    '版本号必须在取得逻辑文件行锁后重新计算；若只是普通 SELECT，会先算出 v2 再撞唯一约束（该用例即反证点）',
  )
})

// ---------------------------------------------------------------------------
// 读取轨 / 执行轨与收权
// ---------------------------------------------------------------------------

test('归档空间的版本列表与历史版本下载可读，但新版本上传被拒（读取轨/执行轨）', async () => {
  const workspaceId = uniqueWorkspace('archived-versions')
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  await seedUser(ownerId, '归档版本负责人')
  await seedUser(memberId, '归档版本成员')
  await seedTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }, { userId: memberId, role: 'member' }])
  const v1 = await uploadInitialFile(workspaceId, '归档基线.txt', '归档基线正文', ownerId)
  const v2 = await content.uploadWorkspaceFileVersion({
    workspaceId,
    logicalFileId: v1.logicalFileId,
    name: '归档第二版.txt',
    mimeType: 'text/plain',
    bytes: Buffer.from('归档第二版正文'),
    note: null,
    actorUserId: ownerId,
  })

  await archiveWorkspace(workspaceId)

  const list = await api('GET', `/api/workbench/v1/workspaces/${workspaceId}/files/${v1.logicalFileId}/versions`, { as: memberId })
  assert.equal(list.status, 200, `归档空间现任成员必须能读取版本列表：${JSON.stringify(list.body)}`)
  const listed = list.body as { data: { latestVersionNo: number; items: Array<{ versionNo: number }> } }
  assert.equal(listed.data.latestVersionNo, 2)
  assert.deepEqual(listed.data.items.map(item => item.versionNo), [2, 1])

  const download = await fetch(`${baseUrl}/api/workbench/v1/workspaces/${workspaceId}/files/${v1.logicalFileId}/versions/1/download`, {
    headers: { 'x-test-user-id': memberId },
  })
  assert.equal(download.status, 200, '归档空间历史版本仍可下载')
  assert.equal(await download.text(), '归档基线正文')
  assert.equal(download.headers.get('content-disposition')?.includes(encodeURIComponent('归档基线.txt')), true)

  await assert.rejects(
    content.uploadWorkspaceFileVersion({
      workspaceId,
      logicalFileId: v1.logicalFileId,
      name: '归档后.txt',
      mimeType: 'text/plain',
      bytes: Buffer.from('归档后上传'),
      note: null,
      actorUserId: ownerId,
    }),
    /工作空间不存在、已归档或当前用户无权访问/,
  )
  // 版本下载的读取轨同样放行现任成员的最新版本。
  assert.equal((await content.readFile(v2.id, memberId)).bytes.toString('utf8'), '归档第二版正文')
})

test('被移出成员在版本列表/上传/下载上全部拒绝，现任成员不受影响（AC-09）', async () => {
  const workspaceId = uniqueWorkspace('revoked-versions')
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  await seedUser(ownerId, '收权版本负责人')
  await seedUser(memberId, '收权版本成员')
  await seedTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }, { userId: memberId, role: 'member' }])
  const v1 = await uploadInitialFile(workspaceId, '收权基线.txt', '收权基线正文', ownerId)

  assert.equal((await content.readFile(v1.id, memberId)).bytes.toString('utf8'), '收权基线正文')

  await workspaceMembers.removeMember(workspaceId, memberId, ownerId)

  await assert.rejects(
    content.listWorkspaceFiles({ workspaceId, actorUserId: memberId }),
    /工作空间不存在、已归档或当前用户无权访问/,
  )
  await assert.rejects(
    content.listWorkspaceFileVersions({ workspaceId, logicalFileId: v1.logicalFileId, actorUserId: memberId }),
    /工作空间不存在、已归档或当前用户无权访问/,
  )
  await assert.rejects(
    content.uploadWorkspaceFileVersion({
      workspaceId,
      logicalFileId: v1.logicalFileId,
      name: '收权后.txt',
      mimeType: 'text/plain',
      bytes: Buffer.from('收权后上传'),
      note: null,
      actorUserId: memberId,
    }),
    /工作空间不存在、已归档或当前用户无权访问/,
  )
  await assert.rejects(content.readFile(v1.id, memberId), /文件不存在或不可访问/)

  const versionDownload = await fetch(`${baseUrl}/api/workbench/v1/workspaces/${workspaceId}/files/${v1.logicalFileId}/versions/1/download`, {
    headers: { 'x-test-user-id': memberId },
  })
  assert.equal(versionDownload.status, 403, '被移出成员的版本下载必须拒绝')

  // 现任负责人不受影响。
  assert.equal((await content.readFile(v1.id, ownerId)).bytes.toString('utf8'), '收权基线正文')
  assert.equal((await content.listWorkspaceFileVersions({ workspaceId, logicalFileId: v1.logicalFileId, actorUserId: ownerId })).items.length, 1)
})

test('逻辑移除：有效列表消失、旧对象下载拒绝，但每个版本与历史 Run 引用都保留', async () => {
  const workspaceId = uniqueWorkspace('removed-logical')
  const ownerId = `${workspaceId}-owner`
  await seedUser(ownerId, '逻辑移除负责人')
  await seedTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  const v1 = await uploadInitialFile(workspaceId, '移除基线.txt', '移除基线正文', ownerId)
  const v2 = await content.uploadWorkspaceFileVersion({
    workspaceId,
    logicalFileId: v1.logicalFileId,
    name: '移除第二版.txt',
    mimeType: 'text/plain',
    bytes: Buffer.from('移除第二版正文'),
    note: null,
    actorUserId: ownerId,
  })
  const sessionId = await seedSession(workspaceId, ownerId)
  const runId = await seedRun(sessionId, ownerId)
  const extractionId = await succeededExtractionIdOf(v1.id)
  await database`
    insert into run_input_files (id, tenant_id, run_id, attempt_id, file_id, extraction_id, mount_path)
    values (${`${runId}-input`}, ${tenantId}, ${runId}, ${`${runId}-attempt`}, ${v1.id}, ${extractionId}, '/workspace/input/移除基线.txt')
  `

  // 兼容既有端点语义：用最新对象 ID 也能移除整条逻辑文件。
  assert.deepEqual(await content.removeWorkspaceFile(workspaceId, v2.id, ownerId), { id: v2.id, removed: true })

  const [logical] = await database<{ status: string; removedAt: Date | null }[]>`
    select status, removed_at as "removedAt" from workspace_files
     where tenant_id = ${tenantId} and id = ${v1.logicalFileId}
  `
  assert.equal(logical?.status, 'removed')
  assert.ok(logical?.removedAt)

  const versions = await database<{ versionNo: number; fileObjectId: string }[]>`
    select version_no as "versionNo", file_object_id as "fileObjectId"
      from workspace_file_versions
     where tenant_id = ${tenantId} and logical_file_id = ${v1.logicalFileId}
     order by version_no
  `
  assert.deepEqual(versions.map(row => [row.versionNo, row.fileObjectId]), [[1, v1.id], [2, v2.id]], '移除逻辑文件不移除版本记录')

  const objects = await database<{ id: string; removedAt: Date | null }[]>`
    select id, removed_at as "removedAt" from file_objects
     where tenant_id = ${tenantId} and id in (${v1.id}, ${v2.id})
     order by id
  `
  assert.equal(objects.every(row => row.removedAt !== null), true, '所有版本对象标记为已移除（阻止新引用）')

  const listed = await content.listWorkspaceFiles({ workspaceId, actorUserId: ownerId })
  assert.equal(listed.items.some(item => item.logicalFileId === v1.logicalFileId), false, '已移除逻辑文件不出现在有效列表')
  await assert.rejects(content.readFile(v1.id, ownerId), /文件不存在或不可访问/)
  await assert.rejects(content.readFile(v2.id, ownerId), /文件不存在或不可访问/)

  // 历史引用仍能反查实际版本。
  assert.deepEqual(await content.getRunInputFileIds(runId), [v1.id])
  const [trace] = await database<{ versionNo: number }[]>`
    select wfv.version_no as "versionNo"
      from run_input_files rif
      join workspace_file_versions wfv on wfv.tenant_id = rif.tenant_id and wfv.file_object_id = rif.file_id
     where rif.tenant_id = ${tenantId} and rif.run_id = ${runId}
  `
  assert.equal(trace?.versionNo, 1)
})

test('版本接口拒绝个人空间（AC-23：个人文件不进入逻辑文件模型）', async () => {
  const userId = `user-version-personal-${suffix}`
  await seedUser(userId, '版本个人空间用户')
  const personalWorkspaceId = `ws-personal-${userId}`

  await assert.rejects(
    content.listWorkspaceFileVersions({ workspaceId: personalWorkspaceId, logicalFileId: 'wfile-x', actorUserId: userId }),
    /仅支持团队工作空间/,
  )
  await assert.rejects(
    content.uploadWorkspaceFileVersion({
      workspaceId: personalWorkspaceId,
      logicalFileId: 'wfile-x',
      name: '个人.txt',
      mimeType: 'text/plain',
      bytes: Buffer.from('个人正文'),
      note: null,
      actorUserId: userId,
    }),
    /仅支持团队工作空间/,
  )

  // 个人空间上传（session_id 为空）不创建逻辑文件。
  await content.storeWorkspaceFile(personalWorkspaceId, '个人共享.txt', 'text/plain', Buffer.from('个人共享正文'), userId)
  const [count] = await database<{ count: number }[]>`
    select count(*)::integer as count from workspace_files
     where tenant_id = ${tenantId} and workspace_id = ${personalWorkspaceId}
  `
  assert.equal(count?.count, 0, '个人空间文件不得进入 workspace_files（AC-23）')
})

test('版本号基于既有最大版本分配（不依赖 latest_version_no），且已移除文件上传返回类型化 409', async () => {
  // 说明：本用例**不**制造唯一约束冲突——行锁保证同一逻辑文件上的分配串行，
  // 正常路径下撞不到唯一键。`isUniqueViolation → 409` 只是行锁失效时的兜底
  // （撤掉 `for update` 才会走到），因此不在此断言；此前用例名声称覆盖它属过度
  // 承诺（质量评审 F7）。这里实际验证两件事：分配读 max(version_no)（而非
  // latest_version_no），以及已移除文件的 409 是类型化的。
  const workspaceId = uniqueWorkspace('conflict-type')
  const ownerId = `${workspaceId}-owner`
  await seedUser(ownerId, '冲突类型负责人')
  await seedTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  const v1 = await uploadInitialFile(workspaceId, '冲突基线.txt', '冲突基线', ownerId)

  // 手工抢占 v2：下一次上传必须拿到 v3，而不是撞唯一约束。
  await database`
    insert into file_objects (id, tenant_id, workspace_id, session_id, storage_key, original_name, mime_type, size_bytes, sha256, scan_status, uploaded_by)
    values (${`conflict-obj-${suffix}`}, ${tenantId}, ${workspaceId}, null, ${`storage/conflict-${suffix}`}, '抢占.txt', 'text/plain', 3, ${'a'.repeat(64)}, 'clean', ${ownerId})
  `
  await database`
    insert into workspace_file_versions (id, tenant_id, logical_file_id, version_no, file_object_id, parse_status, created_by)
    values (${`conflict-ver-${suffix}`}, ${tenantId}, ${v1.logicalFileId}, 2, ${`conflict-obj-${suffix}`}, 'succeeded', ${ownerId})
  `
  await database`update workspace_files set latest_version_no = 2 where tenant_id = ${tenantId} and id = ${v1.logicalFileId}`

  const next = await content.uploadWorkspaceFileVersion({
    workspaceId,
    logicalFileId: v1.logicalFileId,
    name: '冲突之后.txt',
    mimeType: 'text/plain',
    bytes: Buffer.from('冲突之后正文'),
    note: null,
    actorUserId: ownerId,
  })
  assert.equal(next.versionNo, 3, '分配必须基于已存在的最大版本号，而不是 latest_version_no')

  // 已移除的逻辑文件不得再接受新版本（409 而不是静默升版）。
  await content.removeWorkspaceFile(workspaceId, v1.logicalFileId, ownerId)
  const removedError = await content.uploadWorkspaceFileVersion({
    workspaceId,
    logicalFileId: v1.logicalFileId,
    name: '移除后.txt',
    mimeType: 'text/plain',
    bytes: Buffer.from('移除后正文'),
    note: null,
    actorUserId: ownerId,
  }).then(() => null, (error: unknown) => error)
  assert.ok(removedError instanceof WorkspaceStateConflictError, `已移除文件必须返回类型化 409，实际：${String(removedError)}`)
  assert.equal((removedError as WorkspaceStateConflictError).status, 409)
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueWorkspace(label: string) {
  return `ws-${label}-${suffix}`
}

/**
 * Team initial upload with the logical-file assertion the TW-07 model requires;
 * returns a narrowed `logicalFileId` so the version endpoints can be exercised.
 */
async function uploadInitialFile(workspaceId: string, name: string, text: string, actorUserId: string) {
  const stored = await content.storeWorkspaceFile(workspaceId, name, 'text/plain', Buffer.from(text), actorUserId)
  assert.ok(stored.logicalFileId, '团队空间初次上传必须建立逻辑文件')
  assert.equal(stored.versionNo, 1)
  return { ...stored, logicalFileId: stored.logicalFileId, versionNo: 1 as const }
}

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

// ---------------------------------------------------------------------------
// 评审发现的权限与健壮性缺口（3-T6 修复）
// ---------------------------------------------------------------------------

test('只读成员不得上传新版本、也不得新建共享文件（方案 §5 / AC-08）', async () => {
  const workspaceId = uniqueWorkspace('viewer-write')
  const ownerId = `${workspaceId}-owner`
  const viewerId = `${workspaceId}-viewer`
  await seedUser(ownerId, '只读上传负责人')
  await seedUser(viewerId, '只读上传成员')
  await seedTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }, { userId: viewerId, role: 'viewer' }])
  const initial = await uploadInitialFile(workspaceId, '只读上传.txt', 'initial body', ownerId)
  const logicalFileId = initial.logicalFileId

  // 只读成员没有上传权限：直接调写 API 也必须被拒（AC-08），不能只靠前端不渲染。
  await assert.rejects(
    content.uploadWorkspaceFileVersion({
      workspaceId,
      logicalFileId,
      name: '只读上传-v2.txt',
      mimeType: 'text/plain',
      bytes: Buffer.from('viewer should not upload'),
      note: null,
      actorUserId: viewerId,
    }),
    /只读成员/,
  )
  const versionUpload = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/files/${logicalFileId}/versions`, {
    as: viewerId,
    raw: Buffer.from('viewer should not upload'),
    headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('只读上传-v2.txt') },
  })
  assert.equal(versionUpload.status, 403, '只读成员上传新版本必须 403（此前 201）')

  await assert.rejects(
    content.storeWorkspaceFile(workspaceId, '只读新建.txt', 'text/plain', Buffer.from('viewer file'), viewerId),
    /只读成员/,
  )
  const createUpload = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/files`, {
    as: viewerId,
    raw: Buffer.from('viewer file'),
    headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('只读新建.txt') },
  })
  assert.equal(createUpload.status, 403, '只读成员新建共享文件必须 403')

  // 对照：成员角色可以上传，说明闸门只挡只读成员。
  const memberId = `${workspaceId}-member`
  await seedUser(memberId, '普通上传成员')
  await database`
    insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
    values (${tenantId}, ${workspaceId}, ${memberId}, 'member', ${ownerId})
  `
  const memberUpload = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/files/${logicalFileId}/versions`, {
    as: memberId,
    raw: Buffer.from('member upload'),
    headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('成员上传.txt') },
  })
  assert.equal(memberUpload.status, 201, '普通成员仍可上传新版本')
})

test('畸形百分号编码的头部与安全拦截的文件体返回 422 而不是 500', async () => {
  const workspaceId = uniqueWorkspace('bad-header')
  const ownerId = `${workspaceId}-owner`
  await seedUser(ownerId, '畸形头负责人')
  await seedTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  const initial = await uploadInitialFile(workspaceId, '畸形头.txt', 'initial body', ownerId)
  const logicalFileId = initial.logicalFileId

  // decodeURIComponent 抛 URIError；客户端提供的头部不得把请求变成 500。
  for (const bad of ['%E0%A4%A', '%zz']) {
    const response = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/files/${logicalFileId}/versions`, {
      as: ownerId,
      raw: Buffer.from('body'),
      headers: { 'content-type': 'text/plain', 'x-file-name': bad },
    })
    assert.equal(response.status, 422, `畸形编码 ${bad} 必须 422`)
  }

  // 安全扫描拒绝此前是裸 Error（无分类关键字）→ 500；现为类型化 422。
  const blocked = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/files/${logicalFileId}/versions`, {
    as: ownerId,
    raw: Buffer.from('MZ  executable'),
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('伪装.txt') },
  })
  assert.equal(blocked.status, 422, '被安全拦截的文件必须 422')

  // 超大文件同样 422（HTTP 层没有 413 分类，契约已按现实声明为 422）。
  const oversized = await api('POST', `/api/workbench/v1/workspaces/${workspaceId}/files/${logicalFileId}/versions`, {
    as: ownerId,
    raw: Buffer.alloc(20 * 1024 * 1024 + 1, 0x41),
    headers: { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent('过大.txt') },
  })
  assert.equal(oversized.status, 422, '超过 20 MB 必须 422（契约不含 413）')
})

async function api(
  method: string,
  path: string,
  options: { as?: string; body?: unknown; raw?: Buffer; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  if (options.as) headers['x-test-user-id'] = options.as
  let body: string | Uint8Array | undefined
  if (options.raw !== undefined) body = new Uint8Array(options.raw)
  else if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body as BodyInit | undefined })
  const text = await response.text()
  let parsed: unknown = null
  try { parsed = JSON.parse(text) } catch { parsed = null }
  return { status: response.status, body: parsed, text }
}

async function fileObjectColumns() {
  const rows = await database<{ columnName: string }[]>`
    select column_name as "columnName" from information_schema.columns
     where table_schema = 'public' and table_name = 'file_objects'
     order by ordinal_position
  `
  return rows.map(row => row.columnName)
}

async function seedLegacySharedFiles() {
  await seedUser(legacyOwnerId, '历史共享文件负责人')
  await seedTeamWorkspace(legacyWorkspaceId, [{ userId: legacyOwnerId, role: 'owner' }])

  // 已成功解析的团队共享文件 → 回填 v1 且 latest_version_no = 1。
  await insertLegacyObject(legacyParsedObjectId, legacyWorkspaceId, null, '历史已解析.txt')
  await database`
    insert into file_extractions (id, tenant_id, file_id, extractor_version, detected_type, status, text_storage_key, text_sha256, character_count)
    values (${`${legacyParsedObjectId}-extraction`}, ${tenantId}, ${legacyParsedObjectId}, 'm4-basic-v1', 'text', 'succeeded',
            ${`storage/${legacyParsedObjectId}.txt`}, ${'c'.repeat(64)}, 4)
  `
  // 从未解析成功的团队共享文件 → 仍回填 v1 记录，但不前移有效版本号。
  await insertLegacyObject(legacyUnparsedObjectId, legacyWorkspaceId, null, '历史未解析.txt')
  // 已逻辑移除的团队共享文件 → 不回填。
  await insertLegacyObject(legacyRemovedObjectId, legacyWorkspaceId, null, '已移除历史.txt')
  await database`update file_objects set removed_at = now() where tenant_id = ${tenantId} and id = ${legacyRemovedObjectId}`
  // 个人空间文件（session_id 为空）→ 不回填。
  await insertLegacyObject(legacyPersonalObjectId, `ws-personal-${legacyOwnerId}`, null, '个人历史.txt')
  // 会话附件（session_id 非空）→ 不回填。
  const sessionId = await seedSession(legacyWorkspaceId, legacyOwnerId)
  await insertLegacyObject(legacyAttachmentObjectId, legacyWorkspaceId, sessionId, '会话附件.txt')
}

async function insertLegacyObject(id: string, workspaceId: string, sessionId: string | null, name: string) {
  await database`
    insert into file_objects (
      id, tenant_id, workspace_id, session_id, storage_key, original_name, mime_type,
      size_bytes, sha256, scan_status, uploaded_by
    ) values (
      ${id}, ${tenantId}, ${workspaceId}, ${sessionId}, ${`storage/${id}`}, ${name},
      'text/plain', 3, ${'a'.repeat(64)}, 'clean', ${legacyOwnerId}
    )
  `
}

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
    values (${workspaceId}, ${tenantId}, '3-T6 文件版本测试空间', '', 'team', ${ownerId}, 'active')
  `
  for (const member of members) {
    await database`
      insert into workspace_members (tenant_id, workspace_id, user_id, member_role, added_by)
      values (${tenantId}, ${workspaceId}, ${member.userId}, ${member.role}, ${ownerId})
    `
  }
}

/** The succeeded m4-basic-v1 extraction the upload path created for an object. */
async function succeededExtractionIdOf(fileId: string) {
  const [row] = await database<{ id: string }[]>`
    select id from file_extractions
     where tenant_id = ${tenantId} and file_id = ${fileId}
       and extractor_version = 'm4-basic-v1' and status = 'succeeded'
     order by created_at desc limit 1
  `
  assert.ok(row?.id, `文件 ${fileId} 缺少成功解析记录`)
  return row.id
}

async function seedSession(workspaceId: string, userId: string) {
  const sessionId = `session-${randomUUID()}`
  await database`
    insert into sessions (id, tenant_id, workspace_id, created_by, agent_version_id, title, status)
    values (${sessionId}, ${tenantId}, ${workspaceId}, ${userId}, 'agent-version-dsh-work-assistant-1', '版本验证会话', 'active')
  `
  return sessionId
}

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

function delay(ms: number) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms))
}// ---------------------------------------------------------------------------
// 第二轮质量评审要求补的回归锚点（3-T6 修复）
// ---------------------------------------------------------------------------

test('列表 removable 与移除鉴权使用同一版本口径（失败版本不得改变判权）', async () => {
  // 判别设计：逻辑文件创建者 = owner；被展示的 v2 上传人 = member；最高版本 v3
  // （解析失败）上传人 = owner。于是只有「按被展示版本判权」才允许 member 移除——
  // 按最高版本判权会 403，正是被修的缺陷（质量评审 F2）。
  const workspaceId = uniqueWorkspace('removable-align')
  const ownerId = `${workspaceId}-owner`
  const memberId = `${workspaceId}-member`
  await seedUser(ownerId, '口径负责人')
  await seedUser(memberId, '口径成员')
  await seedTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }, { userId: memberId, role: 'member' }])
  // v1 由 owner 上传 ⇒ 逻辑文件 created_by = owner。
  const initial = await uploadInitialFile(workspaceId, '口径.txt', 'v1 body', ownerId)

  const v2 = await content.uploadWorkspaceFileVersion({
    workspaceId,
    logicalFileId: initial.logicalFileId,
    name: '口径-v2.txt',
    mimeType: 'text/plain',
    bytes: Buffer.from('v2 body'),
    note: null,
    actorUserId: memberId,
  })
  assert.equal(v2.versionNo, 2)

  // owner 追加一个解析失败的 v3：成为「最高版本」但不成为「最高有效版本」。
  await assert.rejects(content.uploadWorkspaceFileVersion({
    workspaceId,
    logicalFileId: initial.logicalFileId,
    name: '口径-v3.txt',
    mimeType: 'text/plain',
    bytes: Buffer.from('   '),
    note: null,
    actorUserId: ownerId,
  }))

  const listed = await content.listWorkspaceFiles({ workspaceId, actorUserId: memberId, limit: 20 })
  const row = listed.items.find(item => item.logicalFileId === initial.logicalFileId)
  assert.equal(row?.versionNo, 2, '列表展示最高有效版本 v2（失败 v3 不得顶替）')
  assert.equal(row?.removable, true, '被展示版本 v2 的上传人（member）应看到可移除')

  // 关键断言：removable 为 true 的人必须真的能移除。
  const memberDenied = await content.removeWorkspaceFile(workspaceId, initial.logicalFileId, memberId)
    .then(() => null, (error: unknown) => error instanceof Error ? error.message : String(error))
  assert.equal(memberDenied, null, '口径必须一致：可移除的人应能真的移除（按最高版本判权会 403）')
})


test('扫描中的回填文件仍出现在列表与空间摘要（过滤只看 blocked）', async () => {
  // TW-05 把 pending/failed 列为可见状态；若过滤被收紧成 = 'clean'，这类文件会从
  // 列表与空间摘要里整条消失（第二轮验证 P3-4：该过滤此前无回归锚点）。
  const workspaceId = uniqueWorkspace('scan-visible')
  const ownerId = `${workspaceId}-owner`
  await seedUser(ownerId, '扫描可见负责人')
  await seedTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])

  const initial = await uploadInitialFile(workspaceId, '扫描中.txt', 'scan body', ownerId)
  // 把对象置为 pending（模拟异步扫描尚未完成），逻辑文件保持 active。
  await database`
    update file_objects set scan_status = 'pending'
     where tenant_id = ${tenantId} and id = ${initial.id}
  `

  const listed = await content.listWorkspaceFiles({ workspaceId, actorUserId: ownerId, limit: 20 })
  assert.ok(
    listed.items.some(item => item.logicalFileId === initial.logicalFileId),
    'pending 扫描的文件必须仍出现在列表里（可见「处理中」）',
  )

  const workspaces = await content.listWorkspaces(ownerId, { status: 'all' })
  const summary = workspaces.find(item => item.id === workspaceId)
  assert.ok(
    summary?.files.some(file => file.name === '扫描中.txt'),
    'pending 扫描的文件必须仍出现在空间摘要里',
  )

  // blocked 才是隐藏项。
  await database`
    update file_objects set scan_status = 'blocked'
     where tenant_id = ${tenantId} and id = ${initial.id}
  `
  const afterBlocked = await content.listWorkspaceFiles({ workspaceId, actorUserId: ownerId, limit: 20 })
  assert.equal(
    afterBlocked.items.some(item => item.logicalFileId === initial.logicalFileId),
    false,
    'blocked 的文件必须从列表消失',
  )
})

test('移除共享文件必须取得空间行锁（外部持锁时不得推进）', async () => {
  // 判别性说明：移除路径只 `update file_objects.removed_at`，不插入 `file_objects`，
  // 因此**不会**触发外键对 workspaces 的 KEY SHARE；只有显式取空间行锁才会被外部
  // 持锁者挡住。（上传路径则另有 FK 的隐式阻塞，不能用来鉴别显式锁。）
  const workspaceId = uniqueWorkspace('remove-lock')
  const ownerId = `${workspaceId}-owner`
  await seedUser(ownerId, '移除锁负责人')
  await seedTeamWorkspace(workspaceId, [{ userId: ownerId, role: 'owner' }])
  const initial = await uploadInitialFile(workspaceId, '移除锁.txt', 'body', ownerId)

  let releaseLock: () => void = () => undefined
  let lockHeld: () => void = () => undefined
  const held = new Promise<void>(resolve => { lockHeld = resolve })
  const release = new Promise<void>(resolve => { releaseLock = resolve })
  const holder = database.begin(async transaction => {
    await transaction`
      select id from workspaces
       where tenant_id = ${tenantId} and id = ${workspaceId}
       for update
    `
    lockHeld()
    await release
  })
  await held

  let settled = false
  const removal = content.removeWorkspaceFile(workspaceId, initial.logicalFileId, ownerId).then(
    value => { settled = true; return value },
    error => { settled = true; throw error },
  )

  try {
    await delay(300)
    assert.equal(settled, false, '外部持有空间行锁时移除不得推进（否则没有取行锁）')
  } finally {
    // 必须在 finally 里释放：断言失败时若跳过释放，持锁事务会挂住整个测试进程
    // （无锁实现下表现为超时而不是一条干净的红色断言）。
    releaseLock()
    await holder.catch(() => undefined)
  }

  await removal
  const [row] = await database<{ status: string }[]>`
    select status from workspace_files where tenant_id = ${tenantId} and id = ${initial.logicalFileId}
  `
  assert.equal(row?.status, 'removed', '释放锁后移除应正常完成')
})


