// 团队工作空间 1A 退出条件核对（handoff §7 / plan §7 批次表）。
//
// 退出条件本身由集成测试证明（各自需要一次性数据库），这里做「证据锚点」检查：
// 关键契约路径、迁移、接口与测试用例必须仍然存在，任一被删/改名即失败，防止
// 协作、AC-26 共享授权、AC-09 收权这三项交付物在后续改动中静默退化。

const workbenchRequired = [
  '/workspaces/{workspaceId}/members',
  '/workspaces/{workspaceId}/members/{userId}',
  '/workspaces/{workspaceId}/agent-members',
  '/workspaces/{workspaceId}/agent-members/{id}',
]

export function checkTeamWorkspace1a(check) {
  // 退出条件 1：两名员工和一个 Agent 可协作 —— 员工/Agent 成员管理与名册可读。
  const workbench = check.json('docs/development/openapi-workbench.json')
  for (const path of workbenchRequired) {
    check.assert(Boolean(workbench?.paths?.[path]), `docs/development/openapi-workbench.json 缺少路径 ${path}`)
  }
  for (const method of ['get', 'post']) {
    check.assert(
      Boolean(workbench?.paths?.['/workspaces/{workspaceId}/members']?.[method]),
      `员工成员名册契约缺少 ${method.toUpperCase()}`,
    )
  }
  check.includes('server/src/http/workbench/workspace-member-routes.ts', [
    "router.get(`${basePath}/workspaces/:workspaceId/members`",
  ])
  check.includes('apps/workbench-web/src/views/WorkspaceDetailView.vue', ['listWorkspaceMembers'])

  // 退出条件 2：多 Agent 共享授权不误删（AC-26）—— 来源多对多、对账门禁与原有用例。
  check.includes('server/src/modules/authorization/postgres-workspace-grant-source-service.ts', [
    'revokeGrantSourcesByRef',
    'assertNoUnresolvedLegacySources',
  ])
  check.includes('server/src/modules/admin/application/postgres-grant-reconciliation-service.ts', [
    'legacy_unresolved',
    "'manual'",
  ])
  check.includes('server/src/http/workspace-agent-member-api.integration.test.ts', [
    '共享工具授权由另一 Agent 保留',
  ])

  // 退出条件 3：撤权阻止新增、排队与后续交付（AC-09 口径，T5 交付）。
  check.includes('server/src/modules/run/run-revocation-sweep.ts', [
    'isRevocationEffective',
    'sweepWorkspaceActiveRuns',
    'systemCancelRun',
  ])
  check.includes('server/src/modules/run/run-orchestration-service.ts', [
    'systemCancelRun',
    'recheckExecutionAuthorization',
  ])
  check.includes('server/src/http/workbench/conversation-routes.ts', ['authorizeTeamReadAccess'])
  check.includes('server/src/infrastructure/postgres/m5-revocation-pipeline.integration.test.ts', [
    '收权清扫：member_removed',
    '收权清扫：agent_disabled',
    'SSE 写出竞态',
    '执行前复核通过后',
  ])

  // 团队授权基础与死信迁移必须仍在。
  check.includes('server/migrations/0022_team_workspace_authorization.sql', [
    'workspace_agent_members',
    'workspace_grant_sources',
    'workspace_revocation_events',
    'assert_team_workspace_single_owner',
  ])
  check.includes('server/migrations/0023_revocation_event_dead_letter.sql', ['dead_letter'])
}
