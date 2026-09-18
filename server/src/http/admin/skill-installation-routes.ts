import { requestInvalid } from '../../modules/authorization/authorization-errors.ts'
import type { IncomingMessage } from 'node:http'

import type { AdminSkillInstallationService } from '../../modules/skill/admin-skill-installation-service.ts'
import { envelope, httpResult, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'

const maxUploadBytes = 20 * 1024 * 1024

export function registerSkillInstallationRoutes(router: Router, service?: AdminSkillInstallationService) {
  const base = '/api/admin/v1/skill-installations'
  const available = () => {
    if (!service) throw Object.assign(new Error('Skill 安装服务不可用：请配置 PostgreSQL'), { status: 503, code: 'skill_installation_unavailable' })
    return service
  }

  router.post(base, async (request, context) => {
    const fileName = decodeHeader(request, 'x-file-name')
    const bytes = await readBinaryBody(request, maxUploadBytes)
    const result = await available().prepareZip(requireRequestIdentity(context, 'admin').userId, { fileName, bytes })
    return httpResult(201, envelope('admin', result, 'postgres'))
  })

  router.post(`${base}/link`, async (request, context, response) => {
    const input = await readJsonBody<{ url: string; selected?: string }>(request)
    const controller = new AbortController()
    const disconnect = () => { if (!response.writableEnded) controller.abort(new Error('安装请求已断开')) }
    request.once('aborted', disconnect)
    response.once('close', disconnect)
    try {
      const result = await available().prepareLink(requireRequestIdentity(context, 'admin').userId, input, controller.signal)
      return httpResult(201, envelope('admin', result, 'postgres'))
    } finally { request.off('aborted', disconnect); response.off('close', disconnect) }
  })

  router.get(`${base}/:id`, async (_request, context) => envelope('admin',
    await available().getDirectInstallation(requireRequestIdentity(context, 'admin').userId, context.params['id']!), 'postgres'))

  router.delete(`${base}/:id`, async (_request, context) => envelope('admin',
    await available().cancelDirect(requireRequestIdentity(context, 'admin').userId, context.params['id']!), 'postgres'))

  router.post(`${base}/:id/confirm`, async (request, context) => {
    const input = await readJsonBody<{ planSha256: string }>(request)
    if (!input || Object.keys(input).some(key => key !== 'planSha256')) throw requestInvalid('安装确认字段无效')
    const result = await available().confirmDirect(requireRequestIdentity(context, 'admin').userId, context.params['id']!, input?.planSha256)
    return envelope('admin', result, 'postgres')
  })
}

function decodeHeader(request: IncomingMessage, name: string) {
  const raw = request.headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (!value) throw new Error('缺少 Skill 包文件名')
  try {
    return decodeURIComponent(value)
  } catch {
    throw new Error('Skill 包文件名编码无效')
  }
}

async function readBinaryBody(request: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += bytes.length
    if (length > maxBytes) throw new Error('Skill 包超过 20 MB 限制')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}
