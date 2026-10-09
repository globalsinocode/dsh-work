import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

import { redactSensitiveText } from '../../security/safe-observability.ts'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

export interface AcpProcessConfiguration {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  shutdownGraceMs?: number
}

export interface AcpSessionUpdate {
  sessionId: string
  update: Record<string, unknown>
}

export interface AcpPermissionRequest {
  sessionId?: string
  options?: Array<{ optionId?: string; kind?: string; name?: string }>
  toolCall?: Record<string, unknown>
  [key: string]: unknown
}

export interface AcpClientHandlers {
  onSessionUpdate: (update: AcpSessionUpdate) => void
  onPermissionRequest: (request: AcpPermissionRequest) => Promise<{ outcome: Record<string, unknown> }>
  onDiagnostic?: (message: string) => void
}

const inheritedEnvironmentKeys = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'NO_COLOR', 'FORCE_COLOR', 'COLORTERM',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'DSH_HOME',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
] as const

export function buildAcpChildEnvironment(overrides: Record<string, string> = {}) {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of inheritedEnvironmentKeys) {
    const value = process.env[key]
    if (value !== undefined) environment[key] = value
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (isSensitiveEnvironmentKey(key)) {
      throw new Error(`ACP 子进程环境禁止直接注入敏感变量：${key}`)
    }
    environment[key] = value
  }
  return environment
}

function isSensitiveEnvironmentKey(key: string) {
  const normalized = key.replaceAll(/[^A-Za-z0-9]/g, '').toLowerCase()
  return normalized.includes('apikey')
    || normalized.includes('password')
    || normalized.includes('secret')
    || normalized.endsWith('token')
    || normalized.includes('credentialvalue')
}

export class AcpProtocolError extends Error {
  readonly data: unknown

  constructor(message: string, data?: unknown) {
    super(message)
    this.name = 'AcpProtocolError'
    this.data = data
  }
}

export class AcpJsonRpcClient {
  private readonly configuration: AcpProcessConfiguration
  private readonly handlers: AcpClientHandlers
  private readonly process: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, PendingRequest>()
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''
  private nextId = 1
  private closing = false
  private exited = false
  private readonly exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>

  private constructor(
    configuration: AcpProcessConfiguration,
    handlers: AcpClientHandlers,
  ) {
    this.configuration = configuration
    this.handlers = handlers
    this.process = spawn(configuration.command, configuration.args, {
      cwd: configuration.cwd,
      env: buildAcpChildEnvironment(configuration.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.process.stdout.on('data', (chunk: Buffer) => { this.consume(chunk) })
    this.process.stderr.on('data', (chunk: Buffer) => {
      const diagnostic = chunk.toString('utf8').trim()
      if (diagnostic.length > 0) this.handlers.onDiagnostic?.(redactSensitiveText(diagnostic.slice(0, 4000)))
    })
    this.process.on('error', (error) => { this.failPending(error) })
    this.exitPromise = new Promise(resolve => {
      this.process.once('exit', (code, signal) => {
        this.exited = true
        const suffix = this.decoder.end()
        if (suffix.length > 0) this.consumeText(suffix)
        if (!this.closing) {
          this.failPending(new AcpProtocolError(`ACP process exited unexpectedly (code=${String(code)}, signal=${String(signal)})`))
        }
        resolve({ code, signal })
      })
    })
  }

  static launch(configuration: AcpProcessConfiguration, handlers: AcpClientHandlers): AcpJsonRpcClient {
    return new AcpJsonRpcClient(configuration, handlers)
  }

  /** Operating-system process id for resource observation of this ACP worker. */
  get pid(): number | undefined {
    return this.process.pid
  }

  async initialize(): Promise<Record<string, unknown>> {
    const result = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'dsh-work-runtime-adapter', version: '0.1.0-m1' },
    })
    const response = asRecord(result)
    if (response['protocolVersion'] !== 1) throw new AcpProtocolError('ACP protocol version 1 was not negotiated', response)
    return response
  }

  /**
   * 建立 ACP 会话并返回 `session/new` 的完整结果。
   *
   * 返回里带着 `configOptions`：ACP 会为会话列出模型选择项及其 `currentValue`
   * （形如 `["<provider>","<model>"]`）。它让调用方**不必真的调用模型**就能判断
   * Agent 是否拿到了路由 —— 2026-10-09 的 ACP 无路由事故正是靠这个字段发现的。
   */
  async newSessionWithOptions(cwd: string): Promise<{ sessionId: string; result: Record<string, unknown> }> {
    const result = asRecord(await this.request('session/new', { cwd, mcpServers: [] }))
    const sessionId = result['sessionId']
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new AcpProtocolError('ACP session/new returned no sessionId', result)
    }
    return { sessionId, result }
  }

  async newSession(cwd: string): Promise<string> {
    return (await this.newSessionWithOptions(cwd)).sessionId
  }

  prompt(sessionId: string, message: string): Promise<Record<string, unknown>> {
    return this.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: message }],
    }).then(result => asRecord(result))
  }

  cancel(sessionId: string): Promise<void> {
    return this.notify('session/cancel', { sessionId })
  }

  async close(): Promise<void> {
    if (this.closing) {
      await this.exitPromise
      return
    }
    this.closing = true
    this.process.stdin.end()
    if (!this.exited) this.process.kill('SIGTERM')

    const graceMs = this.configuration.shutdownGraceMs ?? 3000
    const graceful = await Promise.race([
      this.exitPromise.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => { resolve(false) }, graceMs)),
    ])
    if (!graceful && !this.exited) this.process.kill('SIGKILL')
    await this.exitPromise
    this.failPending(new AcpProtocolError('ACP connection closed'))
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++
    const message: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write(message).catch((error: unknown) => {
        this.pending.delete(id)
        reject(asError(error))
      })
    })
  }

  private notify(method: string, params?: unknown): Promise<void> {
    return this.write({ jsonrpc: '2.0', method, params })
  }

  private write(message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): Promise<void> {
    if (this.closing || this.exited) return Promise.reject(new AcpProtocolError('ACP process is not writable'))
    return new Promise((resolve, reject) => {
      this.process.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  private consume(chunk: Buffer): void {
    this.consumeText(this.decoder.write(chunk))
  }

  private consumeText(text: string): void {
    this.buffer += text
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line.length === 0) continue
      try {
        this.handle(JSON.parse(line) as JsonRpcMessage)
      } catch (error) {
        this.failPending(new AcpProtocolError(`Invalid ACP JSON-RPC frame: ${asError(error).message}`))
      }
    }
  }

  private handle(message: JsonRpcMessage): void {
    if ('method' in message) {
      if ('id' in message) {
        void this.handleAgentRequest(message)
        return
      }
      if (message.method === 'session/update') {
        const params = asRecord(message.params)
        const sessionId = params['sessionId']
        const update = params['update']
        if (typeof sessionId === 'string' && isRecord(update)) {
          this.handlers.onSessionUpdate({ sessionId, update })
        }
      }
      return
    }

    const pending = this.pending.get(message.id)
    if (pending === undefined) return
    this.pending.delete(message.id)
    if (message.error !== undefined) {
      pending.reject(new AcpProtocolError(message.error.message ?? 'ACP request failed', message.error.data))
    } else {
      pending.resolve(message.result)
    }
  }

  private async handleAgentRequest(request: JsonRpcRequest): Promise<void> {
    if (request.method !== 'session/request_permission') {
      await this.write({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: `Unsupported client method: ${request.method}` },
      })
      return
    }

    try {
      const result = await this.handlers.onPermissionRequest(asRecord(request.params) as AcpPermissionRequest)
      await this.write({ jsonrpc: '2.0', id: request.id, result })
    } catch (error) {
      await this.write({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32000, message: asError(error).message },
      })
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new AcpProtocolError('Expected an object in ACP response', value)
  return value
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
