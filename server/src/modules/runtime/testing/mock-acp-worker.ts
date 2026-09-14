import { request } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
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

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })

lines.on('line', (line) => {
  const message = JSON.parse(line) as JsonRpcMessage
  if (message.method === 'initialize' && message.id !== undefined) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false } },
        authMethods: [],
      },
    })
    return
  }

  if (message.method === 'session/new' && message.id !== undefined) {
    sessionSequence += 1
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: `mock-session-${sessionSequence}` } })
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
    if (text.includes('[permission]')) {
      const requestId = permissionSequence++
      permissionPrompts.set(requestId, pending)
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
          toolCall: { toolCallId: 'mock-tool-call', title: 'Mock read-only tool' },
        },
      })
      return
    }
    if (process.env.DSH_PLATFORM_TOOL_SOCKET) {
      const allowedTools = JSON.parse(process.env.DSH_ALLOWED_TOOLS_JSON ?? '[]') as string[]
      const activating = allowedTools.includes('activate_skill')
      const skillName = process.env.DSH_AGENT_SYSTEM_PROMPT?.match(/(?:必须先调用 activate_skill 激活 |^- )([^（，\n]+)/m)?.[1]?.trim() ?? ''
      void (async () => {
        try {
          if (activating) {
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
