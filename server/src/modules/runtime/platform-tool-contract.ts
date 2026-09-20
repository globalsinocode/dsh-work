import Ajv2020Module from 'ajv/dist/2020.js'

const Ajv2020 = Ajv2020Module.default
const ajv = new Ajv2020({ strict: true, allErrors: true })

export type ToolEffect = 'read' | 'write'
export type ToolRetryPolicy = 'safe' | 'never' | 'verify-first'
export type ToolConcurrencyPolicy = 'concurrent' | 'serialized'
export type ToolCompletionSemantics = 'completed' | 'accepted'

export interface PlatformToolContract {
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  effect: ToolEffect
  retryPolicy: ToolRetryPolicy
  concurrencyPolicy: ToolConcurrencyPolicy
  completionSemantics: ToolCompletionSemantics
  timeoutMs: number
  maxOutputBytes: number
}

export interface PlatformToolRegistration {
  handler: (input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
  contract: PlatformToolContract
}

export class PlatformToolError extends Error {
  readonly status: number
  readonly code: string
  readonly retryable: boolean
  readonly effectState: 'not_started' | 'unknown'

  constructor(input: {
    status: number
    code: string
    message: string
    retryable?: boolean
    effectState?: 'not_started' | 'unknown'
  }) {
    super(input.message)
    this.name = 'PlatformToolError'
    this.status = input.status
    this.code = input.code
    this.retryable = input.retryable ?? false
    this.effectState = input.effectState ?? 'not_started'
  }
}

export function compileToolContract(contract: PlatformToolContract) {
  if (!Number.isInteger(contract.timeoutMs) || contract.timeoutMs < 1 || contract.timeoutMs > 600_000) {
    throw new TypeError('工具 timeoutMs 必须是 1～600000 的整数')
  }
  if (!Number.isInteger(contract.maxOutputBytes) || contract.maxOutputBytes < 1 || contract.maxOutputBytes > 16 * 1024 * 1024) {
    throw new TypeError('工具 maxOutputBytes 必须是 1～16777216 的整数')
  }
  return {
    input: ajv.compile(contract.inputSchema),
    output: ajv.compile(contract.outputSchema),
  }
}

export function toolInputInvalid(detail?: string) {
  return new PlatformToolError({ status: 422, code: 'TOOL_INPUT_INVALID', message: `工具参数不符合契约${detail ? `：${detail}` : ''}` })
}

export function toolOutputInvalid(detail?: string, effectState: PlatformToolError['effectState'] = 'not_started') {
  return new PlatformToolError({
    status: 502,
    code: 'TOOL_OUTPUT_INVALID',
    message: `工具返回值不符合契约${detail ? `：${detail}` : ''}`,
    effectState,
  })
}

/** A caller-correctable failure detected before a tool can start its effect. */
export function toolPreconditionFailed(message: string) {
  return new PlatformToolError({
    status: 422,
    code: 'TOOL_PRECONDITION_FAILED',
    message,
    effectState: 'not_started',
  })
}

/** A required platform capability is unavailable before a tool can start. */
export function toolUnavailable(message: string) {
  return new PlatformToolError({
    status: 503,
    code: 'TOOL_UNAVAILABLE',
    message,
    effectState: 'not_started',
  })
}

export function classifyPlatformToolError(error: unknown, contract: PlatformToolContract): PlatformToolError {
  if (error instanceof PlatformToolError) return error
  if (isAbortError(error)) {
    return new PlatformToolError({
      status: 409,
      code: 'TOOL_CANCELLED',
      message: '工具调用已取消',
      effectState: contract.effect === 'write' ? 'unknown' : 'not_started',
    })
  }
  if (isTypedError(error)) {
    const status = error.status
    const code = error.code
    if ([403, 409, 422, 503].includes(status)) {
      return new PlatformToolError({
        status,
        code,
        message: error.message,
        retryable: status === 503 && contract.retryPolicy === 'safe',
        effectState: status === 409 && contract.effect === 'write' ? 'unknown' : 'not_started',
      })
    }
  }
  if (contract.effect === 'write') {
    return new PlatformToolError({
      status: 500,
      code: 'TOOL_RESULT_UNKNOWN',
      message: '写入工具执行失败，执行结果未知；核对实际效果后再决定是否重试',
      effectState: 'unknown',
    })
  }
  return new PlatformToolError({ status: 500, code: 'TOOL_EXECUTION_FAILED', message: '工具执行失败' })
}

export function toolTimeout(contract: PlatformToolContract) {
  const resultUnknown = contract.effect === 'write'
  return new PlatformToolError({
    status: 504,
    code: resultUnknown ? 'TOOL_RESULT_UNKNOWN' : 'TOOL_TIMEOUT',
    message: resultUnknown ? '写入工具超时，执行结果未知；核对实际效果后再决定是否重试' : '工具调用超时',
    retryable: !resultUnknown && contract.retryPolicy === 'safe',
    effectState: resultUnknown ? 'unknown' : 'not_started',
  })
}

function isTypedError(error: unknown): error is Error & { status: number; code: string } {
  return error instanceof Error
    && typeof (error as { status?: unknown }).status === 'number'
    && typeof (error as { code?: unknown }).code === 'string'
}

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === 'AbortError' || (error as NodeJS.ErrnoException).code === 'ABORT_ERR')
}
