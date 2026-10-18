import { resolvePlatformTimezone } from './domain/execution-time.ts'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

import { registerAgentRoutes } from './http/admin/agent-routes.ts'
import { PostgresAgentAccessService } from './modules/agent/agent-access-service.ts'
import { registerSkillRoutes } from './http/admin/skill-routes.ts'
import { registerToolRoutes } from './http/admin/tool-routes.ts'
import { registerModelGovernanceRoutes } from './http/admin/model-routes.ts'
import { registerOperationsRoutes } from './http/admin/operations-routes.ts'
import { registerIdentityAdministrationRoutes } from './http/admin/identity-routes.ts'
import { Router, envelope, httpResult } from './http/router.ts'
import { registerConversationRoutes } from './http/workbench/conversation-routes.ts'
import { registerContentRoutes } from './http/workbench/content-routes.ts'
import { registerWorkspaceLifecycleRoutes } from './http/workbench/workspace-lifecycle-routes.ts'
import { registerWorkspaceActivityRoutes } from './http/workbench/workspace-activity-routes.ts'
import { registerWorkspaceUsageRoutes } from './http/workbench/workspace-usage-routes.ts'
import { registerWorkspaceMemberRoutes } from './http/workbench/workspace-member-routes.ts'
import { registerWorkspaceAgentMemberRoutes } from './http/workbench/workspace-agent-member-routes.ts'
import { registerProjectRoutes } from './http/workbench/project-routes.ts'
import { registerWorkbenchAgentRoutes } from './http/workbench/agent-routes.ts'
import { registerOidcRoutes } from './http/auth-routes.ts'
import { registerLocalAuthRoutes } from './http/local-auth-routes.ts'
import { registerAuthConfigurationRoutes, registerSessionRoutes } from './http/session-routes.ts'
import { LocalAuthService } from './modules/identity/local-auth-service.ts'
import { checkDatabase, createDatabase } from './infrastructure/postgres/database.ts'
import { runMigrations } from './infrastructure/postgres/migration-runner.ts'
import { PostgresOperationsService } from './modules/admin/application/postgres-operations-service.ts'
import { PostgresGrantReconciliationService } from './modules/admin/application/postgres-grant-reconciliation-service.ts'
import { AdminAssistantService } from './modules/admin/application/admin-assistant-service.ts'
import { ModelGovernanceService } from './modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from './modules/model/postgres-model-governance-repository.ts'
import { PostgresConversationRepository } from './modules/workbench/application/postgres-conversation-repository.ts'
import { PostgresRunRepository } from './modules/run/postgres-run-repository.ts'
import type { JsonObject } from './modules/run/run-types.ts'
import { PostgresTaskRepository, platformToolOperationKey, taskOperationParameterDigest } from './modules/task/postgres-task-repository.ts'
import { RunOrchestrationService } from './modules/run/run-orchestration-service.ts'
import { RunRevocationSweep } from './modules/run/run-revocation-sweep.ts'
import { PostgresPersistentWaitService } from './modules/run/postgres-persistent-wait-service.ts'
import { DshAcpRuntimeAdapter } from './modules/runtime/dsh-acp-runtime-adapter.ts'
import { CapabilityGuardedRuntime, UnavailableRuntime, ExecutionCapabilityUnavailableError, probeExecutionCapability, type CapabilityState } from './modules/runtime/execution-capabilities.ts'
import type { AgentRuntimePort } from './modules/runtime/runtime-types.ts'
import { PythonSkillRunner } from './modules/runtime/python-skill-runner.ts'
import {
  preflightDshRuntime,
  resolveDshRuntimeInstallation,
  type DshRuntimeInstallation,
} from './modules/runtime/dsh-runtime-installation.ts'
import { PostgresContentService } from './modules/workbench/application/postgres-content-service.ts'
import { PostgresWorkspaceMemberService } from './modules/workbench/application/postgres-workspace-member-service.ts'
import { PostgresWorkspaceLifecycleService } from './modules/workbench/application/postgres-workspace-lifecycle-service.ts'
import { PostgresWorkspaceAgentMemberService } from './modules/workbench/application/postgres-workspace-agent-member-service.ts'
import { PostgresProjectArchiveService } from './modules/workbench/application/postgres-project-archive-service.ts'
import { PostgresProjectService } from './modules/workbench/application/postgres-project-service.ts'
import { PostgresWorkspaceActivityService } from './modules/workbench/application/postgres-workspace-activity-service.ts'
import { PostgresWorkspaceUsageService } from './modules/workbench/application/postgres-workspace-usage-service.ts'
import { PostgresWorkspaceService } from './modules/workbench/application/postgres-workspace-service.ts'
import { PostgresAgentService } from './modules/agent/postgres-agent-service.ts'
import { PostgresAgentValidationService } from './modules/agent/agent-validation-service.ts'
import { registerAgentValidationRoutes } from './http/admin/agent-validation-routes.ts'
import { PostgresAgentRunHistory } from './modules/agent/agent-run-history.ts'
import { registerAssistantRoutes } from './http/admin/assistant-routes.ts'
import { registerSkillInstallationRoutes } from './http/admin/skill-installation-routes.ts'
import { AdminSkillInstallationService } from './modules/skill/admin-skill-installation-service.ts'
import { acquireSkillSource } from './modules/skill/skill-source.ts'
import { PostgresSkillService } from './modules/skill/postgres-skill-service.ts'
import { SkillArtifactStore } from './modules/skill/skill-artifact-store.ts'
import { migrateSkillFilesToFileSystem } from './modules/skill/skill-file-storage-migration.ts'
import { PostgresToolConnectorService } from './modules/tool/postgres-tool-connector-service.ts'
import { PostgresEncryptedCredentialStore } from './modules/tool/postgres-encrypted-credential-store.ts'
import { PostgresKnowledgeService } from './modules/knowledge/postgres-knowledge-service.ts'
import { PostgresAuthorizationService } from './modules/authorization/postgres-authorization-service.ts'
import { PostgresAutomationRepository } from './modules/automation/postgres-automation-repository.ts'
import { AutomationService } from './modules/automation/automation-service.ts'
import { AgentRoutineService } from './modules/automation/agent-routine-service.ts'
import { registerAgentRoutineRecipientRoutes, registerAgentRoutineRoutes } from './http/admin/agent-routine-routes.ts'
import { AutomationTriggerSweep } from './modules/automation/automation-trigger-sweep.ts'
import { defaultAutomationConfig } from './modules/automation/automation-types.ts'
import { registerAutomationRoutes } from './http/workbench/automation-routes.ts'
import { registerTaskExecutionRoutes, registerTaskOperationAdminRoutes } from './http/workbench/task-execution-routes.ts'
import { registerPersistentApprovalRoutes } from './http/admin/persistent-approval-routes.ts'
import { registerAdminExperienceIterationRoutes } from './http/admin/experience-iteration-routes.ts'
import { PostgresControlledMemoryService } from './modules/memory/postgres-controlled-memory-service.ts'
import { PostgresTaskQueryService } from './modules/run/postgres-task-query-service.ts'
import { loadStartupIdentityConfiguration, localIdentityConfiguration } from './modules/identity/config.ts'
import { portalAuthenticator } from './modules/identity/portal-authenticator.ts'
import { OidcAuthService } from './modules/identity/auth-service.ts'
import { IdentityAdministrationService } from './modules/identity/administration-service.ts'
import { IdentityDirectorySyncService } from './modules/identity/directory-sync-service.ts'
import { RequestError, invalidRequest } from './domain/request-errors.ts'
import { LocalObjectStorage } from './infrastructure/storage/local-object-storage.ts'

const port = Number(process.env.DSH_WORK_SERVER_PORT ?? 4190)
// server/package.json sits one level above both src/main.ts and dist/main.js.
const serverVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
const host = process.env.DSH_WORK_SERVER_HOST ?? '127.0.0.1'

async function start() {
  const databaseUrl = process.env.DSH_WORK_DATABASE_URL
  // Sessions, identities and all business data live in PostgreSQL; there is no in-memory mode.
  if (!databaseUrl) throw invalidRequest('必须配置 DSH_WORK_DATABASE_URL：服务端会话与业务数据都保存在 PostgreSQL 中')
  // Validate authentication configuration before any database mutation.
  const identityConfiguration = loadStartupIdentityConfiguration()
  const database = createDatabase({ url: databaseUrl })
  await runMigrations(database)
  if (identityConfiguration.mode === 'local' && identityConfiguration.aiHubConfigurationIssue) {
    console.warn(`AI Hub 登录未启用：${identityConfiguration.aiHubConfigurationIssue}。独立账号登录仍可用。`)
  }

  const oidcAuthentication = identityConfiguration.mode === 'oidc'
    ? new OidcAuthService(identityConfiguration, database)
    : null
  const directorySync = identityConfiguration.mode === 'oidc'
    ? new IdentityDirectorySyncService(identityConfiguration, database)
    : null
  const localAuthentication = new LocalAuthService(localIdentityConfiguration(identityConfiguration), database)
  const router = new Router({ authenticateApi: portalAuthenticator(localAuthentication, oidcAuthentication) })
  if (oidcAuthentication) registerOidcRoutes(router, oidcAuthentication, localAuthentication)
  registerLocalAuthRoutes(router, localAuthentication, oidcAuthentication)
  registerSessionRoutes(router)
  registerAuthConfigurationRoutes(router, () => ({ mode: identityConfiguration.mode, localEnabled: true, aiHubEnabled: Boolean(oidcAuthentication) }))
  registerIdentityAdministrationRoutes(
    router,
    new IdentityAdministrationService(database, true),
    directorySync,
  )
  const directorySyncTimer = directorySync?.startScheduler() ?? null
  const modelRepository = new PostgresModelGovernanceRepository(database)

  let orchestration: RunOrchestrationService | null = null
  let revocationSweep: RunRevocationSweep | null = null
  let automationSweep: AutomationTriggerSweep | null = null
  let dshInstallation: DshRuntimeInstallation | null = null
  let executionRuntime: AgentRuntimePort | null = null
  let persistentWait: PostgresPersistentWaitService | null = null
  let memoryProposalSweep: NodeJS.Timeout | null = null
  let dshCapability: CapabilityState = { status: 'not-configured' }
  let pythonCapability: CapabilityState = { status: 'not-configured' }
  const projectRoot = fileURLToPath(new URL('../..', import.meta.url))
  const dataRoot = resolve(projectRoot, process.env.DSH_WORK_DATA_ROOT ?? '.runtime')
  const skillArtifacts = new SkillArtifactStore(new LocalObjectStorage(resolve(dataRoot, 'skills'), { fileMode: 0o400 }))
  await migrateSkillFilesToFileSystem(database, skillArtifacts)
  // Database migrations and identity initialization above stay fail-closed.
  // Only optional execution capabilities may fail independently.
  const dsh = await probeExecutionCapability('dsh', async () => {
    const installation = await resolveDshRuntimeInstallation({ projectRoot })
    await preflightDshRuntime(installation)
    return installation
  })
  dshInstallation = dsh.value
  dshCapability = dsh.state
  const python = await probeExecutionCapability('python', process.env.DSH_WORK_PYTHON_IMAGE ? async () => {
    const runner = new PythonSkillRunner(process.env.DSH_WORK_PYTHON_IMAGE!)
    await runner.preflight()
    return runner
  } : null)
  const pythonRunner = python.value
  pythonCapability = python.state
  const conversations = new PostgresConversationRepository(database)
  const authorization = new PostgresAuthorizationService(database, {
    // AI Hub 身份的后台任务必须复核目录；配置降级为 local 时传 null，
    // 授权服务仍按用户来源拒绝 AI Hub 后台执行，独立账号不受影响。
    // 信任窗口 = 同步间隔 ×2（interval=0 即关闭同步 → 兜底 60s 后 fail-closed）。
    automationDirectory: identityConfiguration.mode === 'oidc'
      ? {
          applicationId: identityConfiguration.applicationId,
          environment: identityConfiguration.environment,
          maxSyncAgeMs: Math.max(identityConfiguration.directorySyncIntervalSeconds * 2, 60) * 1000,
        }
      : null,
  })
  const content = new PostgresContentService(database, new LocalObjectStorage(resolve(dataRoot, 'storage')), authorization)
  const runs = new PostgresRunRepository(database)
  const tasks = new PostgresTaskRepository(database)
  const taskQueries = new PostgresTaskQueryService(database, tasks, runs)
  const toolServiceRef: { current?: PostgresToolConnectorService } = {}
  const persistentWaitRef: { current?: PostgresPersistentWaitService } = {}
  const controlledMemoryRef: { current?: PostgresControlledMemoryService } = {}
  const dshAdapter: AgentRuntimePort = dshInstallation ? new DshAcpRuntimeAdapter({
    runtimeId: 'runtime-local-01',
    runtimeRoot: resolve(dataRoot, 'dsh-attempts'),
    dshRepository: dshInstallation.home,
    runtimeVersion: dshInstallation.version,
    runtimeCommit: dshInstallation.commit,
    protocolVersion: dshInstallation.protocolVersion,
    launchMode: dshInstallation.launchMode,
    process: dshInstallation.process,
    authorizeExecution: async manifest => {
      if (!orchestration) throw new Error('运行授权服务尚未就绪')
      await orchestration.assertCurrentRunAuthorization(manifest)
    },
    resolveMcpConnections: async manifest => {
      if (!toolServiceRef.current) throw new Error('MCP Connector 服务尚未就绪')
      return toolServiceRef.current.resolveMcpRuntimeConnections(manifest)
    },
    recordMcpInvocation: async (manifest, invocation) => {
      if (!toolServiceRef.current) throw new Error('MCP Connector 审计服务尚未就绪')
      await toolServiceRef.current.recordMcpInvocation(manifest, invocation)
    },
    finalizeMcpInvocationAudit: async manifest => {
      if (!toolServiceRef.current) throw new Error('MCP Connector 审计服务尚未就绪')
      await toolServiceRef.current.finalizeMcpInvocationAudit(manifest)
    },
    permissionDecision: async (_request, manifest, context) => {
      if (!persistentWaitRef.current) return 'reject_once'
      return persistentWaitRef.current.decidePermission(manifest, context)
    },
    proposeMemory: (input, manifest, signal) => {
      if (!controlledMemoryRef.current) throw new Error('经验迭代服务尚未就绪')
      return controlledMemoryRef.current.proposeFromAttempt(input as { kind: 'preference' | 'experience'; title: string; content: string }, manifest, signal)
    },
    prepareSkillInstallation: (manifest, signal) => installationService.prepare(manifest, signal),
    inspectAdminState: (input, manifest, signal) => assistantService.inspectState(input, manifest, signal),
    proposeAdminTask: (input, manifest, signal) => assistantService.proposeTask(input, manifest, signal),
    prepareAdminAction: (input, manifest, signal) => assistantService.prepareAction(input, manifest, signal),
    loadSkillArtifact: skill => skillArtifacts.readRuntimeArtifact(skill.artifact_ref!, skill.files ?? [], skill.instructions_sha256!),
    recordSkillActivation: (manifest, skill, digest) => installationService.recordActivation(manifest, skill, digest),
    recordPythonExecution: (manifest, skillId, entry, succeeded) => installationService.recordPythonExecution(manifest, skillId, entry, succeeded),
    collectArtifacts: (manifest, workspaceDirectory) => content.publishRuntimeArtifacts({ manifest, workspaceDirectory }),
    operationLifecycle: manifest => ({
      async begin(input) {
        const parameterDigest = taskOperationParameterDigest(input.parameters)
        const accepted = await tasks.acceptOperation({
          tenantId: manifest.user_context.tenant_id,
          taskId: manifest.task_id,
          runId: manifest.run_id,
          attemptId: manifest.attempt_id,
          operationKey: platformToolOperationKey(input.toolName, parameterDigest, manifest.attempt_id),
          actionType: 'platform-tool-write',
          actionRef: input.toolName,
          parameterDigest,
          receipt: { callId: input.callId },
        })
        return { ...accepted.operation, execute: accepted.created }
      },
      async resolve(input) {
        await tasks.resolveOperation({
          tenantId: manifest.user_context.tenant_id,
          operationId: input.operationId,
          status: input.status,
          receipt: JSON.parse(JSON.stringify(input.receipt)) as JsonObject,
          errorCode: input.errorCode,
        })
      },
    }),
    ...(pythonRunner ? { executePython: (input, manifest, workspace, signal) => pythonRunner.execute(input, manifest, workspace, signal) } : {}),
  }) : new UnavailableRuntime('runtime-local-01')
  const runtime = new CapabilityGuardedRuntime(dshAdapter, pythonCapability)
  executionRuntime = runtime
  const workspaceMembers = new PostgresWorkspaceMemberService(database, authorization)
  const workspaceLifecycle = new PostgresWorkspaceLifecycleService(database)
  const workspaceActivity = new PostgresWorkspaceActivityService(database, new PostgresWorkspaceService(database))
  const workspaceUsage = new PostgresWorkspaceUsageService(database, new PostgresWorkspaceService(database), authorization)
  const operations = new PostgresOperationsService(
    database,
    runtime,
    authorization,
    identityConfiguration.mode === 'oidc' ? 'ai-hub-oidc' : identityConfiguration.mode === 'local' ? 'local-password' : 'mock',
  )
  const runtimePolicy = await operations.getRuntimePolicy('runtime-local-01')
  await runtime.configureScheduling(runtimePolicy.schedulingStatus)
  const credentialSecrets = process.env.DSH_CREDENTIAL_MASTER_KEY
    ? new PostgresEncryptedCredentialStore(database, {
        masterKeyBase64: process.env.DSH_CREDENTIAL_MASTER_KEY,
        keyId: process.env.DSH_CREDENTIAL_MASTER_KEY_ID,
      })
    : undefined
  const toolService = new PostgresToolConnectorService(database, runtime, operations, credentialSecrets)
  toolServiceRef.current = toolService
  // Management-plane inventory refresh is best effort: execution capability
  // failures must not prevent the core API from starting. Administrators can
  // retry the same full reconciliation from the Tool management page.
  void toolService.syncToolCatalog({ actor: 'U00008' }).catch(error => {
    console.warn('DSH tool catalog startup sync skipped:', error)
  })
  const skills = new PostgresSkillService(database, operations, toolService, skillArtifacts)
  // C7 only inspects execution capability; it never starts a Worker/model call.
  const checkInstallationRuntime = async (references: string[], requiredPackages: string[]) => {
    await runtime.assertAvailable()
    const health = await runtime.health()
    if (health.status === 'offline' || !health.acceptingRuns) throw new ExecutionCapabilityUnavailableError('dsh')
    if (references.includes('python_execute@1.0.0') && pythonCapability.status !== 'available') throw new ExecutionCapabilityUnavailableError('python')
    const configuredPackages = new Set(pythonPackages.map(value => value.toLowerCase()))
    if (requiredPackages.some(name => !configuredPackages.has(name.toLowerCase()))) {
      throw new RequestError(503, 'SKILL_DEPENDENCIES_UNAVAILABLE', '声明的 Python 依赖未配置并验证，当前不可发布')
    }
  }
  skills.setPublicationAvailabilityChecker(checkInstallationRuntime)
  const agents = new PostgresAgentService(database, operations, skills, toolService)
  const knowledge = new PostgresKnowledgeService(database)
  const controlledMemory = new PostgresControlledMemoryService(database, authorization, operations)
  controlledMemoryRef.current = controlledMemory
  memoryProposalSweep = setInterval(() => {
    void controlledMemory.purgeExpiredProposals().catch(error => {
      console.error('Expired memory proposal cleanup failed:', error)
    })
  }, 6 * 60 * 60 * 1000)
  memoryProposalSweep.unref()
  const workspaceAgentMembers = new PostgresWorkspaceAgentMemberService(database, authorization, agents)
  // 项目空间 S1：任务线程端口供编排使用，编排构造后再接回启动执行能力。
  const projectArchive = new PostgresProjectArchiveService(database)
  const projects = new PostgresProjectService(database, workspaceAgentMembers, projectArchive)
  // AG-03：仓库先建，orchestration 的执行前复核用它反查任务状态（暂停/停用兜底）。
  const automationRepository = new PostgresAutomationRepository(database)
  orchestration = new RunOrchestrationService(
    runs,
    conversations,
    new ModelGovernanceService(modelRepository),
    runtime,
    content,
    operations,
    agents,
    knowledge,
    authorization,
    // TW-10：团队会话 @Agent 触发经成员关联解析固定版本。
    {
      agentMembers: workspaceAgentMembers,
      automationStatusLookup: runId => automationRepository.automationStatusForRun(runId),
      // B-03/I-04：Attempt 固定绑定修订在领取后/桥接调用时复核当前有效性与语义摘要。
      toolBindings: toolService,
      tasks,
      memory: controlledMemory,
      projectTasks: projects,
      projectArchive,
      timezone: resolvePlatformTimezone(process.env.DSH_WORK_TIMEZONE),
    },
  )
  projects.attachRunStarter(orchestration)
  persistentWait = new PostgresPersistentWaitService(database, runs, {
    reauthorize: manifest => orchestration!.assertWaitingRunAuthorization(manifest),
    enqueue: (run, manifest) => orchestration!.enqueueResumedAttempt(run, manifest),
  }, dshInstallation?.version ?? 'unavailable')
  persistentWaitRef.current = persistentWait
  orchestration.setPersistentWaitService(persistentWait)
  persistentWait.start()
  const pythonPackages = (process.env.DSH_WORK_PYTHON_PACKAGES ?? '').split(',').map(value => value.trim()).filter(Boolean)
  const installationService: AdminSkillInstallationService = new AdminSkillInstallationService(database, orchestration, authorization, toolService, acquireSkillSource, Boolean(pythonRunner), pythonPackages, skillArtifacts, checkInstallationRuntime)
  const assistantService = new AdminAssistantService(database, orchestration, authorization, installationService, skills, agents, operations)
  skills.setPackageTester((userId, skill, prompt) => installationService.testPackage(userId, skill, prompt))
  skills.setPackageTestLifecycle({
    start: (userId, skill, prompt) => installationService.startPackageTest(userId, skill, prompt),
    progress: (userId, skill, runId) => installationService.packageTestProgress(userId, skill, runId),
  })
  registerAssistantRoutes(router, assistantService)
  registerSkillInstallationRoutes(router, installationService)
  const restartRecovery = await orchestration.recoverAfterServiceRestart()
  await persistentWait.reconcileOrphans()
  // 项目空间 S2：清扫重启中断的档案整理批次，避免空间长期停在“整理中”。
  // 与下面的成果解析补写一样，恢复失败只记录日志，不阻断服务启动。
  const archiveRecovery = await projectArchive.recoverInterruptedUpdates()
    .catch(error => {
      console.error('project archive recovery failed', error)
      return { finished: 0, abandoned: 0 }
    })
  if (archiveRecovery.finished > 0 || archiveRecovery.abandoned > 0) {
    console.warn('project archive recovery completed', archiveRecovery)
  }
  // EX-02：为旧成果补写原文解析，使其可在后续对话中“继续修改”；失败只记录，不阻断启动。
  await content.backfillArtifactExtractions()
    .then(result => { if (result.extracted > 0) console.warn('artifact extraction backfill completed', result) })
    .catch(error => console.error('artifact extraction backfill failed', error))
  if (restartRecovery.failed > 0 || restartRecovery.resumedQueued > 0) {
    console.warn('service restart recovery completed', restartRecovery)
  }
  const assistantRecovery = await assistantService.recoverInterruptedActions()
  if (assistantRecovery.inspected > 0) {
    console.warn('admin assistant action recovery completed', assistantRecovery)
  }
  // 1A-T5: 进程内撤权事件消费循环，与调度器同一生命周期（启动即开始、关停即停止）。
  revocationSweep = new RunRevocationSweep(database, runs, orchestration, authorization)
  revocationSweep.start()
  // AG-03：自动任务扫描与编排同一生命周期；pg advisory lock 保证
  // 单一调度所有者，第二个进程实例自动不启动扫描。
  const automationService = new AutomationService(
    database,
    automationRepository,
    conversations,
    runs,
    orchestration,
    authorization,
    agents,
    content,
    operations,
    defaultAutomationConfig,
  )
  const agentRoutineService = new AgentRoutineService(
    database, authorization, runs, orchestration, conversations, operations,
  )
  automationSweep = new AutomationTriggerSweep(
    database, automationRepository, automationService, defaultAutomationConfig, agentRoutineService,
  )
  await automationSweep.start()
  registerAutomationRoutes(router, automationService)
  registerAgentRoutineRoutes(router, agentRoutineService)
  registerAgentRoutineRecipientRoutes(router, agentRoutineService)
  registerTaskExecutionRoutes(router, taskQueries, orchestration, authorization)
  registerTaskOperationAdminRoutes(router, tasks, authorization)
  registerPersistentApprovalRoutes(router, persistentWait, authorization)
  registerAdminExperienceIterationRoutes(router, controlledMemory, authorization)
  registerConversationRoutes(router, conversations, orchestration, runs, agents, authorization, operations, skills, workspaceAgentMembers)
  registerContentRoutes(router, content, authorization, workspaceAgentMembers)
  registerWorkspaceMemberRoutes(router, workspaceMembers, authorization)
  registerWorkspaceLifecycleRoutes(router, workspaceLifecycle, authorization)
  registerWorkspaceActivityRoutes(router, workspaceActivity, authorization)
  registerWorkspaceUsageRoutes(router, workspaceUsage, authorization)
  registerWorkspaceAgentMemberRoutes(router, workspaceAgentMembers, authorization)
  registerProjectRoutes(router, projects, authorization, projectArchive)
  registerOperationsRoutes(router, operations, new PostgresGrantReconciliationService(database, operations))
  registerAgentRoutes(router, agents, new PostgresAgentAccessService(database, toolService))
  const agentValidation = new PostgresAgentValidationService(database, agents, skills, toolService, orchestration)
  // 启动收敛：重启前尚未取得 Run 的验证案例标为“服务重启中断”，可单独重跑；
  // 已在运行的案例 Run 由重启恢复收敛，读取验证时折叠为同一状态。
  const validationRecovery = await agentValidation.recoverInterruptedValidations()
  if (validationRecovery.interrupted > 0) console.warn('agent validation recovery completed', validationRecovery)
  registerAgentValidationRoutes(router, agents, agentValidation, new PostgresAgentRunHistory(database))
  registerSkillRoutes(router, skills)
  registerToolRoutes(router, toolService)
  registerWorkbenchAgentRoutes(router, agents, authorization)
  registerModelGovernanceRoutes(router, new ModelGovernanceService(modelRepository))

  router.get('/health/live', () => ({
    status: 'ok',
    service: 'dsh-work',
    version: serverVersion,
  }))

  router.get('/health/ready', async () => {
    // Configured authentication was validated before listen. Runtime availability
    // is intentionally separate; a DB outage never reports core readiness.
    try {
      await checkDatabase(database)
      return { status: 'ready', core: true, executionCapabilities: { dsh: dshCapability, python: pythonCapability } }
    } catch {
      return httpResult(503, { status: 'not-ready', core: false, code: 'DATABASE_UNAVAILABLE' })
    }
  })

  // Public and unauthenticated (nginx exposes it for release checks): statuses only.
  // Runtime versions, commits, paths and run counts stay behind the admin health API.
  router.get('/health', async () =>
    envelope('system', {
      service: 'dsh-work-server',
      status: 'ok',
      executionCapabilities: { dsh: { status: dshCapability.status }, python: { status: pythonCapability.status } },
      dshRuntime: {
        status: executionRuntime ? (await executionRuntime.health()).status : dshInstallation ? 'connected' : 'not-configured',
      },
      database: { status: (await checkDatabase(database)).ok ? 'ok' : 'unavailable' },
    }, 'postgres'),
  )

  const server = createServer((request, response) => void router.handle(request, response))
  server.listen(port, host, () => {
    console.log(`dsh-work server listening on http://${host}:${port}`)
  })

  const shutdown = () => {
    server.close(() => {
      void (async () => {
        if (directorySyncTimer) clearInterval(directorySyncTimer)
        if (memoryProposalSweep) clearInterval(memoryProposalSweep)
        if (automationSweep) await automationSweep.close()
        if (revocationSweep) revocationSweep.close()
        persistentWait?.close()
        if (orchestration) await orchestration.close()
        await database.end()
        process.exit(0)
      })()
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

await start()
