import { request } from 'node:http'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code: number; message: string; data?: Record<string, unknown> }
}

interface PendingPrompt {
  id: number
  sessionId: string
  answer: string
}

let sessionSequence = 0
let permissionSequence = 9000
const pendingPrompts = new Map<string, PendingPrompt>()
const permissionPrompts = new Map<number, PendingPrompt>()
const initDelayArg = process.argv.find(arg => arg.startsWith('--delay-init='))
const initDelayMs = initDelayArg ? Number(initDelayArg.slice('--delay-init='.length)) : 0

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })

lines.on('line', (line) => {
  const message = JSON.parse(line) as JsonRpcMessage
  if (message.method === 'initialize' && message.id !== undefined) {
    const result = {
      protocolVersion: 1,
      agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false } },
      authMethods: [],
    }
    if (initDelayMs > 0) setTimeout(() => send({ jsonrpc: '2.0', id: message.id, result }), initDelayMs)
    else send({ jsonrpc: '2.0', id: message.id, result })
    return
  }

  if (message.method === 'session/new' && message.id !== undefined) {
    sessionSequence += 1
    const sessionId = `mock-session-${sessionSequence}`
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId } })
    const delay = Number(process.env.MOCK_MCP_CATALOG_DELAY_MS ?? 0)
    const catalogPath = process.env.DSH_TOOL_CATALOG_PATH
    const catalogMode = process.env.DSH_WORK_TOOL_CATALOG_MODE
    const isolatedManagementProbe = !process.env.DSH_PLATFORM_TOOL_SOCKET
      && !process.env.DSH_ALLOWED_MCP_SERVERS_JSON
      && !process.env.DSH_APPROVED_MCP_CAPABILITIES_JSON
    if (catalogMode === 'management' && catalogPath && isolatedManagementProbe) {
      const schemas = JSON.parse(process.env.MOCK_RUNTIME_TOOL_SCHEMAS_JSON ?? JSON.stringify([
        { name: 'read', description: 'Read a file.', parameters: { type: 'object' } },
      ])) as Array<{ name: string; description: string; parameters: Record<string, unknown> }>
      setTimeout(() => {
        void publishToolCatalog(catalogPath, sessionId, schemas.map(tool => ({
          ...tool,
          contract: runtimeToolContract(tool.name),
        }))).catch(() => undefined)
      }, Number(process.env.MOCK_RUNTIME_CATALOG_DELAY_MS ?? 0))
    }
    if (catalogMode === 'mcp' && delay > 0 && catalogPath) {
      const [serverName] = JSON.parse(process.env.DSH_ALLOWED_MCP_SERVERS_JSON ?? '[]') as string[]
      const tools = [{
        name: `mcp__${serverName}__ping`, description: 'Read-only test tool', parameters: { type: 'object' },
        contract: runtimeToolContract(`mcp__${serverName}__ping`),
      }]
      setTimeout(() => {
        void publishToolCatalog(catalogPath, sessionId, tools).catch(() => undefined)
      }, delay)
      const updateDelay = Number(process.env.MOCK_MCP_CATALOG_UPDATE_DELAY_MS ?? 0)
      if (updateDelay > delay) setTimeout(() => {
        void publishToolCatalog(catalogPath, sessionId, [
          ...tools,
          {
            name: `mcp__${serverName}__pong`, description: 'Second test tool', parameters: { type: 'object' },
            contract: runtimeToolContract(`mcp__${serverName}__pong`),
          },
        ]).catch(() => undefined)
      }, updateDelay)
    }
    return
  }

  if (message.method === 'session/prompt' && message.id !== undefined) {
    const sessionId = String(message.params?.['sessionId'] ?? '')
    const prompt = message.params?.['prompt']
    const text = Array.isArray(prompt)
      ? prompt.map(block => isRecord(block) && typeof block['text'] === 'string' ? block['text'] : '').join('')
      : ''
    const currentText = text.includes('\n\n当前消息：\n') ? text.slice(text.lastIndexOf('\n\n当前消息：\n') + '\n\n当前消息：\n'.length) : text
    const pending = { id: message.id, sessionId, answer: `Mock response: ${text}` }
    pendingPrompts.set(sessionId, pending)

    if (text.includes('[crash]')) process.exit(17)
    if (text.includes('[model-failure]')) {
      failPrompt(pending, 'Model invocation failed', 'model')
      return
    }
    if (text.includes('[tool-timeout]')) {
      failPrompt(pending, 'Tool invocation timed out', 'tool_timeout')
      return
    }
    if (text.includes('[network-failure]')) {
      failPrompt(pending, 'Network connection unavailable', 'network')
      return
    }
    if (text.includes('[partial-hang]')) {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '已生成的部分回答内容。' },
          },
        },
      })
      return
    }
    if (text.includes('[large-partial-permission]')) {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'P'.repeat(70 * 1024) },
          },
        },
      })
      const requestId = permissionSequence++
      permissionPrompts.set(requestId, pending)
      void emitPermissionRequest(requestId, sessionId).catch(() => failPrompt(pending, 'Permission log write failed', 'tool'))
      return
    }
    if (text.includes('[large-output]')) {
      for (const chunk of ['A'.repeat(1000), `界${'B'.repeat(100)}`, 'C'.repeat(50)]) {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: chunk },
            },
          },
        })
      }
      finishPrompt(pending, 'end_turn', false)
      return
    }
    if (text.includes('[hang]')) return
    if (text.includes('[unexpected-cancel]')) {
      finishPrompt(pending, 'cancelled', false)
      return
    }
    if (text.includes('[artifact]')) {
      void (async () => {
        const workspace = process.env.DSH_WORKSPACE_ROOT
        if (!workspace) throw new Error('DSH_WORKSPACE_ROOT is missing')
        await mkdir(join(workspace, 'output'), { recursive: true })
        await writeFile(join(workspace, 'output', 'report.md'), '# 测试成果\n')
        finishPrompt(pending, 'end_turn')
      })().catch(() => failPrompt(pending, 'Artifact write failed', 'tool'))
      return
    }
    if (text.includes('[mcp-log-no-usage]')) {
      void writeMcpLogWithoutUsage().then(
        () => finishPrompt(pending, 'end_turn'),
        () => failPrompt(pending, 'Session log write failed', 'tool'),
      )
      return
    }
    if (text.includes('[permission]')) {
      const requestId = permissionSequence++
      permissionPrompts.set(requestId, pending)
      void emitPermissionRequest(requestId, sessionId).catch(() => failPrompt(pending, 'Permission log write failed', 'tool'))
      return
    }
    if (process.env.DSH_PLATFORM_TOOL_SOCKET && JSON.parse(process.env.DSH_ALLOWED_TOOLS_JSON ?? '[]').some((name: string) => ['activate_skill', 'prepare_skill_installation', 'propose_admin_task', 'prepare_admin_action', 'delegate_agent', 'propose_memory'].includes(name))) {
      const allowedTools = JSON.parse(process.env.DSH_ALLOWED_TOOLS_JSON ?? '[]') as string[]
      const activating = allowedTools.includes('activate_skill')
      const skillName = process.env.DSH_AGENT_SYSTEM_PROMPT?.match(/(?:必须先调用 activate_skill 激活 |^- )([^（，\n]+)/m)?.[1]?.trim() ?? ''
      void (async () => {
        try {
          if (allowedTools.includes('delegate_agent')) {
            const targetAgentVersionId = process.env.DSH_AGENT_SYSTEM_PROMPT?.match(/允许的目标 Agent Version ID：([^、\n]+)/)?.[1]?.trim()
            if (!targetAgentVersionId) throw new Error('No delegation target in system prompt')
            pending.answer = await callPlatformTool('delegate_agent', {
              targetAgentVersionId,
              task: currentText,
              context: '只传递当前测试任务所需的最小上下文。',
            })
          } else if (allowedTools.includes('propose_memory')) {
            pending.answer = await callPlatformTool('propose_memory', {
              kind: 'experience', title: '资料核对经验',
              content: '整理资料时先核对来源与日期，并标明尚待确认的信息。',
            })
          } else if (activating) {
            const activated = new Set<string>()
            const activate = async (name: string): Promise<void> => {
              if (activated.has(name)) return
              activated.add(name)
              const output = await callPlatformTool('activate_skill', { name })
              pending.answer += `${pending.answer ? '\n' : ''}${output}`
              const parsed = JSON.parse(output) as { id?: string; name?: string; dependencies?: string[]; pythonEntries?: string[] }
              if (allowedTools.includes('python_execute') && parsed.pythonEntries?.[0]) {
                pending.answer += `\n${await callPlatformTool('python_execute', { skill: parsed.id ?? parsed.name ?? name, entry: parsed.pythonEntries[0], args: [] })}`
              }
              for (const dependency of parsed.dependencies ?? []) await activate(dependency.split('@')[0]!)
            }
            await activate(skillName)
          } else if (allowedTools.includes('propose_admin_task')) {
            const kind = /agent/i.test(currentText)
              ? 'agent-management'
              : /(runtime|运行时|排空|调度)/i.test(currentText)
                ? 'platform-operations'
                : /https?:\/\/|npx\s+skills/i.test(currentText)
                  ? 'skill-install'
                  : undefined
            pending.answer = kind
              ? await callPlatformTool('propose_admin_task', { kind, summary: `Mock ${kind} proposal`, impact: '等待管理员确认后才会调用专用助手。' })
              : /平台上有哪些\s*skill/i.test(currentText)
                ? await callPlatformTool('inspect_admin_state', { domain: 'skills', query: '列出平台上所有已安装的 Skill' })
                : await callPlatformTool('inspect_admin_state', { domain: 'overview' })
          } else if (allowedTools.includes('prepare_admin_action')) {
            if (/(runtime|运行时|排空|调度)/i.test(currentText)) {
              const inspected = JSON.parse(await callPlatformTool('inspect_admin_state', { domain: 'operations' })) as { runtimes?: Array<{ id: string; schedulingStatus: string; attemptTimeoutMinutes: number }> }
              const runtime = inspected.runtimes?.[0]
              if (!runtime) throw new Error('No Runtime fixture')
              pending.answer = await callPlatformTool('prepare_admin_action', {
                actionType: 'runtime-update-configuration',
                target: runtime.id,
                summary: 'Mock Runtime scheduling change',
                changes: /排空/.test(currentText)
                  ? { schedulingStatus: runtime.schedulingStatus === 'draining' ? 'accepting' : 'draining' }
                  : { attemptTimeoutMinutes: runtime.attemptTimeoutMinutes === 60 ? 59 : runtime.attemptTimeoutMinutes + 1 },
              })
            } else {
              const inspected = JSON.parse(await callPlatformTool('inspect_admin_state', { domain: 'agents' })) as { items?: Array<{ id: string; description: string }> }
              const agent = inspected.items?.[0]
              if (!agent) throw new Error('No Agent fixture')
              pending.answer = await callPlatformTool('prepare_admin_action', {
                actionType: 'agent-update-draft',
                target: agent.id,
                summary: 'Mock Agent draft change',
                changes: { description: `${agent.description}（管理助手测试）`, changeSummary: '管理助手确认链路测试' },
              })
            }
          } else pending.answer = await callPlatformTool('prepare_skill_installation', {})
          finishPrompt(pending, 'end_turn')
        } catch { failPrompt(pending, 'Platform tool unavailable', 'tool') }
      })()
      return
    }
    finishPrompt(pending, 'end_turn')
    return
  }

  if (message.method === 'session/cancel') {
    const sessionId = String(message.params?.['sessionId'] ?? '')
    const pending = pendingPrompts.get(sessionId)
    if (pending !== undefined) finishPrompt(pending, 'cancelled', false)
    return
  }

  if (message.id !== undefined && permissionPrompts.has(message.id)) {
    const pending = permissionPrompts.get(message.id)
    permissionPrompts.delete(message.id)
    if (pending !== undefined) finishPrompt(pending, 'end_turn')
  }
})

async function emitPermissionRequest(requestId: number, sessionId: string) {
  const callId = 'mock-tool-call'
  const parameters = {}
  const toolName = (JSON.parse(process.env.DSH_ALLOWED_TOOLS_JSON ?? '[]') as string[])[0] ?? 'read'
  const approvalLog = process.env.DSH_TOOL_APPROVAL_LOG
  if (!approvalLog) throw new Error('DSH_TOOL_APPROVAL_LOG is missing')
  await appendFile(approvalLog, `${JSON.stringify({
    call_id: callId,
    tool_name: toolName,
    arguments: parameters,
    parameter_digest: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    resource_ref: `tool:${toolName}`,
    data_version: 'unspecified',
  })}\n`, { encoding: 'utf8', mode: 0o600 })
  send({
    jsonrpc: '2.0',
    id: requestId,
    method: 'session/request_permission',
    params: {
      sessionId,
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
      // DSH 0.1.1-rc.2 sends only the stable call id. dsh-work obtains the
      // governed arguments from the policy log written before asking.
      toolCall: { toolCallId: callId },
    },
  })
}

function runtimeToolContract(name: string) {
  return {
    effect: name === 'read' || name.startsWith('mcp__') ? 'read' : 'write',
    retryPolicy: name === 'read' || name.startsWith('mcp__') ? 'safe' : 'never',
    concurrencyPolicy: name === 'read' || name.startsWith('mcp__') ? 'concurrent' : 'serialized',
    completionSemantics: 'completed',
    timeoutSeconds: 30,
    outputValidation: 'unavailable',
    outputSchema: { 'x-dsh-work-output-validation': 'unavailable' },
  }
}

async function publishToolCatalog(
  catalogPath: string,
  sessionId: string,
  tools: Array<Record<string, unknown>>,
) {
  const temporary = `${catalogPath}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify({
    formatVersion: 3,
    sessionId: process.env.MOCK_RUNTIME_CATALOG_SESSION_ID ?? sessionId,
    catalogDigest: process.env.MOCK_RUNTIME_CATALOG_DIGEST
      ?? createHash('sha256').update(canonicalJson(tools)).digest('hex'),
    tools,
  }))
  await rename(temporary, catalogPath)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

async function writeMcpLogWithoutUsage() {
  const root = process.env.DSH_SNAPSHOT_SESSIONS_ROOT
  if (!root) throw new Error('DSH_SNAPSHOT_SESSIONS_ROOT is missing')
  const directory = join(root, 'mock-mcp-session')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'session.jsonl'), [
    JSON.stringify({ type: 'tool/call', data: { callId: 'mcp-call-no-usage', name: 'mcp__crm__customer__get', arguments: { id: 'customer-1' } } }),
    JSON.stringify({ type: 'tool/result', data: { callId: 'mcp-call-no-usage', isError: false } }),
    '',
  ].join('\n'))
}

function finishPrompt(pending: PendingPrompt, stopReason: string, includeAnswer = true): void {
  pendingPrompts.delete(pending.sessionId)
  if (includeAnswer) {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: pending.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: pending.answer },
        },
      },
    })
  }
  send({ jsonrpc: '2.0', id: pending.id, result: { stopReason } })
}

function failPrompt(pending: PendingPrompt, message: string, category: string): void {
  pendingPrompts.delete(pending.sessionId)
  send({
    jsonrpc: '2.0',
    id: pending.id,
    error: { code: -32000, message, data: { category } },
  })
}

function send(message: JsonRpcMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function callPlatformTool(name: string, input: Record<string, unknown>): Promise<string> {
  const socketPath = process.env.DSH_PLATFORM_TOOL_SOCKET!
  const body = JSON.stringify(input)
  return new Promise((resolve, reject) => {
    const path = name === 'prepare_skill_installation' ? '/prepare-skill' : `/tools/${name}`
    const req = request({ socketPath, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
      let output = ''
      response.on('data', chunk => { output += String(chunk) })
      response.on('end', () => resolve(output))
      response.on('error', reject)
    })
    req.on('error', reject)
    req.end(body)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
