import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { invalidRequest, RequestError } from '../../domain/request-errors.ts'
import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import {
  toWeknoraIdentity,
  WeknoraAccessService,
} from '../../modules/weknora/access.ts'
import { WeknoraClient } from '../../modules/weknora/client.ts'
import { loadWeknoraConfig } from '../../modules/weknora/config.ts'
import { WeknoraLinkStore } from '../../modules/weknora/link-store.ts'
import { PostgresWeknoraUserDirectoryLookup } from '../../modules/weknora/user-directory-lookup.ts'
import { envelope, readJsonBody, requireRequestIdentity, type RouteContext, type Router } from '../router.ts'

const basePath = '/api/workbench/v1'

export function createWeknoraAccessService(database: DatabaseClient) {
  const config = loadWeknoraConfig()
  const client = config ? new WeknoraClient(config) : null
  return new WeknoraAccessService(
    config,
    client,
    new WeknoraLinkStore(database),
    new PostgresWeknoraUserDirectoryLookup(database),
  )
}

export function registerWeknoraRoutes(
  router: Router,
  access: WeknoraAccessService,
  adapter: 'postgres' | 'prototype-memory' = 'postgres',
) {
  router.get(`${basePath}/integrations/weknora/status`, async (_request, context) => {
    const identity = await loadIdentity(context, access)
    return envelope('workbench', await access.getStatus(identity), adapter)
  })

  router.post(`${basePath}/integrations/weknora/bind/start`, async (request, context) => {
    const identity = await loadIdentity(context, access)
    const origin = resolveOrigin(request)
    const state = randomBytes(24).toString('hex')
    const redirectUri = `${origin}${basePath}/integrations/weknora/bind/callback`
    const started = await access.startBind(identity, redirectUri, state)
    return envelope('workbench', started, adapter)
  })

  router.get(`${basePath}/integrations/weknora/bind/callback`, async (request, context, response) => {
    void context
    const url = new URL(request.url ?? '/', 'http://localhost')
    const state = url.searchParams.get('state') ?? ''
    const bindCode = url.searchParams.get('bind_code')
    const bindError = url.searchParams.get('bind_error')
    const origin = resolveOrigin(request)
    const redirect = (query: string) => {
      response.writeHead(302, { Location: `${origin}/knowledge?${query}` })
      response.end()
      return null
    }
    if (bindError || !bindCode) return redirect('bind=failed')
    const userId = await access.consumeBindState(state)
    if (!userId) return redirect('bind=failed')
    try {
      await access.completeBind(userId, bindCode)
      return redirect('bind=ok')
    } catch {
      return redirect('bind=failed')
    }
  })

  router.delete(`${basePath}/integrations/weknora/link`, async (_request, context) => {
    const identity = await loadIdentity(context, access)
    await access.unlink(identity)
    return envelope('workbench', { ok: true }, adapter)
  })

  router.get(`${basePath}/integrations/weknora/knowledge-bases`, async (_request, context) => {
    const identity = await loadIdentity(context, access)
    const client = access.client
    if (!client) throw accessNotConfigured()
    const list = await access.withAccessToken(identity, token => client.listKnowledgeBases(token))
    return envelope('workbench', { list }, adapter)
  })

  router.get(`${basePath}/integrations/weknora/knowledge-bases/:id`, async (_request, context) => {
    const identity = await loadIdentity(context, access)
    const client = access.client
    if (!client) throw accessNotConfigured()
    const kb = await access.withAccessToken(
      identity,
      token => client.getKnowledgeBase(token, context.params.id!),
    )
    return envelope('workbench', kb, adapter)
  })

  router.get(`${basePath}/integrations/weknora/knowledge-bases/:id/documents`, async (_request, context) => {
    const identity = await loadIdentity(context, access)
    const client = access.client
    if (!client) throw accessNotConfigured()
    const list = await access.withAccessToken(
      identity,
      token => client.listDocuments(token, context.params.id!),
    )
    return envelope('workbench', { list }, adapter)
  })

  router.post(`${basePath}/integrations/weknora/knowledge-bases/:id/search`, async (request, context) => {
    const identity = await loadIdentity(context, access)
    const client = access.client
    if (!client) throw accessNotConfigured()
    const body = await readJsonBody<{ query?: unknown }>(request)
    const query = typeof body.query === 'string' ? body.query.trim() : ''
    if (!query) throw invalidRequest('请输入检索关键词')
    const list = await access.withAccessToken(
      identity,
      token => client.searchKnowledgeBase(token, context.params.id!, query),
    )
    return envelope('workbench', { list }, adapter)
  })

  router.get(`${basePath}/integrations/weknora/documents/:id/content`, async (request, context, response) => {
    const identity = await loadIdentity(context, access)
    const client = access.client
    if (!client) throw accessNotConfigured()
    const url = new URL(request.url ?? '/', 'http://localhost')
    const disposition = url.searchParams.get('disposition') === 'inline' ? 'inline' : 'attachment'
    const upstream = await access.withAccessToken(
      identity,
      token => client.fetchDocumentContent(token, context.params.id!),
    )
    const headers: Record<string, string> = {}
    const contentType = upstream.headers.get('content-type')
    if (contentType) headers['Content-Type'] = contentType
    const contentDisposition = upstream.headers.get('content-disposition')
    headers['Content-Disposition'] = contentDisposition ?? disposition
    response.writeHead(upstream.status, headers)
    response.end(Buffer.from(await upstream.arrayBuffer()))
    return null
  })
}

async function loadIdentity(context: RouteContext, access: WeknoraAccessService) {
  const requestIdentity = requireRequestIdentity(context, 'workbench')
  const externalUserId = await access.loadExternalUserId(requestIdentity.userId)
  return toWeknoraIdentity(requestIdentity, externalUserId)
}

function resolveOrigin(request: IncomingMessage) {
  const host = request.headers.host ?? 'localhost'
  const protocol = request.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'
  return `${protocol}://${host}`
}

function accessNotConfigured() {
  return new RequestError(503, 'weknora_not_configured', '知识库尚未配置')
}
