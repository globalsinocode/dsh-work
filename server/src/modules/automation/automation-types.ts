import type { RuntimeScopeCeiling } from '../authorization/postgres-authorization-service.ts'
import type { ExecutionSchedule } from '../../domain/execution-schedule.ts'
import type { JsonObject } from '../../domain/run-state.ts'
import type { TaskResultOutcome } from '../../domain/task-result.ts'

/**
 * AG-03 轻量自动任务——模块类型。
 *
 * 设计依据 docs/development/feature-rules.md 第 7 节：
 * - 任务引用固定 Agent Version（不跟随最新版）；
 * - schedule 是唯一时区权威存储；manual 任务 next_slot_utc 恒为 null；
 * - 执行状态不冗余存储，经 run_id 读 Run；执行记录只承载受理结果。
 */

/** 结构化调度规则。定义在领域层，自动任务与项目任务共用。 */
export type AutomationSchedule = ExecutionSchedule

export type AutomationStatus = 'draft' | 'enabled' | 'paused' | 'disabled'

/** 任务级执行预算上限；落到 Manifest limits 做钳制。 */
export interface AutomationBudget {
  timeoutSeconds?: number
  maxToolCalls?: number
  maxOutputBytes?: number
}

/** 确定性输入模板：prompt + 已授权文件绑定 + 预算。 */
export interface AutomationInputTemplate {
  prompt: string
  fileIds?: string[]
  budget?: AutomationBudget
}

export interface AutomationRecord {
  id: string
  tenantId: string
  ownerUserId: string
  name: string
  agentVersionId: string
  /** 展示用：钉住版本所属的业务 Agent / 名称 / 版本号；Agent 删除后为 null。 */
  agentId: string | null
  agentName: string | null
  agentVersion: string | null
  workspaceId: string
  schedule: AutomationSchedule
  scheduleRevision: number
  /** 下一次未处理槽位（UTC ISO）；manual 为 null。 */
  nextSlotUtc: string | null
  inputTemplate: AutomationInputTemplate
  /** 启用时批准的授权上限快照（与当前授权求交后生效）。 */
  scopeCeiling: RuntimeScopeCeiling
  /** 最近一次启用时确认通过的规范化执行配置摘要。 */
  confirmedConfigRevision: string
  revision: number
  status: AutomationStatus
  /** 归档时间；status=disabled 且曾显式归档时有值。 */
  archivedAt: string | null
  archivedBy: string | null
  createdAt: string
  updatedAt: string
}

export interface AutomationExecutionPage {
  items: AutomationExecutionRecord[]
  nextCursor: string | null
  hasMore: boolean
}

export type AutomationExecutionKind = 'scheduled' | 'manual' | 'missed'

export type AutomationAdmissionStatus = 'accepted' | 'skipped' | 'interrupted'

/** 列表投影：最近一次执行的摘要，供“最近一次”展示；不含冻结配置。 */
export interface AutomationLastExecution {
  id: string
  kind: AutomationExecutionKind
  plannedSlotUtc: string | null
  missedFromUtc: string | null
  missedToUtc: string | null
  admissionStatus: AutomationAdmissionStatus
  reasonCode: string | null
  runStatus: string | null
  resultOutcome: TaskResultOutcome | null
  createdAt: string
}

export interface AutomationListItem extends AutomationRecord {
  lastExecution: AutomationLastExecution | null
}

/** 受理时冻结的执行配置——恢复与审计不允许回读任务现值。 */
export interface FrozenExecutionConfig {
  agentVersionId: string
  workspaceId: string
  ownerUserId: string
  prompt: string
  fileIds: string[]
  scopeCeiling: RuntimeScopeCeiling
  /** 受理时「当前授权 ∩ 上限」的交集结果，进入 Manifest 与复核子集校验。 */
  decisionRoleIds: string[]
  decisionDataScopes: string[]
  budget: AutomationBudget
  /** 试运行受理标记：draft/paused 任务的试执行在复核时按试运行口径放行。 */
  trial?: boolean
}

export interface AutomationExecutionRecord {
  id: string
  tenantId: string
  automationId: string
  triggerId: string
  kind: AutomationExecutionKind
  plannedSlotUtc: string | null
  missedFromUtc: string | null
  missedToUtc: string | null
  taskRevision: number
  scheduleRevision: number
  requestFingerprint: string | null
  executionConfig: FrozenExecutionConfig | null
  sessionId: string | null
  runId: string | null
  admissionStatus: AutomationAdmissionStatus
  reasonCode: string | null
  createdAt: string
  updatedAt: string
  /** 列表投影：关联 Run 的当前状态（未受理为 null）。 */
  runStatus?: string | null
  /**
   * I-06：关联 Run 的业务结果核验状态（task-result/v1 的 outcome）。
   * 由服务层按结果契约投影，未受理或投影缺失为 null；不复制第二份结果状态机。
   */
  resultOutcome?: TaskResultOutcome | null
}

/** reason_code 枚举（自由文本前缀允许 detail；UI 按主码展示）。 */
export const AutomationReasonCodes = {
  overlap: 'overlap',
  subjectInvalid: 'subject_invalid',
  authorizationDenied: 'authorization_denied',
  userPendingLimit: 'user_pending_limit',
  globalPendingLimit: 'global_pending_limit',
  slotExpired: 'slot_expired',
  taskPaused: 'task_paused',
  taskDisabled: 'task_disabled',
  scheduleChanged: 'schedule_changed',
  dispatchInterrupted: 'dispatch_interrupted',
  duplicateRequest: 'duplicate_request',
} as const

export interface AutomationModuleConfig {
  /** 触发扫描周期（毫秒）。 */
  sweepIntervalMs: number
  /** 槽位迟到容差：超出记 missed 不执行（毫秒）。 */
  maxSlotLatenessMs: number
  /** 每任务每轮最多枚举的到期槽位数（防长时间停机时的扫描膨胀）。 */
  maxSlotsPerTaskPerTick: number
  /** 每用户未终结执行上限（受理软上限）。 */
  userPendingLimit: number
  /** 全局未终结自动任务执行上限。 */
  globalPendingLimit: number
}

export const defaultAutomationConfig: AutomationModuleConfig = {
  sweepIntervalMs: 30_000,
  maxSlotLatenessMs: 10 * 60_000,
  maxSlotsPerTaskPerTick: 32,
  userPendingLimit: 10,
  globalPendingLimit: 200,
}

export interface AutomationRunRequest {
  idempotencyKey: string
}

export function frozenConfigToJson(config: FrozenExecutionConfig): JsonObject {
  return JSON.parse(JSON.stringify(config)) as JsonObject
}
