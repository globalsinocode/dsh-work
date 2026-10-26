import { createServer } from 'node:http'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyPlatformToolError,
  compileToolContract,
  PlatformToolError,
  toolInputInvalid,
  toolOutputInvalid,
  toolTimeout,
  type PlatformToolRegistration,
} from './platform-tool-contract.ts'

export type PlatformToolHandler = (input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>

export interface PlatformToolOperationRecord {
  id: string
  status: 'accepted' | 'completed' | 'failed' | 'unknown'
  receipt: Record<string, unknown>
  errorCode: string | null
  /** True only for the transaction that first accepted this operation. */
  execute: boolean
}

/**
 * EX-01: what the bridge observed for one platform tool request. Only the tool
 * name, the DSH call id (when sent) and the typed error code are kept, never
 * parameters or results, so the summary is safe to project into run events.
 */
export interface PlatformToolOutcome {
  toolName: string
  callId: string | null
  errorCode: string | null
}

const MAX_RECORDED_OUTCOMES = 200

export interface PlatformToolOperationLifecycle {
  begin(input: { callId: string; toolName: string; parameters: Record<string, unknown> }): Promise<PlatformToolOperationRecord>
  resolve(input: {
    operationId: string
    status: 'accepted' | 'completed' | 'failed' | 'unknown'
    receipt: Record<string, unknown>
    errorCode?: string
  }): Promise<void>
}

/** Per-Attempt local transport. No credentials, model calls or agent loop live here. */
export async function createPlatformToolBridge(
  tools: Record<string, PlatformToolRegistration>,
  limit: number,
  authorize?: () => Promise<void>,
  operations?: PlatformToolOperationLifecycle,
  /** Runtime 紧急停用的内置工具：只拒绝这一次调用，不终止 Attempt。 */
  toolDisabled?: (toolName: string) => Promise<boolean>,
  /**
   * 执行容器模式：DSH 的 remote `ctx.subprocess` 经此执行命令。不是 Agent 工具，
   * 不计入工具调用次数；每次都复核当前授权，DSH 断开时中止命令。
   */
  subprocess?: (body: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>,
) {
  const prepared = Object.fromEntries(Object.entries(tools).map(([name, registration]) => [
    name,
    { ...registration, validators: compileToolContract(registration.contract) },
  ]))
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tool-'))
  const socket = join(directory, 'bridge.sock')
  const controller = new AbortController()
  let count = 0
  const active = new Set<Promise<void>>()
  const activeSerializedTools = new Set<string>()
  const outcomes: PlatformToolOutcome[] = []
  const server = createServer((request, response) => {
    const task = (async () => {
      response.setHeader('Content-Type', 'application/json')
      // Internal policy probe, never registered as an Agent tool or counted as a tool call.
      if (request.url === '/authorize-execution') {
        if (request.method !== 'POST' || !authorize || controller.signal.aborted) {
          response.writeHead(403).end(JSON.stringify({ error: 'Attempt 未获授权' }))
          return
        }
        try {
          await authorize()
          const toolHeader = request.headers['x-dsh-tool-name']
          const toolName = (Array.isArray(toolHeader) ? toolHeader[0] : toolHeader)?.trim()
          if (toolName && toolDisabled) {
            let disabled: boolean
            try { disabled = await toolDisabled(toolName) } catch {
              response.writeHead(503).end(JSON.stringify({ error: '内置工具停用状态暂不可读，本次调用未执行' }))
              return
            }
            if (disabled) {
              response.end(JSON.stringify({ authorized: true, toolDisabled: true }))
              return
            }
          }
          response.end(JSON.stringify({ authorized: true }))
        } catch (error) {
          const revoked = isAuthorizationDenied(error)
          response.writeHead(revoked ? 403 : 503).end(JSON.stringify({
            error: revoked ? '当前执行授权已撤销' : '当前执行授权检查暂不可用',
          }))
        }
        return
      }
      if (request.url === '/subprocess/exec') {
        if (request.method !== 'POST' || !subprocess || controller.signal.aborted) {
          writeError(response, new PlatformToolError({ status: 403, code: 'SUBPROCESS_DENIED', message: '执行容器不可用或 Attempt 已结束' }))
          return
        }
        const disconnected = new AbortController()
        response.once('close', () => { if (!response.writableFinished) disconnected.abort() })
        try {
          const body = await readBody(request)
          await authorizeTool(authorize)
          const result = await subprocess(body, AbortSignal.any([controller.signal, disconnected.signal]))
          response.end(JSON.stringify(result))
        } catch (error) {
          writeError(response, subprocessError(error))
        }
        return
      }
      const toolName = request.url === '/prepare-skill'
        ? 'prepare_skill_installation'
        : request.url?.match(/^\/tools\/([a-z0-9_]+)$/)?.[1]
      const registration = toolName ? prepared[toolName] : undefined
      if (toolName) {
        const callIdHeader = request.headers['x-dsh-tool-call-id']
        const observedCallId = (Array.isArray(callIdHeader) ? callIdHeader[0] : callIdHeader)?.trim() || null
        response.once('finish', () => {
          if (outcomes.length >= MAX_RECORDED_OUTCOMES) return
          outcomes.push({ toolName, callId: observedCallId, errorCode: response.statusCode < 400 ? null : writtenErrorCodes.get(response) ?? 'TOOL_EXECUTION_FAILED' })
        })
      }
      if (request.method !== 'POST' || !registration || controller.signal.aborted) {
        writeError(response, new PlatformToolError({ status: 403, code: 'TOOL_PERMISSION_DENIED', message: '工具未获授权或 Attempt 已结束' }))
        return
      }
      if (++count > limit) {
        writeError(response, new PlatformToolError({ status: 429, code: 'TOOL_CALL_LIMIT_EXCEEDED', message: '当前 Attempt 工具调用次数已达上限' }))
        return
      }
      let operation: PlatformToolOperationRecord | undefined
      try {
        const input = await readBody(request)
        if (!registration.validators.input(input)) throw toolInputInvalid(ajvErrors(registration.validators.input.errors))
        await authorizeTool(authorize, 'not_started', registration.contract.retryPolicy === 'safe')
        controller.signal.throwIfAborted()
        if (registration.contract.effect === 'write' && operations) {
          const callIdHeader = request.headers['x-dsh-tool-call-id']
          const callId = (Array.isArray(callIdHeader) ? callIdHeader[0] : callIdHeader)?.trim()
          if (!callId) throw toolInputInvalid('写入工具缺少 DSH tool call id')
          try {
            operation = await operations.begin({ callId, toolName: toolName!, parameters: input })
          } catch {
            throw new PlatformToolError({
              status: 503,
              code: 'TOOL_OPERATION_REGISTRY_UNAVAILABLE',
              message: '外部操作登记不可用，工具未执行',
              effectState: 'not_started',
            })
          }
          if (operation.status === 'accepted' && !operation.execute) {
            throw new PlatformToolError({
              status: 409,
              code: 'TOOL_OPERATION_IN_PROGRESS',
              message: '相同外部操作已经受理；请查询状态，不能重复执行',
              effectState: 'unknown',
            })
          }
          if (operation.status === 'completed') {
            response.end(JSON.stringify(operation.receipt['result'] ?? operation.receipt))
            return
          }
          if (operation.status === 'failed') {
            throw new PlatformToolError({
              status: 409,
              code: operation.errorCode ?? 'TOOL_OPERATION_FAILED',
              message: '相同外部操作已失败；请检查既有回执后再决定后续动作',
            })
          }
          if (operation.status === 'unknown') {
            throw new PlatformToolError({
              status: 409,
              code: 'TOOL_RESULT_UNKNOWN',
              message: '相同外部操作的实际效果未知；必须先查询外部状态，不能重复执行',
              effectState: 'unknown',
            })
          }
        }
        const value = await executeWithConcurrencyPolicy(toolName!, registration, input, controller.signal, activeSerializedTools)
        await authorizeTool(
          authorize,
          registration.contract.effect === 'write' ? 'unknown' : 'not_started',
          registration.contract.retryPolicy === 'safe',
        )
        controller.signal.throwIfAborted()
        const outputEffectState = registration.contract.effect === 'write' ? 'unknown' : 'not_started'
        if (!registration.validators.output(value)) throw toolOutputInvalid(ajvErrors(registration.validators.output.errors), outputEffectState)
        let serialized: string | undefined
        try { serialized = JSON.stringify(value) }
        catch { throw toolOutputInvalid('结果无法序列化', outputEffectState) }
        if (serialized === undefined || Buffer.byteLength(serialized) > registration.contract.maxOutputBytes) {
          throw toolOutputInvalid(`结果超过 ${registration.contract.maxOutputBytes} 字节或无法序列化`, outputEffectState)
        }
        if (operation) {
          await operations!.resolve({
            operationId: operation.id,
            status: registration.contract.completionSemantics,
            receipt: { result: JSON.parse(serialized) as unknown },
          })
        }
        response.end(serialized)
      } catch (error) {
        const classified = classifyPlatformToolError(error, registration.contract)
        if (operation?.execute && operation.status === 'accepted') {
          try {
            await operations!.resolve({
              operationId: operation.id,
              status: classified.effectState === 'unknown' ? 'unknown' : 'failed',
              receipt: { error: { code: classified.code, message: classified.message } },
              ...(classified.effectState === 'unknown' ? {} : { errorCode: classified.code }),
            })
          } catch {
            writeError(response, new PlatformToolError({
              status: 500,
              code: 'TOOL_RESULT_UNKNOWN',
              message: '工具执行后的操作回执无法持久化；必须先核对实际效果',
              effectState: 'unknown',
            }))
            return
          }
        }
        writeError(response, classified)
      }
    })()
    active.add(task)
    void task.catch(() => response.destroy()).finally(() => active.delete(task))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
  await chmod(socket, 0o600)
  return {
    socket,
    abort: () => controller.abort(),
    /** Tool requests answered so far, in completion order. */
    outcomes: (): PlatformToolOutcome[] => outcomes.map(outcome => ({ ...outcome })),
    async close() {
      controller.abort()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await Promise.allSettled(active)
      await rm(directory, { recursive: true, force: true })
    },
  }
}

async function executeWithConcurrencyPolicy(
  toolName: string,
  registration: PlatformToolRegistration & { validators: ReturnType<typeof compileToolContract> },
  input: Record<string, unknown>,
  attemptSignal: AbortSignal,
  activeSerializedTools: Set<string>,
) {
  if (registration.contract.concurrencyPolicy !== 'serialized') {
    return executeWithTimeout(registration, input, attemptSignal)
  }
  if (activeSerializedTools.has(toolName)) {
    throw new PlatformToolError({
      status: 409,
      code: 'TOOL_CONFLICT',
      message: '该工具已有调用正在执行，请等待结果后再调用',
    })
  }
  activeSerializedTools.add(toolName)
  return executeWithTimeout(registration, input, attemptSignal, () => activeSerializedTools.delete(toolName))
}

async function authorizeTool(
  authorize?: () => Promise<void>,
  effectState: PlatformToolError['effectState'] = 'not_started',
  retrySafe = false,
) {
  if (!authorize) return
  try { await authorize() }
  catch (error) {
    const revoked = isAuthorizationDenied(error)
    throw new PlatformToolError({
      status: revoked ? 403 : 503,
      code: revoked ? 'TOOL_PERMISSION_DENIED' : 'TOOL_AUTHORIZATION_UNAVAILABLE',
      message: effectState === 'unknown'
        ? revoked
          ? '工具执行后授权已撤销，写入效果可能已发生；核对实际效果后再决定后续操作'
          : '工具执行后授权复核暂不可用，写入效果可能已发生；核对实际效果后再决定后续操作'
        : revoked
          ? '当前工具执行授权已撤销'
          : '当前工具授权检查暂不可用，工具未执行',
      retryable: !revoked && retrySafe && effectState === 'not_started',
      effectState,
    })
  }
}

function isAuthorizationDenied(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error && error.code === 'permission_denied'
}

/**
 * After a tool deadline or Attempt cancellation, wait for the handler to stop.
 * Python sandbox removal finishes inside this window. A handler that ignores
 * AbortSignal still returns so the serialized lock can stay held until it settles.
 */
const HANDLER_CLEANUP_GRACE_MS = 12_000

async function executeWithTimeout(
  registration: PlatformToolRegistration,
  input: Record<string, unknown>,
  attemptSignal: AbortSignal,
  onHandlerSettled?: () => void,
) {
  const timeoutController = new AbortController()
  const signal = AbortSignal.any([attemptSignal, timeoutController.signal])
  const handler = Promise.resolve().then(() => registration.handler(input, signal))
  if (onHandlerSettled) void handler.then(onHandlerSettled, onHandlerSettled)
  let timer: NodeJS.Timeout | undefined
  let graceTimer: NodeJS.Timeout | undefined
  let removeAbortListener = () => {}
  try {
    const outcome = await new Promise<
      | { type: 'value'; value: unknown }
      | { type: 'error'; error: unknown }
      | { type: 'timeout' }
      | { type: 'abort' }
    >(resolve => {
      handler.then(
        value => resolve({ type: 'value', value }),
        error => resolve({ type: 'error', error }),
      )
      timer = setTimeout(() => resolve({ type: 'timeout' }), registration.contract.timeoutMs)
      const onAbort = () => resolve({ type: 'abort' })
      if (attemptSignal.aborted) onAbort()
      else attemptSignal.addEventListener('abort', onAbort, { once: true })
      removeAbortListener = () => attemptSignal.removeEventListener('abort', onAbort)
    })
    if (outcome.type === 'value') return outcome.value
    if (outcome.type === 'error') throw outcome.error
    // Abort first, then wait until the handler has stopped the underlying work.
    if (outcome.type === 'timeout') timeoutController.abort()
    const cleaned = await new Promise<{ pending: true } | { pending: false; error?: unknown }>(resolve => {
      handler.then(
        () => resolve({ pending: false }),
        error => resolve({ pending: false, error }),
      )
      graceTimer = setTimeout(() => resolve({ pending: true }), HANDLER_CLEANUP_GRACE_MS)
    })
    if (!cleaned.pending && cleaned.error !== undefined && !isHandlerAbort(cleaned.error)) throw cleaned.error
    if (outcome.type === 'timeout') throw toolTimeout(registration.contract)
    throw new DOMException('Aborted', 'AbortError')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (graceTimer !== undefined) clearTimeout(graceTimer)
    removeAbortListener()
  }
}

function subprocessError(error: unknown): PlatformToolError {
  if (error instanceof PlatformToolError) return error
  if (isHandlerAbort(error)) return new PlatformToolError({ status: 499, code: 'SUBPROCESS_ABORTED', message: '命令已取消' })
  const status = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : 500
  const message = error instanceof Error ? error.message : '命令执行失败'
  return new PlatformToolError({ status: status >= 400 && status < 600 ? status : 500, code: 'SUBPROCESS_FAILED', message })
}

function isHandlerAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || (error as NodeJS.ErrnoException).code === 'ABORT_ERR')
}

const writtenErrorCodes = new WeakMap<import('node:http').ServerResponse, string>()

function writeError(response: import('node:http').ServerResponse, error: PlatformToolError) {
  writtenErrorCodes.set(response, error.code)
  response.writeHead(error.status).end(JSON.stringify({ error: {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    effect_state: error.effectState,
  } }))
}

function ajvErrors(errors: null | undefined | Array<{ instancePath?: string; message?: string }>) {
  return errors?.map(error => `${error.instancePath || '/'} ${error.message ?? '无效'}`).join('；')
}

async function readBody(request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  // Decode once after collecting bytes so a UTF-8 character split across chunks stays intact.
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += bytes.length
    if (size > 65536) throw toolInputInvalid('参数超过 64 KB')
    chunks.push(bytes)
  }
  const body = Buffer.concat(chunks, size).toString('utf8')
  if (!body) return {}
  let parsed: unknown
  try { parsed = JSON.parse(body) as unknown }
  catch { throw toolInputInvalid('请求体不是有效 JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw toolInputInvalid('工具参数必须是对象')
  return parsed as Record<string, unknown>
}
