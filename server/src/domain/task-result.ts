/**
 * I-06 任务结果外层（task-result/v1）。
 *
 * 这是一个**读时投影契约**：不建第二份执行状态机，也不复制 Run 状态字段。
 * `execution` 直接引用 Run 终态；`outcome` 是独立的业务核验状态，只由
 * 已持久化的权威证据推导——当前 Attempt 已提交的回答消息、该 Attempt 已
 * 登记的成果版本、平台工具审计记录与 Runtime 上报的执行遥测。模型自述
 * 完成不作为「已验证」依据；执行成功但必要证据缺失时投影为 `unverified`，
 * 绝不显示目标已达成。
 *
 * 两类证据口径容易误读，投影时显式区分：
 * - 回答消息登记只证明「内容已落库」，不证明业务目标达成；没有可核验的
 *   业务交付物（已登记成果）时保持 `unverified`。
 * - tool_audit_logs 中由 `approval.resolved` 写入的行是授权决定记录
 *   （`parameter_summary.decision` 存在），发生在工具执行之前——只能
 *   投影为「已受理/被拒绝」，不能当作「操作已完成」回执。
 *
 * 幂等性由证据本身保证：run_events 按事件 id 去重、回答消息按
 * `message-assistant-${eventId}` 幂等键登记、成果版本不可变——重复事件
 * 或重复读取得到同一份投影，不会重复登记结果。
 *
 * 外部异步写操作（I-05 预留边界）：`accepted` 回执状态为「已受理未完成」
 * 占位，当前平台工具均为同步 `completed` 语义，不产生该状态；真实接入时
 * 必须补业务操作键与状态查询，不能仅凭 Run 终态判定外部动作完成。
 */
import type { JsonObject, RunState } from '../modules/run/run-types.ts'
import type { Artifact, TaskSource, TaskRunError } from './types.ts'

export const TASK_RESULT_VERSION = 'task-result/v1'

/**
 * 业务结果核验状态（独立于 Run 执行终态）：
 * - `pending`：执行未结束，结果尚未生成；
 * - `achieved`：执行成功且存在可核验的业务交付物——当前 Attempt 至少
 *   登记一个成果版本或已完成工具动作回执，且声明数、回答登记、截断/中断
 *   等其余证据无缺口；
 * - `unverified`：执行已结束但缺少可核验证据（回答未登记、成果缺失、
 *   仅登记回答内容而无可核验交付物、输出截断或没有任何交付物），
 *   不能视为目标达成；
 * - `not_achieved`：执行失败或取消，目标未达成。
 */
export type TaskResultOutcome = 'pending' | 'achieved' | 'unverified' | 'not_achieved'

/** 回执类别：回答提交、成果登记、平台工具动作。 */
export type TaskResultReceiptKind = 'answer' | 'artifact' | 'tool'

/**
 * 回执核验状态：
 * - `completed`：动作已完成且有持久化登记；
 * - `accepted`：仅受理/获准——工具审批决定记录在执行前写入，不代表
 *   执行完成；同时预留给未来异步外部写操作的受理回执；
 * - `rejected`：动作被授权/策略拒绝；
 * - `failed`：动作执行失败；
 * - `missing`：Runtime 声明了交付物但平台登记缺失。
 */
export type TaskResultReceiptStatus = 'completed' | 'accepted' | 'rejected' | 'failed' | 'missing'

export interface TaskResultReceipt {
  kind: TaskResultReceiptKind
  status: TaskResultReceiptStatus
  /** 可核验引用：消息 id / artifact_version id / tool_audit id；无引用为 null。 */
  ref: string | null
  /** 面向用户的核验说明。 */
  label: string
  detail?: string
}

/** 待处理事项：结果无法核验为已达成时的具体缺口。 */
export type TaskResultPendingKind =
  | 'answer_uncommitted'
  | 'artifact_registration_gap'
  | 'no_deliverable'
  | 'no_verified_deliverable'
  | 'output_truncated'
  | 'output_interrupted'

export interface TaskResultPendingItem {
  kind: TaskResultPendingKind
  message: string
}

/**
 * 执行遥测证据：全部来自持久化 run_events 的 safe_metadata 与登记记录，
 * 不从回答正文猜测，不导出未脱敏的运行轨迹。
 */
export interface TaskResultTelemetry {
  stopReason: string | null
  toolCalls: number | null
  toolResults: number | null
  /** Runtime 在终态事件中声明的成果数；未上报为 null。 */
  artifactsClaimed: number | null
  /** 平台实际登记的成果版本数。 */
  artifactsRegistered: number
  inputTokens: number | null
  outputTokens: number | null
  elapsedMs: number | null
  outputTruncated: boolean
  /** 中断保留标记（timeout/shutdown）；未中断为 null。 */
  interrupted: string | null
}

export interface TaskResult {
  version: typeof TASK_RESULT_VERSION
  runId: string
  /** 当前 Attempt；无 Attempt 的排队 Run 为 null。 */
  attemptId: string | null
  /** Run 执行状态原文（含 cancel_requested），不是新状态机。 */
  execution: RunState
  outcome: TaskResultOutcome
  /** 一句话结果说明，由平台根据核验状态生成，不是模型自述。 */
  summary: string
  /** 主要结果：当前 Attempt 已提交回答的登记回执引用。 */
  primaryOutput: {
    kind: 'text'
    messageId: string
    truncated: boolean
    interrupted: string | null
  } | null
  receipts: TaskResultReceipt[]
  pendingItems: TaskResultPendingItem[]
  /** 本轮引用的知识/数据来源（输入证据）。 */
  sources: TaskSource[]
  /** 已登记成果引用（可下载版本）。 */
  artifacts: Artifact[]
  /** 执行失败的结构化错误；非失败终态为 null。 */
  error: TaskRunError | null
  evidence: TaskResultTelemetry
  /** 执行终态时间（ISO）；未结束为 null。 */
  completedAt: string | null
}

/** 投影输入：全部由持久化记录组装，调用方负责按当前 Attempt 过滤。 */
export interface TaskResultEvidence {
  run: { id: string; status: RunState; updatedAt: Date }
  attemptId: string | null
  /** 当前 Attempt 的持久化运行事件（含 safe_metadata）。 */
  events: Array<{
    id: string
    eventType: string
    displayMessage: string | null
    safeMetadata: JsonObject
    occurredAt: Date
  }>
  /** 该 Run 已提交（持久化）的 assistant 消息 id 集合。 */
  committedMessageIds: ReadonlySet<string>
  /** 当前 Attempt 登记的成果及其不可变版本引用。 */
  artifacts: Array<{
    artifact: Artifact
    artifactVersionId: string
  }>
  sources: TaskSource[]
  /**
   * 当前 Attempt 的平台工具审计记录。`decision` 非空的行为授权决定记录
   * （approval.resolved 在执行前写入），`decision` 为空才是执行回执。
   */
  toolAudits: Array<{
    id: string
    toolName: string | null
    decision: string | null
    result: 'success' | 'failed' | 'blocked'
    occurredAt: Date
  }>
  /** Run 失败时的结构化错误（由 toRunError 生成）。 */
  runError: TaskRunError | null
}

const TERMINAL_EVENT_TYPES = new Set(['run.completed', 'run.failed', 'run.cancelled'])

function metadataNumber(metadata: JsonObject, key: string): number | null {
  const value = metadata[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function metadataString(metadata: JsonObject, key: string): string | null {
  const value = metadata[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function metadataFlag(metadata: JsonObject | undefined, key: string): boolean {
  return metadata?.[key] === true
}

function summarize(
  outcome: TaskResultOutcome,
  pendingItems: TaskResultPendingItem[],
  error: TaskRunError | null,
  execution: RunState,
): string {
  if (outcome === 'pending') return '执行进行中，业务结果尚未生成。'
  if (outcome === 'not_achieved') {
    return execution === 'cancelled'
      ? '执行已取消，任务目标未达成。'
      : `执行未达成目标：${error?.message ?? '本轮执行失败'}`
  }
  if (outcome === 'unverified') {
    const reason = pendingItems[0]?.message ?? '缺少可核验证据'
    return `执行已结束，但业务结果未验证：${reason}`
  }
  return '执行完成：可核验交付证据已登记，结果可追溯核验。'
}

/**
 * 由持久化证据推导版本化任务结果。纯函数：相同证据恒得相同投影；
 * 只读既有登记记录，不写入、不触发任何执行。
 */
export function deriveTaskResult(evidence: TaskResultEvidence): TaskResult {
  const { run, events, committedMessageIds, sources, toolAudits } = evidence
  const registeredArtifacts = evidence.artifacts
  const artifacts = registeredArtifacts.map(item => item.artifact)
  const receipts: TaskResultReceipt[] = []
  const pendingItems: TaskResultPendingItem[] = []

  const terminalEvent = [...events].reverse().find(event => TERMINAL_EVENT_TYPES.has(event.eventType)) ?? null
  const terminalMetadata = terminalEvent?.safeMetadata
  const lastAssistant = [...events].reverse().find(event => event.eventType === 'assistant.completed') ?? null
  const interrupted = metadataString(lastAssistant?.safeMetadata ?? {}, 'interrupted')
  const outputTruncated = events.some(event => metadataFlag(event.safeMetadata, 'output_truncated'))

  // 主要结果：assistant.completed 事件与幂等消息登记互证。事件存在但消息
  // 缺失 = 提交顺序断裂（appendEvent 已提交、appendMessage 未成功），按
  // 「未核验」处理而不是采信事件文本。
  let primaryOutput: TaskResult['primaryOutput'] = null
  if (lastAssistant) {
    const messageId = `message-assistant-${lastAssistant.id}`
    if (committedMessageIds.has(messageId)) {
      receipts.push({
        kind: 'answer',
        status: 'completed',
        ref: messageId,
        label: '回答已提交并完成持久化登记',
      })
      primaryOutput = {
        kind: 'text',
        messageId,
        truncated: metadataFlag(lastAssistant.safeMetadata, 'output_truncated'),
        interrupted,
      }
    } else {
      receipts.push({
        kind: 'answer',
        status: 'missing',
        ref: null,
        label: '回答提交事件已记录，但消息登记缺失',
      })
      pendingItems.push({
        kind: 'answer_uncommitted',
        message: '回答内容未成功写入对话记录，业务结果不可核验。',
      })
    }
  }

  // 成果：平台登记（artifact_versions）是唯一可信交付证据；Runtime 在终态
  // 事件里上报的 artifact_count 只是声明，登记数少于声明数即核验缺口。
  for (const { artifact, artifactVersionId } of registeredArtifacts) {
    receipts.push({
      kind: 'artifact',
      status: 'completed',
      ref: artifactVersionId,
      label: `成果已登记：${artifact.name}（v${artifact.version}）`,
    })
  }
  const artifactsClaimed = terminalMetadata ? metadataNumber(terminalMetadata, 'artifact_count') : null
  if (artifactsClaimed !== null && artifactsClaimed > artifacts.length) {
    receipts.push({
      kind: 'artifact',
      status: 'missing',
      ref: null,
      label: `执行声明 ${artifactsClaimed} 个成果，实际仅登记 ${artifacts.length} 个`,
    })
    pendingItems.push({
      kind: 'artifact_registration_gap',
      message: `执行报告生成 ${artifactsClaimed} 个成果，实际登记 ${artifacts.length} 个；缺失成果不视为已交付。`,
    })
  }

  // 平台工具回执：tool_audit_logs 区分两类记录——`decision` 非空的行是
  // approval.resolved 在执行前写入的授权决定，'success' 仅表示「已获准」，
  // 随后工具执行失败也不改变该行，只能投影为 accepted/rejected，绝不能
  // 当作「操作已完成」回执；`decision` 为空的行才是执行回执。
  for (const audit of toolAudits) {
    const toolName = audit.toolName ?? '受控工具'
    const approvalRecord = audit.decision !== null
    const status: TaskResultReceiptStatus =
      audit.result === 'blocked' ? 'rejected'
        : audit.result === 'failed' ? 'failed'
          : approvalRecord ? 'accepted' : 'completed'
    receipts.push({
      kind: 'tool',
      status,
      ref: audit.id,
      label: status === 'completed'
        ? `工具操作已完成：${toolName}`
        : status === 'accepted'
          ? `工具操作已获授权：${toolName}`
          : status === 'rejected'
            ? `工具操作被授权拒绝：${toolName}`
            : `工具操作执行失败：${toolName}`,
      detail: audit.decision ?? undefined,
    })
  }

  if (outputTruncated) {
    pendingItems.push({
      kind: 'output_truncated',
      message: '回答达到输出上限被截断，内容可能不完整。',
    })
  }
  if (interrupted) {
    pendingItems.push({
      kind: 'output_interrupted',
      message: interrupted === 'timeout'
        ? '回答因执行超时中断，仅保留了已生成的部分内容。'
        : '回答因服务中断终止，仅保留了已生成的部分内容。',
    })
  }

  const terminal = ['succeeded', 'failed', 'cancelled'].includes(run.status)
  // 内容登记 ≠ 业务达成：回答登记只证明内容落库；平台登记的成果版本与
  // completed 工具执行回执分别是文件型、工具型任务的可核验业务交付物。
  // 审批 accepted 不属于执行完成。没有可核验交付物时保持 unverified。
  const hasCommittedDeliverable = receipts.some(
    receipt => receipt.status === 'completed',
  )
  const hasVerifiedDeliverable = receipts.some(
    receipt => receipt.status === 'completed' && (receipt.kind === 'artifact' || receipt.kind === 'tool'),
  )
  let outcome: TaskResultOutcome
  if (!terminal) {
    outcome = 'pending'
  } else if (run.status !== 'succeeded') {
    outcome = 'not_achieved'
  } else {
    if (!hasCommittedDeliverable) {
      pendingItems.push({
        kind: 'no_deliverable',
        message: '执行结束但未登记任何回答或成果，无法核验业务结果。',
      })
    } else if (!hasVerifiedDeliverable) {
      pendingItems.push({
        kind: 'no_verified_deliverable',
        message: '回答已登记，但内容登记不能证明任务目标达成；本轮没有已登记成果或已完成工具动作等可核验证据。',
      })
    }
    outcome = hasVerifiedDeliverable && pendingItems.length === 0 ? 'achieved' : 'unverified'
  }

  const telemetry: TaskResultTelemetry = {
    stopReason: terminalMetadata ? metadataString(terminalMetadata, 'stop_reason') : null,
    toolCalls: terminalMetadata ? metadataNumber(terminalMetadata, 'tool_call_count') : null,
    toolResults: terminalMetadata ? metadataNumber(terminalMetadata, 'tool_result_count') : null,
    artifactsClaimed,
    artifactsRegistered: artifacts.length,
    inputTokens: terminalMetadata ? metadataNumber(terminalMetadata, 'input_tokens') : null,
    outputTokens: terminalMetadata ? metadataNumber(terminalMetadata, 'output_tokens') : null,
    elapsedMs: terminalMetadata ? metadataNumber(terminalMetadata, 'elapsed_ms') : null,
    outputTruncated,
    interrupted,
  }

  const error = run.status === 'failed' ? evidence.runError : null

  return {
    version: TASK_RESULT_VERSION,
    runId: run.id,
    attemptId: evidence.attemptId,
    execution: run.status,
    outcome,
    summary: summarize(outcome, pendingItems, error, run.status),
    primaryOutput,
    receipts,
    pendingItems,
    sources,
    artifacts,
    error,
    evidence: telemetry,
    completedAt: terminal
      ? (terminalEvent?.occurredAt ?? run.updatedAt).toISOString()
      : null,
  }
}
