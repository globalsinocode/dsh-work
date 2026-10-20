import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { ModelGovernanceService } from '../../modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from '../../modules/model/postgres-model-governance-repository.ts'
import { RunOrchestrationService } from '../../modules/run/run-orchestration-service.ts'
import { PostgresRunRepository } from '../../modules/run/postgres-run-repository.ts'
import type {
  AgentRuntimePort,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeExecutionHandle,
  RuntimeExecutionSnapshot,
  RuntimeManifest,
} from '../../modules/runtime/runtime-types.ts'
import { PostgresContentService } from '../../modules/workbench/application/postgres-content-service.ts'
import { PostgresConversationRepository } from '../../modules/workbench/application/postgres-conversation-repository.ts'
import type { DatabaseClient } from './database.ts'
import { createThrowawayDatabase, type ThrowawayDatabase } from './test-database.ts'
import { LocalObjectStorage } from '../storage/local-object-storage.ts'

const databaseUrl = process.env.DSH_WORK_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('DSH_WORK_TEST_DATABASE_URL 未配置')

let database: DatabaseClient
let throwaway: ThrowawayDatabase
let storageRoot: string
let content: PostgresContentService
let conversations: PostgresConversationRepository
let runtime: CapturingFileRuntime
let orchestration: RunOrchestrationService

before(async () => {
  // 一次性库：避免共享 dev 库的历史数据累积影响断言。
  throwaway = await createThrowawayDatabase({ namePrefix: 'dsh_work_m4_file_test', maxConnections: 5 })
  database = throwaway.client
  storageRoot = await mkdtemp(join(tmpdir(), 'dsh-work-m4-file-'))
  content = new PostgresContentService(database, new LocalObjectStorage(storageRoot), new PostgresAuthorizationService(database))
  conversations = new PostgresConversationRepository(database)
  runtime = new CapturingFileRuntime()
  orchestration = new RunOrchestrationService(
    new PostgresRunRepository(database),
    conversations,
    new ModelGovernanceService(new PostgresModelGovernanceRepository(database)),
    runtime,
    content,
  )
})

after(async () => {
  if (orchestration) await orchestration.close()
  await throwaway.dispose()
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
})

test('uploaded Session file is extracted, snapshotted and injected as an immutable Runtime mount', async () => {
  const session = await orchestration.createSession({ userId: 'U00001', title: '库存文件分析' })
  const uploaded = await content.storeSessionFile(
    session.id,
    'inventory.csv',
    'text/csv',
    Buffer.from('物料,区域,库存\nA-01,华东,120\nB-02,华南,8\n'),
    'U00001',
  )
  assert.equal(uploaded.extractionStatus, 'succeeded')

  const created = await orchestration.startRun({
    userId: 'U00001',
    sessionId: session.id,
    prompt: '分析库存风险',
    idempotencyKey: randomUUID(),
    fileIds: [uploaded.id],
  })
  assert.ok(created)
  const task = await waitForTask(created.id)
  const manifest = runtime.manifest(created.id)
  assert.equal(manifest?.input.file_mounts.length, 1)
  assert.equal(manifest?.input.file_mounts[0]?.source_name, 'inventory.csv')
  assert.equal(manifest?.input.file_mounts[0]?.access, 'read_only')
  assert.match(manifest?.input.file_mounts[0]?.content ?? '', /A-01\t华东\t120/)
  assert.deepEqual(task.attachments, ['inventory.csv'])

  const [snapshot] = await database<{
    count: number
    textSha256: string
    mountPath: string
  }[]>`
    select count(*)::integer as count, min(fe.text_sha256) as "textSha256",
           min(rif.mount_path) as "mountPath"
      from run_input_files rif
      join file_extractions fe on fe.tenant_id = rif.tenant_id and fe.id = rif.extraction_id
     where rif.tenant_id = 'tenant-dsh-work' and rif.run_id = ${created.id}
  `
  assert.equal(snapshot?.count, 1)
  assert.match(snapshot?.textSha256 ?? '', /^[a-f0-9]{64}$/)
  assert.equal(snapshot?.mountPath, '/workspace/input/01-inventory.txt')
})

test('workbook pictures travel from extraction to the Runtime manifest as attachments', async () => {
  const session = await orchestration.createSession({ userId: 'U00001', title: '带图片的表格' })
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(96, 0x11)])
  const uploaded = await content.storeSessionFile(
    session.id,
    '客诉记录.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    storedZip({
      'xl/workbook.xml': Buffer.from('<workbook><sheets><sheet name="客诉" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      'xl/worksheets/sheet1.xml': Buffer.from('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>照片</t></is></c></row></sheetData></worksheet>'),
      'xl/worksheets/_rels/sheet1.xml.rels': Buffer.from('<Relationships><Relationship Id="rId1" Target="../drawings/drawing1.xml"/></Relationships>'),
      'xl/drawings/drawing1.xml': Buffer.from(
        '<xdr:wsDr><xdr:twoCellAnchor><xdr:from><xdr:row>0</xdr:row></xdr:from>'
        + '<xdr:pic><xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill></xdr:pic></xdr:twoCellAnchor></xdr:wsDr>',
      ),
      'xl/drawings/_rels/drawing1.xml.rels': Buffer.from('<Relationships><Relationship Id="rId1" Target="../media/image1.png"/></Relationships>'),
      'xl/media/image1.png': png,
    }),
    'U00001',
  )
  assert.equal(uploaded.extractionStatus, 'succeeded')

  const created = await orchestration.startRun({
    userId: 'U00001', sessionId: session.id, prompt: '看看照片里的问题', idempotencyKey: randomUUID(), fileIds: [uploaded.id],
  })
  assert.ok(created)
  await waitForTask(created.id)
  const manifest = runtime.manifest(created.id)
  assert.match(manifest?.input.file_mounts[0]?.content ?? '', /内嵌图片：1 张/)
  const attachments = manifest?.input.attachments ?? []
  assert.equal(attachments.length, 1)
  assert.equal(attachments[0]?.name, 'image-1.png')
  assert.equal(attachments[0]?.mount_path, '/workspace/input/attachments/image-1.png')
  assert.equal(attachments[0]?.media_type, 'image/png')
  assert.deepEqual(Buffer.from(attachments[0]?.content_base64 ?? '', 'base64'), png)

  const [row] = await database<{ attachments: Array<{ name: string; storage_key: string; size: number }> }[]>`
    select fe.attachments from file_extractions fe
     where fe.tenant_id = 'tenant-dsh-work' and fe.file_id = ${uploaded.id} and fe.status = 'succeeded'
     order by fe.created_at desc limit 1
  `
  assert.equal(row?.attachments[0]?.name, 'image-1.png')
  assert.match(row?.attachments[0]?.storage_key ?? '', /^extractions\/file-/)
  assert.equal(row?.attachments[0]?.size, png.length)
})

test('file authorization and parser failures are fail-closed and traceable', async () => {
  const session = await orchestration.createSession({ userId: 'U00001', title: '失败文件验证' })
  const uploaded = await content.storeSessionFile(session.id, 'notes.txt', 'text/plain', Buffer.from('仅当前用户可读'), 'U00001')
  await assert.rejects(
    content.prepareRuntimeFiles({ sessionId: session.id, fileIds: [uploaded.id], userId: 'U00008' }),
    /不存在、不可访问或解析未成功/,
  )

  await assert.rejects(
    content.storeSessionFile(session.id, 'disguised.pdf', 'application/pdf', Buffer.from('not a real pdf'), 'U00001'),
    /PDF_SIGNATURE_INVALID/,
  )
  const [failure] = await database<{ status: string; errorCode: string }[]>`
    select status, error_code as "errorCode" from file_extractions
     where tenant_id = 'tenant-dsh-work' and status = 'failed'
     order by created_at desc limit 1
  `
  assert.equal(failure?.status, 'failed')
  assert.equal(failure?.errorCode, 'PDF_SIGNATURE_INVALID')
})

async function waitForTask(runId: string) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const task = await conversations.getTask(runId, 'U00001')
    if (task?.status === 'succeeded') return task
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('等待文件分析 Run 完成超时')
}

interface Execution {
  manifest: RuntimeManifest
  events: RuntimeEvent[]
  listeners: Set<RuntimeEventListener>
  snapshot: RuntimeExecutionSnapshot
  done: Promise<RuntimeExecutionSnapshot>
  resolveDone: (snapshot: RuntimeExecutionSnapshot) => void
}

class CapturingFileRuntime implements AgentRuntimePort {
  private readonly executions = new Map<string, Execution>()

  async execute(manifest: RuntimeManifest): Promise<RuntimeExecutionHandle> {
    let resolveDone: (snapshot: RuntimeExecutionSnapshot) => void = () => undefined
    const done = new Promise<RuntimeExecutionSnapshot>(resolve => { resolveDone = resolve })
    const now = new Date().toISOString()
    const snapshot: RuntimeExecutionSnapshot = {
      runId: manifest.run_id,
      attemptId: manifest.attempt_id,
      status: 'queued',
      acceptedAt: now,
      startedAt: null,
      endedAt: null,
      manifestSha256: 'file-analysis-test',
      attemptDirectory: '/tmp/file-analysis-test',
      errorCode: null,
      errorMessage: null,
    }
    const execution = { manifest, events: [], listeners: new Set<RuntimeEventListener>(), snapshot, done, resolveDone }
    this.executions.set(manifest.run_id, execution)
    this.emit(execution, 'run.queued', '文件分析已排队')
    setTimeout(() => {
      execution.snapshot.status = 'running'
      execution.snapshot.startedAt = new Date().toISOString()
      this.emit(execution, 'run.started', '开始分析文件')
      this.emit(execution, 'assistant.completed', '库存文件分析完成：B-02 库存较低。')
      execution.snapshot.status = 'completed'
      execution.snapshot.endedAt = new Date().toISOString()
      this.emit(execution, 'run.completed', '文件分析完成')
      execution.resolveDone(structuredClone(execution.snapshot))
    }, 10)
    return { runId: manifest.run_id, attemptId: manifest.attempt_id, acceptedAt: now, done }
  }

  subscribe(runId: string, listener: RuntimeEventListener) {
    const execution = this.executions.get(runId)
    if (!execution) throw new Error('Run not found')
    execution.events.forEach(listener)
    execution.listeners.add(listener)
    return () => execution.listeners.delete(listener)
  }

  async cancel() { return { accepted: false } }
  status(runId: string) { return this.executions.get(runId)?.snapshot }
  async health() {
    return { status: 'healthy' as const, runtimeId: 'runtime-local-01', activeExecutions: 0, acceptingRuns: true, dshRepository: '/tmp', transport: 'acp-stdio' as const, message: 'test' }
  }
  async close() {}
  manifest(runId: string) { return this.executions.get(runId)?.manifest }

  private emit(execution: Execution, eventType: RuntimeEvent['event_type'], displayMessage: string) {
    const event: RuntimeEvent = {
      event_id: randomUUID(),
      run_id: execution.manifest.run_id,
      attempt_id: execution.manifest.attempt_id,
      sequence: execution.events.length + 1,
      event_type: eventType,
      occurred_at: new Date().toISOString(),
      display_message: displayMessage,
      safe_metadata: {},
      trace_id: `trace-${execution.manifest.run_id}`,
      parent_event_id: execution.events.at(-1)?.event_id ?? null,
    }
    execution.events.push(event)
    execution.listeners.forEach(listener => listener(event))
  }
}

/** 只存储不压缩的 ZIP：集成测试要的是能被解析的最小 Office 包。 */
function storedZip(entries: Record<string, Buffer>) {
  const local: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt32LE(content.length, 18)
    header.writeUInt32LE(content.length, 22)
    header.writeUInt16LE(nameBytes.length, 26)
    local.push(header, nameBytes, content)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt32LE(content.length, 20)
    entry.writeUInt32LE(content.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    directory.push(entry, nameBytes)
    offset += 30 + nameBytes.length + content.length
  }
  const central = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  const count = Object.keys(entries).length
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, central, end])
}
