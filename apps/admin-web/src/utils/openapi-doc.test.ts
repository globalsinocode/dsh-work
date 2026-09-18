import { describe, expect, it } from 'vitest'

import specJson from '../../../../docs/development/openapi-mobile-h5.json'
import { collectDoc, flattenFields, typeLabel, type OpenApiDocument } from './openapi-doc'

const spec = specJson as OpenApiDocument
const docTags = collectDoc(spec)
const allOps = docTags.flatMap(tag => tag.operations)

function findOp(method: string, path: string) {
  const op = allOps.find(item => item.method === method && item.path === path)
  if (!op) throw new Error(`operation not found: ${method} ${path}`)
  return op
}

describe('openapi-doc renderer data', () => {
  it('collects every mobile operation grouped by declared tags', () => {
    expect(docTags.length).toBeGreaterThanOrEqual(5)
    expect(allOps.length).toBe(26)
    for (const op of allOps) {
      expect(op.summary).toBeTruthy()
      expect(op.permission).toBeTruthy()
      expect(op.anchor).toMatch(/^op-[a-z]+-/)
    }
    expect(docTags.map(tag => tag.name)).toEqual(['身份', '目录', '空间', '会话', '执行', '文件', '成果'])
  })

  it('renders request message with cookie auth and query params', () => {
    const op = findOp('GET', '/workspaces')
    expect(op.requestMessage).toContain('GET /api/workbench/v1/workspaces?status=active HTTP/1.1')
    expect(op.requestMessage).toContain('Cookie: dsh_work_session=')
    expect(op.parameters.map(field => field.name)).toContain('status（查询）')
  })

  it('renders JSON request body fields and message for run creation', () => {
    const op = findOp('POST', '/sessions/{sessionId}/runs')
    expect(op.requestFields.map(field => field.name)).toEqual(
      expect.arrayContaining(['prompt', 'idempotencyKey', 'fileIds[]', 'workspaceAgentMemberId']),
    )
    expect(op.requestFields.find(field => field.name === 'prompt')?.required).toBe(true)
    expect(op.requestMessage).toContain('POST /api/workbench/v1/sessions/{sessionId}/runs HTTP/1.1')
    expect(op.requestMessage).toContain('"prompt"')
  })

  it('renders binary upload with X-File-Name header', () => {
    const op = findOp('POST', '/sessions/{sessionId}/files')
    expect(op.requestContentType).toBe('application/octet-stream')
    expect(op.requestMessage).toContain('X-File-Name:')
    expect(op.requestMessage).toContain('<文件二进制内容>')
  })

  it('unwraps the envelope and flattens response data fields', () => {
    const op = findOp('GET', '/session')
    const names = op.responseFields.map(field => field.name)
    expect(names).toContain('data.user')
    expect(names).toContain('data.user.id')
    expect(names).toContain('data.identityProvider')
    expect(names).not.toContain('meta')
    expect(op.responseMessage).toContain('"data"')
    expect(op.responseMessage).toContain('"meta"')
  })

  it('flattens array item fields with [] suffix', () => {
    const op = findOp('GET', '/workspaces/{workspaceId}/sessions')
    const names = op.responseFields.map(field => field.name)
    expect(names).toContain('data.items[]')
    expect(names).toContain('data.items[].sessionId')
    expect(names).toContain('data.nextCursor')
  })

  it('renders SSE response as event-stream sample', () => {
    const op = findOp('GET', '/runs/{runId}/events')
    expect(op.responseMessage).toContain('Content-Type: text/event-stream')
    expect(op.responseMessage).toContain('"event_type"')
  })

  it('renders binary download response', () => {
    const op = findOp('GET', '/files/{fileId}/download')
    expect(op.responseMessage).toContain('application/octet-stream')
    expect(op.responseMessage).toContain('Content-Disposition')
    expect(op.responseFields.length).toBe(0)
  })

  it('typeLabel maps schema types to display labels', () => {
    expect(typeLabel(spec, { type: 'string' })).toBe('String')
    expect(typeLabel(spec, { type: 'integer' })).toBe('Integer')
    expect(typeLabel(spec, { type: 'boolean' })).toBe('Boolean')
    expect(typeLabel(spec, { type: 'array', items: { type: 'string' } })).toBe('String[]')
    expect(typeLabel(spec, { enum: ['a', 'b'] })).toBe('String')
    expect(typeLabel(spec, { anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe('String | Null')
  })

  it('flattenFields marks required fields and resolves $ref', () => {
    const fields = flattenFields(spec, { $ref: '#/components/schemas/SessionThread' })
    const sessionId = fields.find(field => field.name === 'sessionId')
    expect(sessionId?.required).toBe(true)
    // currentUserRole 必填但可空（anyOf TeamMemberRole|null）
    expect(fields.find(field => field.name === 'currentUserRole')?.required).toBe(true)
    expect(fields.find(field => field.name === 'messages[].senderId')?.required).toBe(false)
  })
})
