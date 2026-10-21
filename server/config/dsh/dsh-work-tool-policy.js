import process from 'node:process'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { request } from 'node:http'
import { appendFileSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'

const pathArguments = new Map([
  ['read', 'file_path'],
  ['read_image', 'file_path'],
  ['glob', 'path'],
  ['grep', 'path'],
  ['write', 'file_path'],
  ['edit', 'file_path'],
  ['str_replace_editor', 'path'],
])

export const TRIAL_ONLY_MCP_REASON = 'trial_only：发布试运行不调用外部 MCP 工具，本次调用未执行，未对外部系统产生任何效果。请在回答中说明该步骤需在正式运行时执行，不要声称已完成。'

const writableArtifactExtensions = new Set(['.md', '.txt', '.csv'])
const readableImageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

/**
 * Apply the immutable Runtime Manifest tool allow-list before DSH executes a tool.
 * Missing or malformed policy data intentionally produces an empty allow-list.
 */
export function apply(ctx) {
  registerPlatformTools(ctx)
  publishRuntimeToolCatalog(
    ctx,
    process.env.DSH_TOOL_CATALOG_PATH,
    process.env.DSH_WORK_TOOL_CATALOG_MODE,
  )
  const allowedTools = parseAllowedTools(process.env.DSH_ALLOWED_TOOLS_JSON)
  const allowedMcpServers = parseAllowedMcpServers(process.env.DSH_ALLOWED_MCP_SERVERS_JSON)
  const approvedMcpCapabilities = parseApprovedMcpCapabilities(process.env.DSH_APPROVED_MCP_CAPABILITIES_JSON)
  const workspaceRoot = parseWorkspaceRoot(process.env.DSH_WORKSPACE_ROOT)
  const approvalMode = parseApprovalMode(process.env.DSH_TOOL_APPROVAL_MODE)
  const approvalLog = parseApprovalLog(process.env.DSH_TOOL_APPROVAL_LOG)
  const requireCurrentAuthorization = process.env.DSH_REQUIRE_CURRENT_AUTHORIZATION === 'true'
  // 发布试运行（F-01）：MCP 能力清单与生产一致地暴露给模型，但实际调用一律返回 trial_only，
  // 不连接外部系统。MCP 工具尚无可信的只读/写入分类，因此只读调用同样不执行（fail closed）。
  const trialExternalEffects = process.env.DSH_WORK_TRIAL_EXTERNAL_EFFECTS === 'trial_only'
  const authorizationSocket = process.env.DSH_PLATFORM_TOOL_SOCKET

  const maximumCalls = process.env.DSH_MAX_TOOL_CALLS === undefined ? 1000 : Number(process.env.DSH_MAX_TOOL_CALLS)
  let calls = 0
  // MCP 逐工具校验每次都读取 DSH 当前加载的 Schema，远端在运行中改变工具清单时同样生效。
  const denialReason = execution =>
    validateExecution(execution, allowedTools, allowedMcpServers, approvedMcpCapabilities, () => ctx.tools.schemas(), workspaceRoot)

  ctx.on('tools/pre-execute', async (execution, next) => {
    const denial = denialReason(execution)
    if (denial !== undefined) return { kind: 'deny', reason: denial }
    if (trialExternalEffects && matchConfiguredMcpServer(execution.name, allowedMcpServers)) {
      return { kind: 'deny', reason: TRIAL_ONLY_MCP_REASON }
    }

    if (!Number.isInteger(maximumCalls) || maximumCalls < 0 || ++calls > maximumCalls) return { kind: 'deny', reason: '当前 Attempt 工具调用次数已达上限，请停止调用并报告原因' }
    if (requireCurrentAuthorization && !(await authorizeCurrentExecution(authorizationSocket, execution.signal))) {
      return { kind: 'deny', reason: '当前执行授权不可用或已撤销' }
    }
    const downstream = await next()
    if (downstream.kind === 'deny') return downstream
    if (requireCurrentAuthorization && !(await authorizeCurrentExecution(authorizationSocket, execution.signal))) {
      return { kind: 'deny', reason: '当前执行授权不可用或已撤销' }
    }
    const requiresApproval = downstream.kind === 'ask' || approvalMode !== 'never'
    if (!requiresApproval) return downstream
    if (!recordApprovalRequest(approvalLog, execution)) {
      return { kind: 'deny', reason: 'dsh-work 无法记录工具审批关联，已拒绝执行' }
    }
    if (downstream.kind === 'ask') return downstream
    return {
      kind: 'ask',
      reason: approvalMode === 'always'
        ? `dsh-work 要求每次确认工具：${execution.name}`
        : `dsh-work 要求确认敏感工具：${execution.name}`,
    }
  })

  ctx.tools.guard((execution) => {
    return denialReason(execution)
  })
}

apply.inject = ['tools']
export default apply

function publishRuntimeToolCatalog(ctx, path, mode) {
  if (!path || !isAbsolute(path) || (mode !== 'management' && mode !== 'mcp')) return
  let activeAgent
  const publish = () => {
    if (!activeAgent) return
    try {
      const target = resolve(path)
      const temporary = `${target}.${process.pid}.tmp`
      const tools = JSON.parse(JSON.stringify(ctx.tools.schemas(activeAgent).map(publishToolContract)))
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(temporary, `${JSON.stringify({
        formatVersion: 3,
        generatedAt: new Date().toISOString(),
        sessionId: activeAgent.id,
        catalogDigest: createHash('sha256').update(canonicalJson(tools)).digest('hex'),
        tools,
      })}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, target)
    } catch {
      // Tool discovery is a management-plane projection. A write failure must
      // not make an already admitted Agent attempt unavailable.
    }
  }
  ctx.on('agent/session-start', ({ agent }) => {
    activeAgent = agent
    publish()
  }, { global: true })
  ctx.on('tools/change', publish, { global: true })
}

const readTools = new Set(['read', 'read_image', 'glob', 'grep', 'web_fetch', 'web_search', 'get_goal', 'job_list', 'job_output', 'inspect_admin_state', 'prepare_skill_installation'])
const retrySafeTools = new Set(['read', 'read_image', 'glob', 'grep', 'web_search', 'get_goal', 'job_list', 'job_output', 'inspect_admin_state', 'prepare_skill_installation', 'activate_skill', 'propose_memory'])
const concurrentTools = new Set(['read', 'read_image', 'glob', 'grep', 'web_fetch', 'web_search', 'get_goal', 'job_list', 'job_output', 'inspect_admin_state'])
const toolTimeoutSeconds = new Map([
  ['todo_write', 10], ['create_goal', 10], ['get_goal', 10], ['update_goal', 10],
  ['job_list', 10], ['job_kill', 10], ['bash', 60],
  ['prepare_skill_installation', 120], ['python_execute', 300],
])

function publishToolContract(schema) {
  const name = typeof schema?.name === 'string' ? schema.name : ''
  return {
    ...schema,
    contract: {
      effect: readTools.has(name) ? 'read' : 'write',
      retryPolicy: retrySafeTools.has(name) ? 'safe' : 'never',
      concurrencyPolicy: concurrentTools.has(name) ? 'concurrent' : 'serialized',
      completionSemantics: 'completed',
      timeoutSeconds: toolTimeoutSeconds.get(name) ?? 30,
      outputValidation: 'unavailable',
      outputSchema: { 'x-dsh-work-output-validation': 'unavailable' },
    },
  }
}

function parseAllowedTools(value) {
  if (!value) return new Set()
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string' || !item.trim())) {
      return new Set()
    }
    return new Set(parsed.map(item => item.trim()))
  } catch {
    return new Set()
  }
}

function parseAllowedMcpServers(value) {
  if (!value) return new Set()
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(item))) {
      return new Set()
    }
    return new Set(parsed)
  } catch {
    return new Set()
  }
}

/** 生效清单：serverName → (Tool 名称 → 输入 Schema 摘要)。格式错误时整体为空（fail closed）。 */
function parseApprovedMcpCapabilities(value) {
  const approved = new Map()
  if (!value) return approved
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return approved
    for (const item of parsed) {
      if (!isRecord(item)
        || typeof item.serverName !== 'string'
        || !/^[A-Za-z0-9_-]{1,32}$/.test(item.serverName)
        || !Array.isArray(item.tools)) return new Map()
      const tools = new Map()
      for (const tool of item.tools) {
        if (!isRecord(tool) || typeof tool.name !== 'string' || !tool.name
          || typeof tool.schemaDigest !== 'string' || !/^[a-f0-9]{64}$/.test(tool.schemaDigest)) return new Map()
        tools.set(tool.name, tool.schemaDigest)
      }
      approved.set(item.serverName, tools)
    }
    return approved
  } catch {
    return new Map()
  }
}

function parseWorkspaceRoot(value) {
  if (!value || !isAbsolute(value)) return undefined
  try {
    return realpathSync(value)
  } catch {
    return undefined
  }
}

function parseApprovalMode(value) {
  return value === 'never' || value === 'risk_based' || value === 'always' ? value : 'always'
}

function parseApprovalLog(value) {
  return value && isAbsolute(value) ? resolve(value) : undefined
}

function recordApprovalRequest(path, execution) {
  if (path === undefined || typeof execution.callId !== 'string' || execution.callId.length === 0) return false
  try {
    const parameters = isRecord(execution.arguments) ? execution.arguments : {}
    appendFileSync(path, `${JSON.stringify({
      call_id: execution.callId,
      tool_name: execution.name,
      arguments: parameters,
      parameter_digest: createHash('sha256').update(canonicalJson(parameters)).digest('hex'),
      resource_ref: approvalResourceRef(parameters, execution.name),
      data_version: approvalDataVersion(parameters),
    })}\n`, {
      encoding: 'utf8',
      flag: 'a',
      mode: 0o600,
    })
    return true
  } catch {
    return false
  }
}

/** 与平台 server/src/modules/runtime/canonical-json.ts 对 JSON 值的结果一致（对象键排序）。 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function approvalResourceRef(parameters, toolName) {
  for (const key of ['resource', 'resourceRef', 'resource_id', 'target', 'file_path', 'path']) {
    const value = parameters[key]
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 500)
  }
  return `tool:${toolName}`
}

function approvalDataVersion(parameters) {
  for (const key of ['dataVersion', 'data_version', 'etag', 'revision']) {
    const value = parameters[key]
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 200)
  }
  return 'unspecified'
}

function validateExecution(execution, allowedTools, allowedMcpServers, approvedMcpCapabilities, loadSchemas, workspaceRoot) {
  const mcpServer = matchConfiguredMcpServer(execution.name, allowedMcpServers)
  if (!allowedTools.has(execution.name) && !(mcpServer && allowedMcpServers.has(mcpServer))) {
    return `dsh-work Runtime Manifest 未授权工具：${execution.name}`
  }
  if (mcpServer) return validateMcpExecution(execution.name, mcpServer, approvedMcpCapabilities, loadSchemas())

  const webDenial = validateWebExecution(execution)
  if (webDenial !== undefined) return webDenial

  const argumentName = pathArguments.get(execution.name)
  if (argumentName === undefined) return undefined
  if (workspaceRoot === undefined) return 'dsh-work 当前 Run 工作区不可用，文件工具已拒绝执行'

  const argumentsRecord = isRecord(execution.arguments) ? execution.arguments : {}
  const rawPath = argumentsRecord[argumentName]
  if (rawPath === undefined && argumentName === 'path') return undefined
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    return `dsh-work 文件工具参数无效：${argumentName}`
  }

  const candidate = resolve(workspaceRoot, rawPath)
  if (!isWithin(workspaceRoot, candidate)) return `dsh-work 拒绝访问当前 Run 工作区之外的路径：${rawPath}`
  const editorCommand = execution.name === 'str_replace_editor' ? argumentsRecord.command : undefined
  if (execution.name === 'str_replace_editor'
    && !['view', 'create', 'str_replace', 'insert'].includes(editorCommand)) {
    return 'dsh-work 文本编辑工具命令无效'
  }
  const writesArtifact = execution.name === 'write'
    || execution.name === 'edit'
    || (execution.name === 'str_replace_editor' && editorCommand !== 'view')
  if (writesArtifact) {
    const outputRoot = resolve(workspaceRoot, 'output')
    if (!isWithin(outputRoot, candidate) || candidate === outputRoot) {
      return `dsh-work 只允许在当前 Run 的 output 目录生成或编辑成果：${rawPath}`
    }
    const extension = candidate.slice(candidate.lastIndexOf('.')).toLowerCase()
    if (!writableArtifactExtensions.has(extension)) {
      return 'dsh-work 文本成果仅支持 Markdown、TXT 和 CSV 文件'
    }
  }
  if (execution.name === 'read_image') {
    const extension = candidate.slice(candidate.lastIndexOf('.')).toLowerCase()
    if (!readableImageExtensions.has(extension)) return 'dsh-work 图片读取仅支持常见图片格式'
  }

  try {
    const canonicalCandidate = realpathWithMissingTail(candidate)
    if (!isWithin(workspaceRoot, canonicalCandidate)) {
      return `dsh-work 拒绝通过符号链接访问当前 Run 工作区之外的路径：${rawPath}`
    }
  } catch {
    return `dsh-work 无法安全解析文件路径：${rawPath}`
  }
  return undefined
}

function validateWebExecution(execution) {
  if (execution.name === 'web_fetch') {
    return 'dsh-work 网页获取尚无连接层私网地址防护，暂不允许执行'
  }
  const parameters = isRecord(execution.arguments) ? execution.arguments : {}
  if (execution.name === 'web_search') {
    const queries = parameters.queries
    if (!Array.isArray(queries) || queries.length < 1 || queries.length > 4
      || queries.some(query => typeof query !== 'string' || !query.trim() || query.length > 500)) {
      return 'dsh-work 网络搜索仅允许每次提交 1 至 4 个非空查询'
    }
    return undefined
  }
  return undefined
}

function matchConfiguredMcpServer(toolName, serverNames) {
  if (typeof toolName !== 'string') return undefined
  return [...serverNames]
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .find(serverName => toolName.startsWith(`mcp__${serverName}__`))
}

/** 只放行生效清单中的 Tool，且 DSH 当前加载的输入 Schema 摘要与确认时一致。 */
function validateMcpExecution(toolName, serverName, approvedMcpCapabilities, schemas) {
  const capabilityName = toolName.slice(`mcp__${serverName}__`.length)
  const expected = approvedMcpCapabilities.get(serverName)?.get(capabilityName)
  if (!expected) return `dsh-work MCP Tool 尚未确认生效：${toolName}`
  const schema = schemas.find(candidate => isRecord(candidate) && candidate.name === toolName)
  if (!schema || !isRecord(schema.parameters)
    || createHash('sha256').update(canonicalJson(schema.parameters)).digest('hex') !== expected) {
    return `dsh-work MCP Tool 输入 Schema 已变化，待管理员确认：${toolName}`
  }
  return undefined
}

function realpathWithMissingTail(candidate) {
  let existing = candidate
  const missing = []
  while (true) {
    try {
      return resolve(realpathSync(existing), ...missing)
    } catch (error) {
      if (!isMissingPathError(error)) throw error
      const parent = dirname(existing)
      if (parent === existing) throw error
      missing.unshift(basename(existing))
      existing = parent
    }
  }
}

function isMissingPathError(error) {
  return isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

function isWithin(root, candidate) {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Public DSH tools registry contract, shared by both locked ACP profiles.
// Only this Attempt's immutable source is accessible; the model cannot supply
// another URL, approve installation or execute an arbitrary command.
function registerPlatformTools(ctx) {
  const socketPath = process.env.DSH_PLATFORM_TOOL_SOCKET
  if (!socketPath) return
  registerPlatformTool(ctx, socketPath, {
    name: 'prepare_skill_installation',
    description: 'Fetch, validate and resolve the existing Skill source supplied by the administrator. Returns the authoritative installation plan. Never saves or publishes a Skill; the administrator must confirm in the application.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  })
  registerPlatformTool(ctx, socketPath, {
    name: 'inspect_admin_state',
    description: 'Read a bounded, non-secret snapshot of current Skill, Agent, Runtime or task state. This tool never changes platform data.',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string', enum: ['overview', 'skills', 'agents', 'operations'] },
        query: { type: 'string', maxLength: 200, description: 'Optional literal object name or ID filter. Omit this field when listing all objects or asking for counts; never put a natural-language instruction here.' },
      },
      required: ['domain'],
      additionalProperties: false,
    },
  })
  registerPlatformTool(ctx, socketPath, {
    name: 'propose_admin_task',
    description: 'Record a proposed delegation to a governed admin specialist. It does not start the specialist or execute any platform change; the administrator must confirm the proposal in the application.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['skill-install', 'agent-management', 'platform-operations'] },
        summary: { type: 'string', minLength: 4, maxLength: 240 },
        impact: { type: 'string', minLength: 4, maxLength: 500 },
      },
      required: ['kind', 'summary', 'impact'],
      additionalProperties: false,
    },
  })
  registerPlatformTool(ctx, socketPath, {
    name: 'prepare_admin_action',
    description: 'Prepare an exact pending plan; never execute it. The general assistant may change only existing draft name, description, welcomeMessage and examplePrompts for one final confirmation. systemPrompt, permissions, skills/tools, publication and Runtime changes require the delegated two-confirmation path; the server enforces this boundary.',
    parameters: {
      type: 'object',
      properties: {
        actionType: { type: 'string', enum: ['agent-update-draft', 'agent-set-status', 'runtime-update-configuration'] },
        target: { type: 'string', minLength: 1, maxLength: 160 },
        summary: { type: 'string', minLength: 4, maxLength: 300 },
        changes: { type: 'object' },
      },
      required: ['actionType', 'target', 'summary', 'changes'],
      additionalProperties: false,
    },
  })
  registerPlatformTool(ctx, socketPath, {
    name: 'propose_memory',
    description: 'Submit a short-lived reusable-experience application for this stable Agent. The application must cite the current Run and Attempt, does not publish itself, and requires administrator review. Release trials return trial_only and do not persist an application.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['experience'] },
        title: { type: 'string', minLength: 3, maxLength: 120 },
        content: { type: 'string', minLength: 20, maxLength: 4000 },
      },
      required: ['kind', 'title', 'content'],
    },
  })
  registerPlatformTool(ctx, socketPath, {
    name: 'activate_skill',
    description: 'Activate one Skill from the immutable catalog attached to this Run. Returns its exact instructions and resource directory. It cannot download or change a Skill.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1, maxLength: 160, description: 'Exact Skill name from the current Run catalog.' } },
      required: ['name'],
      additionalProperties: false,
    },
  })
  registerPlatformTool(ctx, socketPath, {
    name: 'python_execute',
    description: 'Execute a declared Python entry point from an activated Skill in the platform sandbox. Arbitrary commands, package installation and network access are not allowed.',
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string', minLength: 1, maxLength: 160 },
        entry: { type: 'string', minLength: 1, maxLength: 500 },
        args: { type: 'array', items: { type: 'string', maxLength: 1000 }, maxItems: 32 },
      },
      required: ['skill', 'entry'],
      additionalProperties: false,
    },
  })
}

function registerPlatformTool(ctx, socketPath, definition) {
  ctx.tools.register({
    ...definition,
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => definition.concurrencySafe === true,
    async execute(args, execution) {
      return new Promise((resolve, reject) => {
        const body = JSON.stringify(args ?? {})
        const req = request({ socketPath, path: `/tools/${definition.name}`, method: 'POST', signal: execution.signal,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            ...(typeof execution.callId === 'string' && execution.callId.length
              ? { 'X-DSH-Tool-Call-ID': execution.callId }
              : {}),
          } }, response => {
          let responseBody = ''
          response.setEncoding('utf8')
          response.on('data', chunk => { responseBody += chunk })
          response.on('end', () => {
            if ((response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300) {
              resolve(responseBody)
              return
            }
            try {
              const parsed = JSON.parse(responseBody)
              const error = parsed?.error
              reject(platformToolFailure(error))
            } catch {
              reject(platformToolFailure())
            }
          })
          response.on('error', reject)
        })
        req.on('error', reject)
        req.end(body)
      })
    },
  })
}

/**
 * DSH normalizes ordinary tool errors to their message. Keep typed properties
 * for direct callers and project the same stable semantics into that message.
 */
function platformToolFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : 'TOOL_EXECUTION_FAILED'
  const retryable = error?.retryable === true
  const effectState = error?.effect_state === 'unknown' ? 'unknown' : 'not_started'
  const message = typeof error?.message === 'string' ? error.message : '平台工具调用失败'
  const envelope = JSON.stringify({ code, retryable, effect_state: effectState })
  return Object.assign(new Error(`DSH_WORK_TOOL_ERROR ${envelope}\n${message}`), { code, retryable, effectState })
}

/** A product-owned Unix-socket check, not a model tool or external network request. */
function authorizeCurrentExecution(socketPath, signal) {
  if (!socketPath) return Promise.resolve(false)
  return new Promise(resolve => {
    const timeout = globalThis.AbortSignal.timeout(6000)
    const req = request({ socketPath, path: '/authorize-execution', method: 'POST',
      signal: signal ? globalThis.AbortSignal.any([signal, timeout]) : timeout }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => {
        body += chunk
        if (body.length > 1024) req.destroy()
      })
      response.on('error', () => resolve(false))
      response.on('end', () => {
        try { resolve(response.statusCode === 200 && JSON.parse(body).authorized === true) }
        catch { resolve(false) }
      })
    })
    req.on('error', () => resolve(false))
    req.end()
  })
}
