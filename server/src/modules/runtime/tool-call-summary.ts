import type { PlatformToolOutcome } from './platform-tool-bridge.ts'

/** EX-01: one tool call as recorded in the DSH session log of an Attempt. */
export interface ToolCallObservation {
  callId: string
  toolName: string
  status: 'succeeded' | 'failed' | 'unknown'
}

/** Safe per-call summary projected as a `tool.completed` run event. No arguments or results. */
export interface ToolCallSummary {
  call_id: string
  tool_name: string
  status: 'succeeded' | 'failed' | 'unknown'
  error_code: string | null
}

/** Upper bound of `tool.completed` events per Attempt; the rest is only counted. */
export const MAX_TOOL_CALL_EVENTS = 30

const FAILURE_REASONS: Record<string, string> = {
  TOOL_PERMISSION_DENIED: '工具未获授权，或本次执行已结束',
  TOOL_CALL_LIMIT_EXCEEDED: '已达到本次执行的工具调用次数上限',
  TOOL_INPUT_INVALID: '调用参数不符合工具要求',
  TOOL_OUTPUT_INVALID: '工具返回的结果不符合规范',
  TOOL_PRECONDITION_FAILED: '调用的前置条件不满足',
  TOOL_UNAVAILABLE: '工具依赖的平台能力暂不可用',
  TOOL_CANCELLED: '工具调用已取消',
  TOOL_TIMEOUT: '工具调用超时',
  TOOL_RESULT_UNKNOWN: '写入结果未知，需要先核对实际效果',
  TOOL_EXECUTION_FAILED: '工具执行失败',
  TOOL_CONFLICT: '与正在进行的同类操作冲突',
  TOOL_AUTHORIZATION_UNAVAILABLE: '授权检查暂不可用',
  TOOL_OPERATION_IN_PROGRESS: '相同操作已受理，正在处理',
  TOOL_OPERATION_FAILED: '相同操作此前已失败',
  TOOL_OPERATION_REGISTRY_UNAVAILABLE: '外部操作登记不可用，工具未执行',
}

/** Fixed Chinese reason for a failure code; never echoes tool output. */
export function toolFailureReason(code: string | null): string {
  return (code && FAILURE_REASONS[code]) ?? '工具返回失败'
}

export function toolCallDisplayMessage(summary: ToolCallSummary): string {
  if (summary.status === 'succeeded') return `${summary.tool_name}：调用成功`
  if (summary.status === 'unknown') return `${summary.tool_name}：未收到调用结果`
  return `${summary.tool_name}：调用失败，${toolFailureReason(summary.error_code)}`
}

function sameTool(sessionName: string, platformName: string) {
  return sessionName === platformName
    || sessionName.endsWith(`__${platformName}`)
    || sessionName.endsWith(`.${platformName}`)
}

/**
 * Joins what the DSH session log recorded with what the platform tool bridge
 * answered. The session log is the list of calls; the bridge only adds typed
 * failure codes for platform tools (matched by call id, else by name in order).
 * Without a session log the bridge outcomes are the only evidence available.
 */
export function summarizeToolCalls(
  sessionCalls: ToolCallObservation[] | undefined,
  bridgeOutcomes: PlatformToolOutcome[],
): ToolCallSummary[] {
  if (!sessionCalls) {
    return bridgeOutcomes.map((outcome, index) => ({
      call_id: outcome.callId ?? `platform-${index + 1}`,
      tool_name: outcome.toolName,
      status: outcome.errorCode ? 'failed' : 'succeeded',
      error_code: outcome.errorCode,
    }))
  }
  const unused = new Set(bridgeOutcomes.map((_outcome, index) => index))
  const take = (predicate: (outcome: PlatformToolOutcome) => boolean) => {
    for (const index of unused) {
      if (predicate(bridgeOutcomes[index]!)) {
        unused.delete(index)
        return bridgeOutcomes[index]
      }
    }
    return undefined
  }
  return sessionCalls.map(call => {
    const outcome = take(item => item.callId === call.callId)
      ?? take(item => item.callId === null && sameTool(call.toolName, item.toolName))
    if (outcome?.errorCode) {
      return { call_id: call.callId, tool_name: call.toolName, status: 'failed', error_code: outcome.errorCode }
    }
    return {
      call_id: call.callId,
      tool_name: call.toolName,
      status: outcome && call.status === 'unknown' ? 'succeeded' : call.status,
      error_code: null,
    }
  })
}

/**
 * EX-01 live step: the result of one call as DSH reports it during the Attempt (ACP
 * `tool_call_update`). A typed failure code is taken only from the platform tool bridge
 * outcome with the same call id; name-only matching is left to the end-of-run log.
 */
export function liveToolCallSummary(
  call: { callId: string; toolName: string; status: 'completed' | 'failed' },
  bridgeOutcomes: PlatformToolOutcome[],
): ToolCallSummary {
  const outcome = bridgeOutcomes.find(item => item.callId === call.callId)
  if (outcome?.errorCode) {
    return { call_id: call.callId, tool_name: call.toolName, status: 'failed', error_code: outcome.errorCode }
  }
  return {
    call_id: call.callId,
    tool_name: call.toolName,
    status: call.status === 'failed' ? 'failed' : 'succeeded',
    error_code: null,
  }
}
