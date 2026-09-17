import type { IncomingMessage, ServerResponse } from 'node:http'

import type { PostgresContentService } from '../../modules/workbench/application/postgres-content-service.ts'
import type { PostgresWorkspaceAgentMemberService } from '../../modules/workbench/application/postgres-workspace-agent-member-service.ts'
import type { PostgresAuthorizationService } from '../../modules/authorization/postgres-authorization-service.ts'
import { DEFAULT_WORKBENCH_AGENT_ID } from '../../modules/agent/postgres-agent-service.ts'
import { envelope, httpResult, readJsonBody, requireRequestIdentity, routeValidationFailed, sessionAuthorizationContext, type Router } from '../router.ts'

const basePath = '/api/workbench/v1'

function parseFilePageLimit(raw: string | null) {
  if (raw === null || raw === '') return undefined
  const limit = Number(raw)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit 必须为 1 到 100 之间的整数')
  return limit
}

/**
 * Workspace lifecycle filter (3-T2). Defaults to `all` per the confirmed design
 * decision (设计 §2.1/§6「默认全部；个人空间恒显」): with a default of `active`
 * an archived workspace would be undiscoverable in the UI, which would defeat
 * 3-T2. `active`/`archived` power the 3-T3 筛选. Anything else is an explicit
 * 422 rather than a silently ignored parameter.
 */
function parseWorkspaceStatus(raw: string | null): 'active' | 'archived' | 'all' {
  // 默认 all：设计 §2.1 与 §6 已确认决策「默认全部；个人空间恒显」，且归档空间必须
  // 在默认视图里可发现，否则 3-T2 做完也无法从 UI 进入归档详情。
  if (raw === null || raw === '') return 'all'
  if (raw === 'active' || raw === 'archived' || raw === 'all') return raw
  throw routeValidationFailed('status 必须为 active、archived 或 all')
}

export function registerContentRoutes(
  router: Router,
  content: PostgresContentService,
  authorization?: PostgresAuthorizationService,
  agentMembers?: PostgresWorkspaceAgentMemberService,
) {
  router.get(`${basePath}/workspaces`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    await authorization?.authorizeWorkbench({ userId, ...sessionAuthorizationContext(identity) })
    const status = parseWorkspaceStatus(context.url.searchParams.get('status'))
    return envelope('workbench', await content.listWorkspaces(userId, { status }), 'postgres')
  })

  router.post(`${basePath}/workspaces`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    const access = await authorization?.authorizeWorkbench({ userId, ...sessionAuthorizationContext(identity) })
    const body = await readJsonBody<{ name: string; description?: string }>(request)
    if (body.name.trim().length < 2) throw new Error('工作空间名称至少需要 2 个字符')
    const workspace = await content.createWorkspace({
      name: body.name,
      description: body.description ?? '',
    }, userId)
    // 新团队空间自动加入平台默认 Agent（复用 addAgentMember 的版本固定与
    // 授权派生事务）。默认 Agent 对该创建者不可用（未发布/未开放加入/
    // 可见角色不含创建者/依赖闭包失效）时降级为「无 Agent」空态，
    // 空间照常创建，由负责人后续手动添加。
    if (workspace && agentMembers) {
      try {
        await agentMembers.addAgentMember(
          workspace.id,
          DEFAULT_WORKBENCH_AGENT_ID,
          userId,
          access?.roleIds ?? identity.roleIds,
        )
      } catch (error) {
        console.warn('auto-join default agent failed', { workspaceId: workspace.id, error })
      }
    }
    return httpResult(201, envelope('workbench', workspace, 'postgres'))
  })

  // 3-T3 依赖：团队空间名称/说明保存（1A 遗留的 PATCH）。仅负责人；清空说明显式传 null。
  router.patch(`${basePath}/workspaces/:workspaceId`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const body = await readJsonBody<{ name?: unknown; description?: unknown } | null>(request)
    // JSON `null` 能通过 JSON.parse，但不是对象：直接读 body.name 会抛 TypeError 并被
    // 分类成 500。契约的 requestBody 是 object，这里显式 422（质量评审 F8）。
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw routeValidationFailed('请求体必须是 JSON 对象')
    }
    if (body.name !== undefined && typeof body.name !== 'string') {
      throw routeValidationFailed('name 必须是字符串')
    }
    if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
      throw routeValidationFailed('description 必须是字符串或 null')
    }
    return envelope(
      'workbench',
      await content.updateWorkspace(
        context.params['workspaceId'] ?? '',
        {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.description === undefined ? {} : { description: body.description as string | null }),
        },
        identity.userId,
      ),
      'postgres',
    )
  })

  router.get(`${basePath}/artifacts`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    await authorization?.authorizeWorkbench({ userId, ...sessionAuthorizationContext(identity) })
    return envelope('workbench', await content.listArtifacts(userId), 'postgres')
  })

  router.post(`${basePath}/workspaces/:workspaceId/files`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    await authorization?.authorizeWorkbench({
      userId,
      workspaceId: context.params['workspaceId'],
      ...sessionAuthorizationContext(identity),
    })
    const fileNameHeader = request.headers['x-file-name']
    const encodedName = Array.isArray(fileNameHeader) ? fileNameHeader[0] : fileNameHeader
    if (!encodedName) throw new Error('缺少文件名')
    const name = decodeFileNameHeader(encodedName)
    const bytes = await readBinaryBody(request, 20 * 1024 * 1024)
    const file = await content.storeWorkspaceFile(
      context.params['workspaceId'] ?? '',
      name,
      request.headers['content-type'] ?? 'application/octet-stream',
      bytes,
      userId,
    )
    return httpResult(201, envelope('workbench', file, 'postgres'))
  })

  // 共享文件列表属读取轨（3-T1）：路由闸门必须跟服务层同轨，否则归档空间会在路由层
  // 被 403、读轨代码不可达（符合性评审 P1-1）。
  router.get(`${basePath}/workspaces/:workspaceId/files`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    const workspaceId = context.params['workspaceId'] ?? ''
    await authorization?.authorizeWorkbench({
      userId,
      workspaceId,
      ...sessionAuthorizationContext(identity),
      allowArchived: true,
    })
    const limit = parseFilePageLimit(context.url.searchParams.get('limit'))
    const query = (context.url.searchParams.get('query') ?? '').trim()
    const cursor = context.url.searchParams.get('cursor') ?? undefined
    return envelope(
      'workbench',
      await content.listWorkspaceFiles({ workspaceId, actorUserId: userId, query, cursor, limit }),
      'postgres',
    )
  })

  // 逻辑移除（1B-T3）：负责人/管理员可移除任何文件，成员仅可移除自己上传的；
  // 文件对象、解析结果与历史 Run 引用保留（AC-13）。
  router.delete(`${basePath}/workspaces/:workspaceId/files/:fileId`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    const workspaceId = context.params['workspaceId'] ?? ''
    await authorization?.authorizeWorkbench({
      userId,
      workspaceId,
      ...sessionAuthorizationContext(identity),
    })
    return envelope(
      'workbench',
      await content.removeWorkspaceFile(workspaceId, context.params['fileId'] ?? '', userId),
      'postgres',
    )
  })

  // TW-07 版本列表：读取轨（3-T1），归档空间的现任成员仍可查看历史版本。
  router.get(`${basePath}/workspaces/:workspaceId/files/:logicalFileId/versions`, async (_request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    const workspaceId = context.params['workspaceId'] ?? ''
    await authorization?.authorizeWorkbench({
      userId,
      workspaceId,
      ...sessionAuthorizationContext(identity),
      allowArchived: true,
    })
    return envelope(
      'workbench',
      await content.listWorkspaceFileVersions({
        workspaceId,
        logicalFileId: context.params['logicalFileId'] ?? '',
        actorUserId: userId,
      }),
      'postgres',
    )
  })

  // TW-07 新版本上传：执行轨，归档空间在路由层即被拒绝（与服务层执行轨同口径）。
  router.post(`${basePath}/workspaces/:workspaceId/files/:logicalFileId/versions`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    const workspaceId = context.params['workspaceId'] ?? ''
    await authorization?.authorizeWorkbench({
      userId,
      workspaceId,
      ...sessionAuthorizationContext(identity),
    })
    const encodedName = headerValue(request, 'x-file-name')
    if (!encodedName) throw routeValidationFailed('缺少文件名')
    const encodedNote = headerValue(request, 'x-file-note')
    const bytes = await readBinaryBody(request, 20 * 1024 * 1024)
    const uploaded = await content.uploadWorkspaceFileVersion({
      workspaceId,
      logicalFileId: context.params['logicalFileId'] ?? '',
      name: decodeFileNameHeader(encodedName),
      mimeType: request.headers['content-type'] ?? 'application/octet-stream',
      bytes,
      // 未提供说明时保持 null（契约声明 `string | null`）：空字符串与「未填写」
      // 在展示与回填口径上不是一回事（第二轮验证 P3-5）。
      note: encodedNote ? decodeFileNameHeader(encodedNote).slice(0, 500) : null,
      actorUserId: userId,
    })
    return httpResult(201, envelope('workbench', uploaded, 'postgres'))
  })

  // TW-07 指定版本下载：解析到不可变对象后仍走既有 readFile 读门禁
  // （readFile → canReadWorkspaceObject），归档空间对现任成员可读、失权成员拒绝。
  router.get(`${basePath}/workspaces/:workspaceId/files/:logicalFileId/versions/:versionNo/download`, async (_request, context, response) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    const workspaceId = context.params['workspaceId'] ?? ''
    await authorization?.authorizeWorkbench({
      userId,
      workspaceId,
      ...sessionAuthorizationContext(identity),
      allowArchived: true,
    })
    const versionNo = Number(context.params['versionNo'])
    if (!Number.isInteger(versionNo) || versionNo < 1) throw routeValidationFailed('文件版本号无效')
    const fileId = await content.resolveWorkspaceFileVersionFileId({
      workspaceId,
      logicalFileId: context.params['logicalFileId'] ?? '',
      versionNo,
      actorUserId: userId,
    })
    const file = await content.readFile(fileId, userId)
    writeDownload(response, file.name, file.mimeType, file.bytes)
  })

  router.post(`${basePath}/sessions/:sessionId/files`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    await authorization?.authorizeWorkbench({ userId, ...sessionAuthorizationContext(identity) })
    const fileNameHeader = request.headers['x-file-name']
    const encodedName = Array.isArray(fileNameHeader) ? fileNameHeader[0] : fileNameHeader
    if (!encodedName) throw new Error('缺少文件名')
    const name = decodeFileNameHeader(encodedName)
    const bytes = await readBinaryBody(request, 20 * 1024 * 1024)
    const file = await content.storeSessionFile(
      context.params['sessionId'] ?? '',
      name,
      request.headers['content-type'] ?? 'application/octet-stream',
      bytes,
      userId,
    )
    return httpResult(201, envelope('workbench', file, 'postgres'))
  })

  router.get(`${basePath}/files/:fileId/download`, async (_request, context, response) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    await authorization?.authorizeWorkbench({ userId, ...sessionAuthorizationContext(identity) })
    const file = await content.readFile(context.params['fileId'] ?? '', userId)
    writeDownload(response, file.name, file.mimeType, file.bytes)
  })

  router.get(`${basePath}/artifacts/:artifactId/download`, async (_request, context, response) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    await authorization?.authorizeWorkbench({ userId, ...sessionAuthorizationContext(identity) })
    const fileId = await content.artifactFileId(context.params['artifactId'] ?? '', undefined, userId)
    const file = await content.readFile(fileId, userId)
    writeDownload(response, file.name, file.mimeType, file.bytes)
  })

  router.get(`${basePath}/artifacts/:artifactId/versions/:versionId/download`, async (_request, context, response) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const userId = identity.userId
    await authorization?.authorizeWorkbench({ userId, ...sessionAuthorizationContext(identity) })
    const version = Number(context.params['versionId'])
    if (!Number.isInteger(version) || version < 1) throw new Error('Artifact 版本号无效')
    const fileId = await content.artifactFileId(context.params['artifactId'] ?? '', version, userId)
    const file = await content.readFile(fileId, userId)
    writeDownload(response, file.name, file.mimeType, file.bytes)
  })
}

/**
 * Decodes an `X-File-Name` / `X-File-Note` header. `decodeURIComponent` throws a
 * `URIError` on malformed percent-encoding, which `classifyHttpError` maps to a 500;
 * a client-supplied header must never do that, so translate it to a typed 422.
 * Empty/absent input decodes to '' and callers decide what that means.
 */
function decodeFileNameHeader(value: string | undefined): string {
  if (!value) return ''
  try {
    return decodeURIComponent(value)
  } catch {
    throw routeValidationFailed('文件名或说明的编码无效')
  }
}

async function readBinaryBody(request: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += bytes.length
    if (length > maxBytes) throw new Error('文件超过 20 MB 限制')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

export function writeDownload(response: ServerResponse, name: string, mimeType: string, bytes: Buffer) {
  const safeName = name.replace(/[\r\n"]/g, '_')
  response.writeHead(200, {
    'Cache-Control': 'private, no-store',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    'Content-Length': bytes.length,
    'Content-Type': mimeType,
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(bytes)
}

/** Node collapses repeated headers to an array; take the first value. */
function headerValue(request: IncomingMessage, name: string) {
  const header = request.headers[name]
  return Array.isArray(header) ? header[0] : header
}
