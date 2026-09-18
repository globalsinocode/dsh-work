/**
 * 将移动端 OpenAPI 契约（docs/development/openapi-mobile-h5.json）渲染数据化：
 * 端点信息表、原始请求/响应报文示例、响应 data 字段表。
 * 只实现本契约用到的 OpenAPI 子集（$ref / type / enum / array / object /
 * anyOf / nullable 联合），不是通用 OpenAPI 解析器。
 */

export interface OpenApiSchema {
  type?: string | string[]
  format?: string
  enum?: unknown[]
  items?: OpenApiSchema
  properties?: Record<string, OpenApiSchema>
  required?: string[]
  anyOf?: OpenApiSchema[]
  $ref?: string
  description?: string
  example?: unknown
  additionalProperties?: boolean | OpenApiSchema
}

interface OpenApiParameter {
  name: string
  in: 'path' | 'query' | 'header'
  required?: boolean
  description?: string
  schema?: OpenApiSchema
}

interface OpenApiMedia {
  schema?: OpenApiSchema
}

interface OpenApiResponse {
  description?: string
  content?: Record<string, OpenApiMedia>
  $ref?: string
}

interface OpenApiOperation {
  operationId?: string
  summary?: string
  description?: string
  tags?: string[]
  parameters?: Array<OpenApiParameter | { $ref: string }>
  requestBody?: { required?: boolean; content?: Record<string, OpenApiMedia> }
  responses?: Record<string, OpenApiResponse>
  'x-permission'?: string
}

export interface OpenApiDocument {
  openapi: string
  info: { title: string; version: string; description?: string }
  servers?: Array<{ url: string }>
  tags?: Array<{ name: string; description?: string }>
  paths?: Record<string, Record<string, OpenApiOperation>>
  components?: {
    schemas?: Record<string, OpenApiSchema>
    parameters?: Record<string, OpenApiParameter>
    responses?: Record<string, OpenApiResponse>
  }
}

export interface DocField {
  /** 字段路径，如 `data.items[].id` */
  name: string
  /** 展示类型，如 String / Integer / Object[] */
  type: string
  required: boolean
  description: string
}

export interface DocOperation {
  anchor: string
  method: string
  path: string
  summary: string
  description: string
  permission: string
  /** 路径/查询/请求头参数表 */
  parameters: DocField[]
  /** 请求体字段表（仅 JSON body） */
  requestFields: DocField[]
  requestBodyRequired: boolean
  requestContentType: string
  requestMessage: string
  responseStatus: string
  responseDescription: string
  responseMessage: string
  /** 成功响应 data 字段表 */
  responseFields: DocField[]
}

export interface DocTag {
  name: string
  description: string
  operations: DocOperation[]
}

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch']

function resolveRef(spec: OpenApiDocument, ref: string): unknown {
  const segments = ref.replace(/^#\//, '').split('/')
  let node: unknown = spec
  for (const segment of segments) {
    node = (node as Record<string, unknown> | undefined)?.[segment]
  }
  return node
}

function resolveSchema(spec: OpenApiDocument, schema: OpenApiSchema | undefined): OpenApiSchema {
  if (schema?.$ref) return resolveRef(spec, schema.$ref) as OpenApiSchema
  return schema ?? {}
}

function schemaType(schema: OpenApiSchema): string | undefined {
  if (Array.isArray(schema.type)) return schema.type.find(item => item !== 'null')
  return schema.type
}

/** 类型展示标签：String / Integer / Object / TaskRun[] 等。 */
export function typeLabel(spec: OpenApiDocument, schema: OpenApiSchema | undefined): string {
  const resolved = resolveSchema(spec, schema)
  if (resolved.anyOf) return resolved.anyOf.map(item => typeLabel(spec, item)).join(' | ')
  const type = schemaType(resolved)
  if (type === 'array') {
    const inner = resolved.items ? typeLabel(spec, resolved.items) : 'Any'
    return `${inner}[]`
  }
  if (resolved.enum) return 'String'
  if (type === 'integer') return 'Integer'
  if (type === 'number') return 'Number'
  if (type === 'boolean') return 'Boolean'
  if (type === 'object' || resolved.properties) return 'Object'
  if (type === 'null') return 'Null'
  return 'String'
}

function exampleForScalar(schema: OpenApiSchema, fieldName: string): unknown {
  if (schema.example !== undefined) return schema.example
  if (schema.enum?.length) return schema.enum[0]
  const type = schemaType(schema)
  if (type === 'integer') return 1
  if (type === 'number') return 1
  if (type === 'boolean') return true
  if (type === 'null') return null
  if (schema.format === 'date-time') return '2026-09-17T09:30:00.000Z'
  if (schema.format === 'binary') return '<二进制内容>'
  if (fieldName) return `<${fieldName}>`
  return 'string'
}

/** 由 schema 生成 JSON 示例值（最深 4 层，超出以省略号占位）。 */
export function buildExample(
  spec: OpenApiDocument,
  schema: OpenApiSchema | undefined,
  fieldName = '',
  depth = 0,
): unknown {
  const resolved = resolveSchema(spec, schema)
  if (depth > 4) return '…'
  if (resolved.anyOf) return buildExample(spec, resolved.anyOf[0], fieldName, depth + 1)
  const type = schemaType(resolved)
  if (type === 'array') {
    const item = resolved.items ? buildExample(spec, resolved.items, '', depth + 1) : 'string'
    return [item]
  }
  if (resolved.properties) {
    const object: Record<string, unknown> = {}
    for (const [key, property] of Object.entries(resolved.properties)) {
      object[key] = buildExample(spec, property, key, depth + 1)
    }
    return object
  }
  if (type === 'object' || resolved.additionalProperties) return { key: 'value' }
  return exampleForScalar(resolved, fieldName)
}

const MAX_FIELD_DEPTH = 3

/** 将 schema 展平为字段表行；嵌套对象以 `.`、数组以 `[]` 表示路径。 */
export function flattenFields(
  spec: OpenApiDocument,
  schema: OpenApiSchema | undefined,
  prefix = '',
  requiredParent?: string[],
  depth = 0,
): DocField[] {
  const resolved = resolveSchema(spec, schema)
  if (resolved.anyOf) {
    return flattenFields(spec, resolved.anyOf[0], prefix, requiredParent, depth)
  }
  const requiredList = requiredParent ?? resolved.required ?? []
  const rows: DocField[] = []
  if (!resolved.properties) return rows
  for (const [key, property] of Object.entries(resolved.properties)) {
    const prop = resolveSchema(spec, property)
    const isArray = schemaType(prop) === 'array'
    const name = `${prefix ? `${prefix}.` : ''}${key}${isArray ? '[]' : ''}`
    const nullable = Array.isArray(prop.type) && prop.type.includes('null')
    rows.push({
      name,
      type: typeLabel(spec, property) + (nullable ? ' 或 null' : ''),
      required: requiredList.includes(key) && !nullable,
      description: prop.description ?? '',
    })
    if (depth >= MAX_FIELD_DEPTH) continue
    const inner = isArray ? prop.items : prop
    const innerResolved = inner ? resolveSchema(spec, inner) : undefined
    if (innerResolved?.properties) {
      rows.push(...flattenFields(spec, inner, name, innerResolved.required ?? [], depth + 1))
    }
  }
  return rows
}

function queryExample(spec: OpenApiDocument, parameters: OpenApiParameter[]): string {
  const query = parameters.filter(param => param.in === 'query')
  if (!query.length) return ''
  const pairs = query.map(param => `${param.name}=${String(buildExample(spec, param.schema, param.name))}`)
  return `?${pairs.join('&')}`
}

function unwrapResponse(spec: OpenApiDocument, response: OpenApiResponse | undefined): OpenApiResponse | undefined {
  if (response?.$ref) return resolveRef(spec, response.$ref) as OpenApiResponse
  return response
}

function successResponse(spec: OpenApiDocument, operation: OpenApiOperation) {
  const entries = Object.entries(operation.responses ?? {})
  const found = entries.find(([status]) => status.startsWith('2'))
  if (!found) return { status: '200', response: undefined as OpenApiResponse | undefined }
  return { status: found[0], response: unwrapResponse(spec, found[1]) }
}

function successSchema(spec: OpenApiDocument, operation: OpenApiOperation) {
  const { response } = successResponse(spec, operation)
  const [contentType, media] = Object.entries(response?.content ?? {})[0] ?? ['', undefined]
  return { contentType, schema: media?.schema }
}

function buildRequestMessage(
  spec: OpenApiDocument,
  method: string,
  path: string,
  serverUrl: string,
  parameters: OpenApiParameter[],
  operation: OpenApiOperation,
): string {
  const lines: string[] = []
  lines.push(`${method} ${serverUrl}${path}${queryExample(spec, parameters)} HTTP/1.1`)
  lines.push('Host: <部署域名或内网 IP>')
  lines.push('Cookie: dsh_work_session=<登录后由服务端签发>')
  for (const param of parameters.filter(item => item.in === 'header')) {
    lines.push(`${param.name}: ${String(buildExample(spec, param.schema, param.name))}`)
  }
  const [contentType, media] = Object.entries(operation.requestBody?.content ?? {})[0] ?? []
  if (contentType) {
    lines.push(`Content-Type: ${contentType}`)
    if (media?.schema && contentType.includes('json')) {
      lines.push('', JSON.stringify(buildExample(spec, media.schema), null, 2))
    } else {
      lines.push('', '<文件二进制内容>')
    }
  }
  return lines.join('\n')
}

function buildResponseMessage(spec: OpenApiDocument, operation: OpenApiOperation): { status: string; text: string } {
  const { status, response } = successResponse(spec, operation)
  const statusText = status === '200' ? 'OK' : status === '201' ? 'Created' : status === '202' ? 'Accepted' : status
  const [contentType, media] = Object.entries(response?.content ?? {})[0] ?? []
  const lines = [`HTTP/1.1 ${status} ${statusText}`]
  if (!contentType) return { status, text: lines.join('\n') }
  lines.push(`Content-Type: ${contentType}${contentType.includes('json') ? '; charset=utf-8' : ''}`)
  if (contentType.includes('json') && media?.schema) {
    lines.push('', JSON.stringify(buildExample(spec, media.schema), null, 2))
  } else if (contentType.includes('event-stream')) {
    lines.push(
      '',
      'id: <event_id>',
      'event: <event_type>',
      'data: ' + JSON.stringify(buildExample(spec, media?.schema)),
      '',
      ': heartbeat',
    )
  } else {
    lines.push('Content-Disposition: attachment; filename*=UTF-8\'\'<文件名>', '', '<二进制内容>')
  }
  return { status, text: lines.join('\n') }
}

function responseDataFields(spec: OpenApiDocument, schema: OpenApiSchema | undefined): DocField[] {
  const resolved = resolveSchema(spec, schema)
  const data = resolved.properties?.['data']
  if (!data) return []
  const dataResolved = resolveSchema(spec, data)
  // data 为数组时以 data[].field 展开元素字段；对象时以 data.field 展开。
  if (schemaType(dataResolved) === 'array') {
    return flattenFields(spec, dataResolved.items, 'data[]')
  }
  return flattenFields(spec, data, 'data')
}

/** 汇总契约中全部操作为按 tag 分组的渲染数据。 */
export function collectDoc(spec: OpenApiDocument): DocTag[] {
  const serverUrl = spec.servers?.[0]?.url ?? ''
  const tagMeta = new Map((spec.tags ?? []).map(tag => [tag.name, tag.description ?? '']))
  const groups = new Map<string, DocOperation[]>()

  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = item[method]
      if (!operation) continue
      const parameters = (operation.parameters ?? [])
        .map(param => ('$ref' in param ? resolveRef(spec, param.$ref) as OpenApiParameter : param))
      const anchor = `op-${method}-${path.replace(/[^a-zA-Z0-9]+/g, '-')}`
      const { schema } = successSchema(spec, operation)
      const [requestContentType, requestMedia] =
        Object.entries(operation.requestBody?.content ?? {})[0] ?? ['', undefined]
      const { status, text } = buildResponseMessage(spec, operation)
      const doc: DocOperation = {
        anchor,
        method: method.toUpperCase(),
        path,
        summary: operation.summary ?? operation.operationId ?? `${method.toUpperCase()} ${path}`,
        description: operation.description ?? '',
        permission: operation['x-permission'] ?? '登录会话',
        parameters: parameters.map(param => ({
          name: `${param.name}（${{ path: '路径', query: '查询', header: '请求头' }[param.in]}）`,
          type: typeLabel(spec, param.schema),
          required: param.required === true,
          description: param.description ?? '',
        })),
        requestFields: requestContentType.includes('json')
          ? flattenFields(spec, requestMedia?.schema)
          : [],
        requestBodyRequired: operation.requestBody?.required === true,
        requestContentType,
        requestMessage: buildRequestMessage(spec, method.toUpperCase(), path, serverUrl, parameters, operation),
        responseStatus: status,
        responseDescription: successResponse(spec, operation).response?.description ?? '',
        responseMessage: text,
        responseFields: responseDataFields(spec, schema),
      }
      const tag = operation.tags?.[0] ?? '其他'
      groups.set(tag, [...(groups.get(tag) ?? []), doc])
    }
  }

  const ordered = [...(spec.tags ?? []).map(tag => tag.name), ...[...groups.keys()].filter(name => !tagMeta.has(name))]
  return [...new Set(ordered)]
    .filter(name => groups.has(name))
    .map(name => ({ name, description: tagMeta.get(name) ?? '', operations: groups.get(name) ?? [] }))
}
