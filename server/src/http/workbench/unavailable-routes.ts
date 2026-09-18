import { randomUUID } from 'node:crypto'

import { envelope, httpResult, type Router } from '../router.ts'

const basePath = '/api/workbench/v1'

/**
 * Prototype mode keeps read-only review data available, but it cannot execute a
 * real conversation. Register the command surface explicitly so a missing
 * database is reported as a configuration problem rather than a version skew.
 */
export function registerUnavailableWorkbenchCommandRoutes(router: Router) {
  router.post(`${basePath}/sessions`, async () => unavailable('对话'))
  router.delete(`${basePath}/sessions/:sessionId`, async (_request, context) =>
    unavailable(`对话 ${context.params['sessionId'] ?? ''}`))
  router.get(`${basePath}/sessions/:sessionId`, async (_request, context) =>
    unavailable(`对话 ${context.params['sessionId'] ?? ''}`))
  router.post(`${basePath}/sessions/:sessionId/messages`, async (_request, context) =>
    unavailable(`对话 ${context.params['sessionId'] ?? ''}`))
  router.post(`${basePath}/sessions/:sessionId/runs`, async (_request, context) =>
    unavailable(`对话 ${context.params['sessionId'] ?? ''}`))
  router.post(`${basePath}/sessions/:sessionId/files`, async (_request, context) =>
    unavailable(`对话 ${context.params['sessionId'] ?? ''} 的文件`))
  router.delete(`${basePath}/sessions/:sessionId/files/:fileId`, async (_request, context) =>
    unavailable(`对话 ${context.params['sessionId'] ?? ''} 的文件 ${context.params['fileId'] ?? ''}`))
  router.get(`${basePath}/runs/:runId`, async (_request, context) =>
    unavailable(`运行 ${context.params['runId'] ?? ''}`))
  router.get(`${basePath}/runs/:runId/events`, async (_request, context) =>
    unavailable(`运行 ${context.params['runId'] ?? ''}`))
  router.post(`${basePath}/runs/:runId/cancel`, async (_request, context) =>
    unavailable(`运行 ${context.params['runId'] ?? ''}`))
  router.post(`${basePath}/runs/:runId/retry`, async (_request, context) =>
    unavailable(`运行 ${context.params['runId'] ?? ''}`))

  // AG-03 自动任务：原型模式无持久化与调度，读侧给空集合让页面呈现空态，
  // 写侧一律 503——不伪造可执行的假数据。
  router.get(`${basePath}/automations`, async () => envelope('workbench', []))
  router.get(`${basePath}/automations/:automationId`, async (_request, context) =>
    unavailable(`自动任务 ${context.params['automationId'] ?? ''}`))
  router.post(`${basePath}/automations`, async () => unavailable('自动任务'))
  router.patch(`${basePath}/automations/:automationId`, async (_request, context) =>
    unavailable(`自动任务 ${context.params['automationId'] ?? ''}`))
  router.delete(`${basePath}/automations/:automationId`, async (_request, context) =>
    unavailable(`自动任务 ${context.params['automationId'] ?? ''}`))
  router.post(`${basePath}/automations/:automationId/enable`, async (_request, context) =>
    unavailable(`自动任务 ${context.params['automationId'] ?? ''}`))
  router.post(`${basePath}/automations/:automationId/pause`, async (_request, context) =>
    unavailable(`自动任务 ${context.params['automationId'] ?? ''}`))
  router.post(`${basePath}/automations/:automationId/trial-runs`, async (_request, context) =>
    unavailable(`自动任务 ${context.params['automationId'] ?? ''}`))
  router.post(`${basePath}/automations/:automationId/run-now`, async (_request, context) =>
    unavailable(`自动任务 ${context.params['automationId'] ?? ''}`))
  router.get(`${basePath}/automations/:automationId/executions`, async () =>
    envelope('workbench', []))
}

function unavailable(object: string) {
  return httpResult(503, {
    error: {
      code: 'workbench_runtime_not_configured',
      message: '当前对话服务不可用，暂时不能创建或执行对话',
      object,
      suggestion: '请联系管理员检查对话服务配置后重试。',
      traceId: `trace-http-${randomUUID()}`,
    },
  })
}
