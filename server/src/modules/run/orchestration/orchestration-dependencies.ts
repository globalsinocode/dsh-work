import type { RunRecord } from '../run-types.ts'
import type { ModelGovernanceService } from '../../model/model-governance-service.ts'
import type { AgentRuntimePort } from '../../runtime/runtime-types.ts'
import type { PostgresConversationRepository } from '../../workbench/application/postgres-conversation-repository.ts'
import type { PostgresContentService } from '../../workbench/application/postgres-content-service.ts'
import type { RunOperationsPort } from '../run-operations-port.ts'
import type { PostgresAgentService } from '../../agent/postgres-agent-service.ts'
import type { PostgresToolConnectorService } from '../../tool/postgres-tool-connector-service.ts'
import type { ExecutionToolCheckPort } from '../current-execution-authorization.ts'
import type { PostgresAgentDelegationService } from '../postgres-agent-delegation-service.ts'
import type { PostgresKnowledgeService } from '../../knowledge/postgres-knowledge-service.ts'
import type { PostgresControlledMemoryService } from '../../memory/postgres-controlled-memory-service.ts'
import type { PostgresAuthorizationService } from '../../authorization/postgres-authorization-service.ts'
import type { PostgresWorkspaceAgentMemberService } from '../../workbench/application/postgres-workspace-agent-member-service.ts'
import type { RunRepository } from '../run-repository.ts'
import type { TaskRepository } from '../../task/task-repository.ts'
import type { PostgresPersistentWaitService } from '../postgres-persistent-wait-service.ts'
import type { ProjectTaskThreadPort } from '../../workbench/application/postgres-project-service.ts'
import type { ProjectArchivePort } from '../../workbench/application/postgres-project-archive-service.ts'

export const tenantId = 'tenant-dsh-work'
export const runtimeId = 'runtime-local-01'

export type PersistentWaitPort = Pick<PostgresPersistentWaitService, 'cancelRun' | 'activateWaiting' | 'cancelPreparingForAttempt'>
export type DelegationPort = Pick<PostgresAgentDelegationService, 'assertActiveDelegation' | 'markChildRunning' | 'observeChildTerminal' | 'cancelActiveDescendants'>
export type ToolBindingCheckPort = Pick<PostgresToolConnectorService, 'assertActiveToolBindings' | 'assertActiveMcpConnections'>
export type { ExecutionToolCheckPort }

/**
 * Collaborators shared by the orchestration components. Optional members are absent in
 * narrow test wiring. The persistent-wait service is wired after
 * construction (they depend on orchestration themselves), so components read them at
 * call time rather than copying them.
 */
export interface OrchestrationDependencies {
  readonly runs: RunRepository
  readonly conversations: PostgresConversationRepository
  readonly models: ModelGovernanceService
  readonly runtime: AgentRuntimePort
  readonly content?: PostgresContentService
  readonly operations?: RunOperationsPort
  readonly agents?: PostgresAgentService
  readonly knowledge?: PostgresKnowledgeService
  readonly memory?: PostgresControlledMemoryService
  readonly authorization?: PostgresAuthorizationService
  readonly agentMembers?: PostgresWorkspaceAgentMemberService
  /** 项目空间 S1：任务线程固定承接 Agent，并为执行带上当前项目简报。 */
  readonly projectTasks?: ProjectTaskThreadPort & { assertTaskThreadIdle(sessionId: string): Promise<void> }
  /** 项目空间 S2：项目档案与档案员整理批次。 */
  readonly projectArchive?: ProjectArchivePort
  /** per-agent MCP 连接 pin 复核（tonycc PostgresMcpConnectorService）。 */
  readonly toolChecks?: ExecutionToolCheckPort
  /** B-03/I-04 工具绑定与 MCP user grant 复核（globalsinocode PostgresToolConnectorService）。 */
  readonly toolBindings?: ToolBindingCheckPort
  readonly tasks?: TaskRepository
  readonly automationMaxConcurrent: number
  /** Platform default IANA timezone for a run's current time (DSH_WORK_TIMEZONE). */
  readonly timezone: string
  readonly automationStatusLookup?: (runId: string) => Promise<{ status: string; trial: boolean } | null>
  persistentWait?: PersistentWaitPort
  delegation?: DelegationPort
  /** EX-02 conversation summaries; wired by the facade after construction. */
  sessionSummaries?: SessionSummaryPort
  /** 项目空间 S2 项目档案员；wired by the facade after construction. */
  projectArchivist?: ProjectArchivistPort
}

export interface SessionSummaryPort {
  scheduleAfterRun(run: RunRecord): Promise<void>
  onRunTerminal(run: RunRecord, status: 'succeeded' | 'failed' | 'cancelled', output: string): Promise<boolean>
}

export interface ProjectArchivistPort {
  afterTaskRun(run: RunRecord, output: string): Promise<void>
  onRunTerminal(run: RunRecord, status: 'succeeded' | 'failed' | 'cancelled', output: string): Promise<boolean>
}
