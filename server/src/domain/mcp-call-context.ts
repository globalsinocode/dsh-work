import { classifyLoginAccount } from './login-account-kind.ts'

/**
 * 外部业务应用调用上下文（外部业务应用接入方案 5.1，EA-S1）：开启“发送员工身份”的 MCP Connector
 * 在每次请求中以明文请求头收到本次结果的可见类型与员工标识，外部应用凭该 Connector 的 Bearer 凭据
 * 确认请求来自 dsh-work。本模块只做纯计算，不读库。
 */

export type McpCallVisibility = 'personal' | 'shared'

export interface McpCallContextViewer {
  userId: string
  /** 登录账号（手机号或邮箱，或旧账号名）；按登录规则判定，手机号去掉 `+86`，旧账号名不发送。 */
  loginAccount?: string | null
  dingtalkUserId?: string | null
}

export interface McpCallContext {
  visibility: McpCallVisibility
  /** 仅 personal 时存在。 */
  viewer?: McpCallContextViewer
  runId: string
  attemptId: string
  agentId?: string | null
}

const ASCII_HEADER_VALUE = /^[\x21-\x7e]{1,254}$/

/**
 * 本次运行的结果可见类型（方案第 4 节“运行与结果受众”）：发布验证与管理端运行不发送调用上下文（null）；
 * Agent 主动任务只给接收人，一律 personal；其余按工作空间类型：项目空间 shared，个人空间 personal。
 */
export function mcpCallVisibility(input: {
  purpose?: string
  workspaceType: 'personal' | 'team' | null
}): McpCallVisibility | null {
  const { purpose, workspaceType } = input
  if (purpose === 'agent-release-trial' || (purpose !== undefined && purpose.startsWith('admin-'))) return null
  if (purpose === 'agent-routine') return 'personal'
  if (workspaceType === 'team') return 'shared'
  if (workspaceType === 'personal') return 'personal'
  return null
}

/** 调用上下文请求头。值都是 ASCII，含其他字符的员工标识略去，避免整个 Attempt 因请求头无效失败。 */
export function mcpCallContextHeaders(context: McpCallContext): Record<string, string> {
  const headers: Record<string, string> = {
    'X-DSH-Work-Visibility': context.visibility,
    'X-DSH-Work-Run-Id': context.runId,
    'X-DSH-Work-Attempt-Id': context.attemptId,
  }
  if (context.agentId) headers['X-DSH-Work-Agent-Id'] = context.agentId
  if (context.visibility === 'personal' && context.viewer) {
    const { userId, loginAccount, dingtalkUserId } = context.viewer
    headers['X-DSH-Work-Viewer-User-Id'] = userId
    // 与登录同一判定（normalizeLoginAccount）：旧账号名（如 `zhang@corp`）既不是手机号也不是邮箱，不发送。
    const account = loginAccount ? classifyLoginAccount(loginAccount) : null
    if (account?.kind === 'mobile') headers['X-DSH-Work-Viewer-Mobile'] = account.value
    if (account?.kind === 'email') headers['X-DSH-Work-Viewer-Email'] = account.value
    if (dingtalkUserId) headers['X-DSH-Work-Viewer-Dingtalk-Userid'] = dingtalkUserId
  }
  return Object.fromEntries(Object.entries(headers).filter(([, value]) => ASCII_HEADER_VALUE.test(value)))
}
