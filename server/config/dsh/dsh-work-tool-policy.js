import process from 'node:process'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { request } from 'node:http'
import { appendFileSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'

const pathArguments = new Map([
  ['read', 'file_path'],
  ['glob', 'path'],
  ['grep', 'path'],
  ['write', 'file_path'],
  ['edit', 'file_path'],
])

const writableArtifactExtensions = new Set(['.md', '.txt', '.csv'])

/**
 * Apply the immutable Runtime Manifest tool allow-list before DSH executes a tool.
 * Missing or malformed policy data intentionally produces an empty allow-list.
 */
export function apply(ctx) {
  registerPlatformTools(ctx)
  publishRuntimeToolCatalog(ctx, process.env.DSH_TOOL_CATALOG_PATH)
  const allowedTools = parseAllowedTools(process.env.DSH_ALLOWED_TOOLS_JSON)
  const allowedMcpServers = parseAllowedMcpServers(process.env.DSH_ALLOWED_MCP_SERVERS_JSON)
  const approvedMcpCapabilities = parseApprovedMcpCapabilities(process.env.DSH_APPROVED_MCP_CAPABILITIES_JSON)
  const workspaceRoot = parseWorkspaceRoot(process.env.DSH_WORKSPACE_ROOT)
  const approvalMode = parseApprovalMode(process.env.DSH_TOOL_APPROVAL_MODE)
  const approvalLog = parseApprovalLog(process.env.DSH_TOOL_APPROVAL_LOG)
  const requireCurrentAuthorization = process.env.DSH_REQUIRE_CURRENT_AUTHORIZATION === 'true'
  const authorizationSocket = process.env.DSH_PLATFORM_TOOL_SOCKET

  const maximumCalls = process.env.DSH_MAX_TOOL_CALLS === undefined ? 1000 : Number(process.env.DSH_MAX_TOOL_CALLS)
  let calls = 0
  let verifiedMcpServers = verifyMcpCapabilityDigests(allowedMcpServers, approvedMcpCapabilities, ctx.tools.schemas())
  const refreshMcpCapabilityDigests = () => {
    verifiedMcpServers = verifyMcpCapabilityDigests(allowedMcpServers, approvedMcpCapabilities, ctx.tools.schemas())
  }
  ctx.on('tools/change', refreshMcpCapabilityDigests)
  const denialReason = execution => {
    // Recompute here as a fail-closed fallback in case a third-party plugin
    // mutates its catalog without emitting tools/change.
    refreshMcpCapabilityDigests()
    return validateExecution(execution, allowedTools, allowedMcpServers, verifiedMcpServers, workspaceRoot)
  }

  ctx.on('tools/pre-execute', async (execution, next) => {
    const denial = denialReason(execution)
    if (denial !== undefined) return { kind: 'deny', reason: denial }

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

function publishRuntimeToolCatalog(ctx, path) {
  if (!path || !isAbsolute(path)) return
  const publish = () => {
    try {
      const target = resolve(path)
      const temporary = `${target}.${process.pid}.tmp`
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(temporary, `${JSON.stringify({
        formatVersion: 2,
        generatedAt: new Date().toISOString(),
        tools: ctx.tools.schemas().map(publishToolContract),
      })}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, target)
    } catch {
      // Tool discovery is a management-plane projection. A write failure must
      // not make an already admitted Agent attempt unavailable.
    }
  }
  publish()
  ctx.on('tools/change', publish)
}

const readTools = new Set(['read', 'glob', 'grep', 'get_goal', 'job_list', 'job_output', 'inspect_admin_state', 'prepare_skill_installation'])
const retrySafeTools = new Set(['read', 'glob', 'grep', 'get_goal', 'job_list', 'job_output', 'inspect_admin_state', 'prepare_skill_installation', 'activate_skill', 'propose_memory'])
const concurrentTools = new Set(['read', 'glob', 'grep', 'get_goal', 'job_list', 'job_output', 'inspect_admin_state', 'delegate_agent'])
const toolTimeoutSeconds = new Map([
  ['todo_write', 10], ['create_goal', 10], ['get_goal', 10], ['update_goal', 10],
  ['job_list', 10], ['job_kill', 10], ['bash', 60],
  ['prepare_skill_installation', 120], ['python_execute', 300],
  ['delegate_agent', 300],
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
        || typeof item.digest !== 'string'
        || !/^[a-f0-9]{64}$/.test(item.digest)) return new Map()
      approved.set(item.serverName, { digest: item.digest })
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

function validateExecution(execution, allowedTools, allowedMcpServers, verifiedMcpServers, workspaceRoot) {
  const mcpServer = matchConfiguredMcpServer(execution.name, allowedMcpServers)
  if (!allowedTools.has(execution.name) && !(mcpServer && allowedMcpServers.has(mcpServer))) {
    return `dsh-work Runtime Manifest 未授权工具：${execution.name}`
  }
  if (mcpServer && !verifiedMcpServers.has(mcpServer)) {
    return `dsh-work MCP 能力清单与已审核摘要不一致：${mcpServer}`
  }

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
  if (execution.name === 'write' || execution.name === 'edit') {
    const outputRoot = resolve(workspaceRoot, 'output')
    if (!isWithin(outputRoot, candidate) || candidate === outputRoot) {
      return `dsh-work 只允许在当前 Run 的 output 目录生成或编辑成果：${rawPath}`
    }
    const extension = candidate.slice(candidate.lastIndexOf('.')).toLowerCase()
    if (!writableArtifactExtensions.has(extension)) {
      return 'dsh-work 文本成果仅支持 Markdown、TXT 和 CSV 文件'
    }
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

function matchConfiguredMcpServer(toolName, serverNames) {
  if (typeof toolName !== 'string') return undefined
  return [...serverNames]
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .find(serverName => toolName.startsWith(`mcp__${serverName}__`))
}

function verifyMcpCapabilityDigests(allowedServers, approved, schemas) {
  const verified = new Set()
  for (const serverName of allowedServers) {
    const expected = approved.get(serverName)
    if (!expected) continue
    const prefix = `mcp__${serverName}__`
    const capabilities = schemas.flatMap(schema => {
      if (!isRecord(schema) || typeof schema.name !== 'string' || !schema.name.startsWith(prefix)
        || typeof schema.description !== 'string' || !isRecord(schema.parameters)) return []
      return [{
        name: schema.name.slice(prefix.length),
        description: schema.description.trim().slice(0, 2000),
        inputSchema: JSON.parse(JSON.stringify(schema.parameters)),
      }]
    }).sort((left, right) => left.name.localeCompare(right.name))
    if (capabilities.length
      && createHash('sha256').update(JSON.stringify(capabilities)).digest('hex') === expected.digest) {
      verified.add(serverName)
    }
  }
  return verified
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
    name: 'delegate_agent',
    description: 'Delegate one bounded subtask to an explicitly allowed published Agent Version. The child uses the same user, workspace, cumulative budget and narrowed permission ceiling. Returns a task-result/v1 outcome; failed or unverified child work must not be presented as verified success.',
    parameters: {
      type: 'object',
      properties: {
        targetAgentVersionId: { type: 'string', minLength: 1, maxLength: 128, description: 'Exact Agent Version ID from the current Run delegation policy.' },
        task: { type: 'string', minLength: 1, maxLength: 12000, description: 'Bounded subtask with an explicit expected result.' },
        context: { type: 'string', maxLength: 4000, description: 'Optional minimal context needed by the child. Do not copy the whole conversation.' },
      },
      required: ['targetAgentVersionId', 'task'],
      additionalProperties: false,
    },
    concurrencySafe: true,
  })
  registerPlatformTool(ctx, socketPath, {
    name: 'propose_memory',
    description: 'Stage a short-lived preference or reusable experience for the requester to review. This does not grant consent, select visibility or retention, or publish memory. The requester must submit it and an administrator must approve it. Release trials return trial_only and do not persist a proposal.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['preference', 'experience'] },
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
