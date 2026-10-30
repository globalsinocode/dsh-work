import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import { accessDenied, invalidRequest, notFound, stateConflict } from '../../domain/request-errors.ts'
import type { PostgresPersistentWaitService } from '../../modules/run/postgres-persistent-wait-service.ts'
import type { RunRepository } from '../../modules/run/run-repository.ts'
import { tenantId } from '../../modules/run/orchestration/orchestration-dependencies.ts'
import { envelope, readJsonBody, requireRequestIdentity, type Router } from '../router.ts'

const basePath = '/api/workbench/v1'

export function registerRunApprovalRoutes(
  router: Router,
  database: DatabaseClient,
  runs: RunRepository,
  persistentWait: PostgresPersistentWaitService,
  adapter: 'postgres' | 'prototype-memory' = 'postgres',
) {
  router.post(`${basePath}/runs/:runId/approval`, async (request, context) => {
    const identity = requireRequestIdentity(context, 'workbench')
    const runId = context.params['runId'] ?? ''
    const body = await readJsonBody<{ decision?: unknown } | null>(request)
    const decision = body?.decision
    if (decision !== 'approved' && decision !== 'rejected') {
      throw invalidRequest('decision 仅支持 approved 或 rejected')
    }

    const run = await runs.getRun(tenantId, runId)
    if (!run) throw notFound('Run 不存在')
    if (run.requestedBy !== identity.userId) {
      throw accessDenied('仅发起人可确认本次操作')
    }

    const approvalId = await findPendingApprovalId(database, runId)
    if (!approvalId) throw stateConflict('当前没有待决的审批')

    await persistentWait.resolve({
      approvalId,
      decision,
      actor: identity.userId,
      resolutionKey: `employee:${identity.userId}:${approvalId}:${decision}`,
    })

    return envelope('workbench', { runId, decision }, adapter)
  })
}

async function findPendingApprovalId(database: DatabaseClient, runId: string): Promise<string | null> {
  const [row] = await database<{ id: string }[]>`
    select id
      from run_approval_requests
     where tenant_id = ${tenantId}
       and run_id = ${runId}
       and status = 'pending'
     order by requested_at asc
     limit 1
  `
  return row?.id ?? null
}
