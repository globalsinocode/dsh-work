import process from 'node:process'
import { Buffer } from 'node:buffer'
import { request } from 'node:http'
import { appendFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'

const pathArguments = new Map([
  ['read', 'file_path'],
  ['glob', 'path'],
  ['grep', 'path'],
])

/**
 * Apply the immutable Runtime Manifest tool allow-list before DSH executes a tool.
 * Missing or malformed policy data intentionally produces an empty allow-list.
 */
export function apply(ctx) {
  registerPlatformTools(ctx)
  const allowedTools = parseAllowedTools(process.env.DSH_ALLOWED_TOOLS_JSON)
  const workspaceRoot = parseWorkspaceRoot(process.env.DSH_WORKSPACE_ROOT)
  const approvalMode = parseApprovalMode(process.env.DSH_TOOL_APPROVAL_MODE)
  const approvalLog = parseApprovalLog(process.env.DSH_TOOL_APPROVAL_LOG)

  const maximumCalls = process.env.DSH_MAX_TOOL_CALLS === undefined ? 1000 : Number(process.env.DSH_MAX_TOOL_CALLS)
  let calls = 0
  const denialReason = execution => validateExecution(execution, allowedTools, workspaceRoot)

  ctx.on('tools/pre-execute', async (execution, next) => {
    const denial = denialReason(execution)
    if (denial !== undefined) return { kind: 'deny', reason: denial }

    if (!Number.isInteger(maximumCalls) || maximumCalls < 0 || ++calls > maximumCalls) return { kind: 'deny', reason: '当前 Attempt 工具调用次数已达上限，请停止调用并报告原因' }
    const downstream = await next()
    if (downstream.kind === 'deny') return downstream
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
    appendFileSync(path, `${JSON.stringify({ call_id: execution.callId, tool_name: execution.name })}\n`, {
      encoding: 'utf8',
      flag: 'a',
      mode: 0o600,
    })
    return true
  } catch {
    return false
  }
}

function validateExecution(execution, allowedTools, workspaceRoot) {
  if (!allowedTools.has(execution.name)) {
    return `dsh-work Runtime Manifest 未授权工具：${execution.name}`
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
    name: 'activate_skill',
    description: 'Activate one Skill from the immutable catalog attached to this Run. Returns its exact instructions and resource directory. It cannot download or change a Skill.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Exact Skill name from the current Run catalog.' } },
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
        skill: { type: 'string' },
        entry: { type: 'string' },
        args: { type: 'array', items: { type: 'string' }, maxItems: 32 },
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
    isConcurrencySafe: () => false,
    async execute(args, execution) {
      return new Promise((resolve, reject) => {
        const body = JSON.stringify(args ?? {})
        const req = request({ socketPath, path: `/tools/${definition.name}`, method: 'POST', signal: execution.signal,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
          let responseBody = ''
          response.setEncoding('utf8')
          response.on('data', chunk => { responseBody += chunk })
          response.on('end', () => resolve(responseBody))
          response.on('error', reject)
        })
        req.on('error', reject)
        req.end(body)
      })
    },
  })
}
