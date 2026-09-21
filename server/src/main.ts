import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

import { registerAdminRoutes } from './http/admin/routes.ts'
import { registerAgentRoutes } from './http/admin/agent-routes.ts'
import { registerSkillRoutes } from './http/admin/skill-routes.ts'
import { registerToolRoutes } from './http/admin/tool-routes.ts'
import { registerModelGovernanceRoutes } from './http/admin/model-routes.ts'
import { registerOperationsRoutes } from './http/admin/operations-routes.ts'
import { registerIdentityAdministrationRoutes } from './http/admin/identity-routes.ts'
import { Router, envelope, httpResult } from './http/router.ts'
import { registerPrototypeArtifactFileRoutes, registerWorkbenchRoutes } from './http/workbench/routes.ts'
import { registerConversationRoutes } from './http/workbench/conversation-routes.ts'
import { registerContentRoutes } from './http/workbench/content-routes.ts'
import { registerWorkspaceLifecycleRoutes } from './http/workbench/workspace-lifecycle-routes.ts'
import { registerWorkspaceActivityRoutes } from './http/workbench/workspace-activity-routes.ts'
import { registerWorkspaceUsageRoutes } from './http/workbench/workspace-usage-routes.ts'
import { registerWorkspaceMemberRoutes } from './http/workbench/workspace-member-routes.ts'
import { registerWorkspaceAgentMemberRoutes } from './http/workbench/workspace-agent-member-routes.ts'
import { registerWorkbenchAgentRoutes } from './http/workbench/agent-routes.ts'
import { registerUnavailableWorkbenchCommandRoutes } from './http/workbench/unavailable-routes.ts'
import { registerOidcRoutes } from './http/auth-routes.ts'
import { checkDatabase, createDatabase } from './infrastructure/postgres/database.ts'
import { runMigrations } from './infrastructure/postgres/migration-runner.ts'
import { PrototypeRepository } from './infrastructure/prototype/prototype-repository.ts'
import { AdminQueryService } from './modules/admin/application/admin-query-service.ts'
import { PostgresOperationsService } from './modules/admin/application/postgres-operations-service.ts'
import { PostgresGrantReconciliationService } from './modules/admin/application/postgres-grant-reconciliation-service.ts'
import { AdminAssistantService } from './modules/admin/application/admin-assistant-service.ts'
import { MemoryModelGovernanceRepository } from './modules/model/memory-model-governance-repository.ts'
import { ModelGovernanceService } from './modules/model/model-governance-service.ts'
import { PostgresModelGovernanceRepository } from './modules/model/postgres-model-governance-repository.ts'
import { WorkbenchQueryService } from './modules/workbench/application/workbench-query-service.ts'
import { PostgresConversationRepository } from './modules/workbench/application/postgres-conversation-repository.ts'
import { PostgresRunRepository } from './modules/run/postgres-run-repository.ts'
import type { JsonObject } from './modules/run/run-types.ts'
import { PostgresTaskRepository, taskOperationParameterDigest } from './modules/task/postgres-task-repository.ts'
import { RunOrchestrationService } from './modules/run/run-orchestration-service.ts'
import { RunRevocationSweep } from './modules/run/run-revocation-sweep.ts'
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
import { PostgresWorkspaceActivityService } from './modules/workbench/application/postgres-workspace-activity-service.ts'
import { PostgresWorkspaceUsageService } from './modules/workbench/application/postgres-workspace-usage-service.ts'
import { PostgresWorkspaceService } from './modules/workbench/application/postgres-workspace-service.ts'
import { PostgresAgentService } from './modules/agent/postgres-agent-service.ts'
import { PostgresAgentReleaseService } from './modules/agent/postgres-agent-release-service.ts'
import { registerAgentReleaseRoutes } from './http/admin/agent-release-routes.ts'
import { registerAssistantRoutes } from './http/admin/assistant-routes.ts'
import { registerSkillInstallationRoutes } from './http/admin/skill-installation-routes.ts'
import { AdminSkillInstallationService } from './modules/skill/admin-skill-installation-service.ts'
import { acquireSkillSource } from './modules/skill/skill-source.ts'
import { PostgresSkillService } from './modules/skill/postgres-skill-service.ts'
import { FileSystemSkillArtifactStore } from './modules/skill/file-system-skill-artifact-store.ts'
import { migrateSkillFilesToFileSystem } from './modules/skill/skill-file-storage-migration.ts'
import { PostgresToolConnectorService } from './modules/tool/postgres-tool-connector-service.ts'
import { PostgresKnowledgeService } from './modules/knowledge/postgres-knowledge-service.ts'
import { PostgresAuthorizationService } from './modules/authorization/postgres-authorization-service.ts'
import { PostgresAutomationRepository } from './modules/automation/postgres-automation-repository.ts'
import { AutomationService } from './modules/automation/automation-service.ts'
import { AutomationTriggerSweep } from './modules/automation/automation-trigger-sweep.ts'
import { defaultAutomationConfig } from './modules/automation/automation-types.ts'
import { registerAutomationRoutes } from './http/workbench/automation-routes.ts'
import { registerTaskExecutionRoutes, registerTaskOperationAdminRoutes } from './http/workbench/task-execution-routes.ts'
import { PostgresTaskQueryService } from './modules/task/postgres-task-query-service.ts'
import { loadIdentityConfiguration } from './modules/identity/config.ts'
import { OidcAuthService } from './modules/identity/auth-service.ts'
import { IdentityAdministrationService } from './modules/identity/administration-service.ts'
import { IdentityDirectorySyncService } from './modules/identity/directory-sync-service.ts'
import { prototypeApiAuthenticator } from './modules/identity/prototype-authenticator.ts'

const port = Number(process.env.DSH_WORK_SERVER_PORT ?? 4190)
const host = process.env.DSH_WORK_SERVER_HOST ?? '127.0.0.1'

async function start() {
  const repository = new PrototypeRepository()
  const workbenchQueries = new WorkbenchQueryService(repository)
  const identityConfiguration = loadIdentityConfiguration()
  const databaseUrl = process.env.DSH_WORK_DATABASE_URL
  const database = databaseUrl ? createDatabase({ url: databaseUrl }) : null

  if (identityConfiguration.mode === 'oidc' && !database) {
    throw new Error('AI Hub OIDC 模式必须配置 DSH_WORK_DATABASE_URL 以保存服务端会话')
  }

  if (database) await runMigrations(database)
  const oidcAuthentication = identityConfiguration.mode === 'oidc' && database
    ? new OidcAuthService(identityConfiguration, database)
    : null
  const directorySync = identityConfiguration.mode === 'oidc' && database
    ? new IdentityDirectorySyncService(identityConfiguration, database)
    : null
  const router = new Router({
    authenticateApi: oidcAuthentication
      ? (request, audience) => oidcAuthentication.authenticateApi(request, audience)
      : prototypeApiAuthenticator,
  })
  if (oidcAuthentication) registerOidcRoutes(router, oidcAuthentication)
  if (database && directorySync) {
    registerIdentityAdministrationRoutes(
      router,
      new IdentityAdministrationService(database),
      directorySync,
    )
  }
  const directorySyncTimer = directorySync?.startScheduler() ?? null
  const modelRepository = database
    ? new PostgresModelGovernanceRepository(database)
    : new MemoryModelGovernanceRepository()

  let orchestration: RunOrchestrationService | null = null
  let revocationSweep: RunRevocationSweep | null = null
  let automationSweep: AutomationTriggerSweep | null = null
  let dshInstallation: DshRuntimeInstallation | null = null
  let executionRuntime: AgentRuntimePort | null = null
  let dshCapability: CapabilityState = { status: 'not-configured' }
  let pythonCapability: CapabilityState = { status: 'not-configured' }
  if (database) {
    const projectRoot = fileURLToPath(new URL('../..', import.meta.url))
    const dataRoot = resolve(projectRoot, process.env.DSH_WORK_DATA_ROOT ?? '.runtime')
    const skillArtifacts = new FileSystemSkillArtifactStore(resolve(dataRoot, 'skills'))
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
      // AG-03：OIDC 模式下自动任务后台主体校验需要目录新鲜度，
      // 信任窗口 = 同步间隔 ×2（interval=0 即关闭同步 → 兜底 60s 后 fail-closed）。
      automationDirectory: identityConfiguration.mode === 'oidc'
        ? {
            applicationId: identityConfiguration.applicationId,
            environment: identityConfiguration.environment,
            maxSyncAgeMs: Math.max(identityConfiguration.directorySyncIntervalSeconds * 2, 60) * 1000,
          }
        : null,
    })
    const content = new PostgresContentService(database, resolve(dataRoot, 'storage'), authorization)
    const runs = new PostgresRunRepository(database)
    const tasks = new PostgresTaskRepository(database)
    const dshAdapter: AgentRuntimePort = dshInstallation ? new DshAcpRuntimeAdapter({
      runtimeId: 'runtime-local-01',
      runtimeRoot: resolve(dataRoot, 'dsh-attempts'),
      dshRepository: dshInstallation.home,
      toolCatalogPath: dshInstallation.toolCatalogPath,
      runtimeVersion: dshInstallation.version,
      runtimeCommit: dshInstallation.commit,
      protocolVersion: dshInstallation.protocolVersion,
      launchMode: dshInstallation.launchMode,
      process: dshInstallation.process,
      authorizeExecution: async manifest => {
        if (!orchestration) throw new Error('运行授权服务尚未就绪')
        await orchestration.assertCurrentRunAuthorization(manifest)
      },
      // No durable human-approval channel is wired to ACP yet. Manifests that
      // require approval therefore fail closed instead of silently escalating.
      permissionDecision: async () => 'reject_once',
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
            operationKey: `tool:${taskOperationParameterDigest({ tool: input.toolName, parameterDigest })}`,
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
      identityConfiguration.mode === 'oidc' ? 'ai-hub-oidc' : 'mock',
    )
    const runtimePolicy = await operations.getRuntimePolicy('runtime-local-01')
    await runtime.configureScheduling(runtimePolicy.schedulingStatus)
    const tools = new PostgresToolConnectorService(database, runtime, operations)
    const skills = new PostgresSkillService(database, operations, tools, skillArtifacts)
    // C7 only inspects execution capability; it never starts a Worker/model call.
    const checkInstallationRuntime = async (references: string[], requiredPackages: string[]) => {
      await runtime.assertAvailable()
      const health = await runtime.health()
      if (health.status === 'offline' || !health.acceptingRuns) throw new ExecutionCapabilityUnavailableError('dsh')
      if (references.includes('python_execute@1.0.0') && pythonCapability.status !== 'available') throw new ExecutionCapabilityUnavailableError('python')
      const configuredPackages = new Set(pythonPackages.map(value => value.toLowerCase()))
      if (requiredPackages.some(name => !configuredPackages.has(name.toLowerCase()))) {
        throw Object.assign(new Error('声明的 Python 依赖未配置并验证，当前不可发布'), { status: 503, code: 'SKILL_DEPENDENCIES_UNAVAILABLE' })
      }
    }
    skills.setPublicationAvailabilityChecker(checkInstallationRuntime)
    const agents = new PostgresAgentService(database, operations, skills, tools)
    const knowledge = new PostgresKnowledgeService(database)
    const workspaceAgentMembers = new PostgresWorkspaceAgentMemberService(database, authorization, agents)
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
        toolBindings: tools,
        tasks,
      },
    )
    const pythonPackages = (process.env.DSH_WORK_PYTHON_PACKAGES ?? '').split(',').map(value => value.trim()).filter(Boolean)
    const installationService: AdminSkillInstallationService = new AdminSkillInstallationService(database, orchestration, authorization, tools, acquireSkillSource, Boolean(pythonRunner), pythonPackages, skillArtifacts, checkInstallationRuntime)
    const assistantService = new AdminAssistantService(database, orchestration, authorization, installationService, skills, agents, operations)
    skills.setPackageTester((userId, skill, prompt) => installationService.testPackage(userId, skill, prompt))
    skills.setPackageTestLifecycle({
      start: (userId, skill, prompt) => installationService.startPackageTest(userId, skill, prompt),
      progress: (userId, skill, runId) => installationService.packageTestProgress(userId, skill, runId),
    })
    registerAssistantRoutes(router, assistantService)
    registerSkillInstallationRoutes(router, installationService)
    const restartRecovery = await orchestration.recoverAfterServiceRestart()
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
    automationSweep = new AutomationTriggerSweep(
      database, automationRepository, automationService, defaultAutomationConfig,
    )
    await automationSweep.start()
    registerAutomationRoutes(router, automationService)
    registerTaskExecutionRoutes(router, new PostgresTaskQueryService(database, tasks, runs), orchestration, authorization)
    registerTaskOperationAdminRoutes(router, tasks, authorization)
    registerConversationRoutes(router, conversations, orchestration, runs, agents, authorization, operations, skills, workspaceAgentMembers)
    registerContentRoutes(router, content, authorization, workspaceAgentMembers)
    registerWorkspaceMemberRoutes(router, workspaceMembers, authorization)
    registerWorkspaceLifecycleRoutes(router, workspaceLifecycle, authorization)
    registerWorkspaceActivityRoutes(router, workspaceActivity, authorization)
    registerWorkspaceUsageRoutes(router, workspaceUsage, authorization)
    registerWorkspaceAgentMemberRoutes(router, workspaceAgentMembers, authorization)
    registerOperationsRoutes(router, operations, new PostgresGrantReconciliationService(database, operations))
    registerAgentRoutes(router, agents)
    registerAgentReleaseRoutes(router, new PostgresAgentReleaseService(database, agents, skills, tools, resolve(dataRoot, 'agent-packages'), orchestration))
    registerSkillRoutes(router, skills)
    registerToolRoutes(router, tools)
    registerWorkbenchAgentRoutes(router, agents, authorization)
  } else {
    registerUnavailableWorkbenchCommandRoutes(router)
    registerPrototypeArtifactFileRoutes(router, workbenchQueries)
    registerAssistantRoutes(router)
    registerSkillInstallationRoutes(router)
  }
  registerWorkbenchRoutes(router, workbenchQueries)
  registerAdminRoutes(router, new AdminQueryService(repository))
  registerModelGovernanceRoutes(router, new ModelGovernanceService(modelRepository))

  router.get('/health/live', () => ({
    status: 'ok',
    service: 'dsh-work',
    version: '0.1.0',
  }))

  router.get('/health/ready', async () => {
    // Configured authentication was validated before listen. Runtime availability
    // is intentionally separate; a DB outage never reports core readiness.
    try {
      if (database) await checkDatabase(database)
      return { status: 'ready', core: true, executionCapabilities: { dsh: dshCapability, python: pythonCapability } }
    } catch {
      return httpResult(503, { status: 'not-ready', core: false, code: 'DATABASE_UNAVAILABLE' })
    }
  })

  router.get('/health', async () =>
    envelope('system', {
      service: 'dsh-work-server',
      status: 'ok',
      architecture: 'node-modular-monolith',
      persistence: database ? 'postgres-foundation' : 'prototype-memory',
      sso: identityConfiguration.mode === 'oidc' ? 'ai-hub-oidc' : 'mock',
      executionCapabilities: { dsh: dshCapability, python: pythonCapability },
      dshRuntime: executionRuntime ? await executionRuntime.health() : dshInstallation ? {
        status: 'connected',
        version: dshInstallation.version,
        commit: dshInstallation.commit,
        protocolVersion: dshInstallation.protocolVersion,
        launchMode: dshInstallation.launchMode,
      } : 'not-configured',
      database: database ? await checkDatabase(database) : 'not-configured',
    }, database ? 'postgres' : 'prototype-memory'),
  )

  const server = createServer((request, response) => void router.handle(request, response))
  server.listen(port, host, () => {
    console.log(`dsh-work server listening on http://${host}:${port}`)
  })

  const shutdown = () => {
    server.close(() => {
      void (async () => {
        if (directorySyncTimer) clearInterval(directorySyncTimer)
        if (automationSweep) await automationSweep.close()
        if (revocationSweep) revocationSweep.close()
        if (orchestration) await orchestration.close()
        if (database) await database.end()
        process.exit(0)
      })()
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

await start()
