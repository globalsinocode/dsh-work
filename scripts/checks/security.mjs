import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'

// These forbidden dependencies and production safeguards supplement behavior tests.
// Method names, SQL formatting and UI copy are intentionally left to their test suites.
export function checkSecurity(check) {
  check.excludes('server/src/modules/identity/ai-hub-client.ts', ['/me/permissions', '/authorization/decisions'])
  check.excludes('server/src/modules/identity/types.ts', ['dsh_work.'])
  check.excludes('server/src/modules/identity/auth-service.ts', ['claim.owner_user_id'])
  for (const file of ['run-orchestration-service.ts', 'orchestration/attempt-dispatcher.ts', 'orchestration/run-event-recorder.ts']) {
    check.excludes(`server/src/modules/run/${file}`, ["role_ids: ['role-employee']", 'publishAssistantResult'])
  }
  const initialMigration = check.read('server/migrations/0001_m2_platform.sql').toLowerCase()
  for (const secret of ['api_key text', 'secret_value', 'credential_value']) {
    check.assert(!initialMigration.includes(secret), `初始化迁移不得包含明文凭据列 ${secret}`)
  }
  check.includes('server/src/modules/identity/config.ts', [
    "mode === 'prototype') throw", '`__Host-${name}`', 'DSH_WORK_COOKIE_SECURE',
    'DSH_WORK_DIRECTORY_SYNC_INTERVAL_SECONDS',
  ])
  // Test identities and in-memory smoke data must never be reachable from the application entry point.
  check.assert(!/from '\.\/testing\//.test(check.read('server/src/main.ts')), 'server/src/main.ts 不得引用 server/src/testing 下的测试身份或冒烟数据')
  // HTTP status and authorization denials come from typed errors, never from message wording.
  const router = check.read('server/src/http/router.ts')
  check.assert(!/\/[^/\n]*[\u4e00-\u9fff][^/\n]*\/[a-z]*\.test\(/.test(router) && !/\.includes\('[^']*[\u4e00-\u9fff]/.test(router),
    'server/src/http/router.ts 不得按错误消息文字判断状态码，请抛出 server/src/domain/request-errors.ts 中的类型化错误')
  check.excludes('server/src/domain/authorization-errors.ts', ['LEGACY_DENIAL_MESSAGES', 'message.includes('])
  check.excludes('server/src/modules/workbench/application/postgres-workspace-member-service.ts', ['/exactly one owner/'])
  for (const file of serverSourceFiles(check)) {
    check.assert(!/Object\.assign\(new Error\([\s\S]{0,400}?\bstatus:/.test(check.read(file)),
      `${file} 不得用 Object.assign 拼装 HTTP 状态，请使用 server/src/domain/request-errors.ts 中的 RequestError 或工厂函数`)
  }
  check.includes('server/src/modules/identity/auth-service.ts', [
    'equalOpaqueHash', 'validateRequestOrigin', 'refreshTokensWithLock', 'resolveAuthorization',
  ])
  check.includes('server/src/modules/runtime/acp-json-rpc-client.ts', [
    'buildAcpChildEnvironment', 'isSensitiveEnvironmentKey', 'redactSensitiveText',
  ])
  check.assert(!/spawn\([\s\S]{0,400}env:\s*process\.env/.test(check.read('server/src/modules/runtime/acp-json-rpc-client.ts')),
    'ACP 子进程不得直接继承 process.env')
  check.includes('server/config/dsh/dsh-work-tool-policy.js', ['ctx.tools.guard', 'DSH_ALLOWED_TOOLS_JSON'])
  check.includes('server/src/modules/runtime/dsh-acp-runtime-adapter.ts', ['DSH_ALLOWED_TOOLS_JSON'])
  check.includes('server/src/security/safe-observability.ts', ['sanitizeSafeMetadata', 'redactSensitiveText'])
  check.includes('server/migrations/0016_identity_owned_authorization.sql', [
    'local_authorization_version', 'application_admin_bootstrap_claims', 'identity_directory_sync_state',
    "delete from user_roles where source_key like 'ai-hub:%'", 'user_roles_local_source_check',
  ])
  check.includes('server/migrations/0017_business_user_directory.sql', ['business_user boolean not null default false'])
  check.includes('server/migrations/0018_fail_closed_directory_reconciliation.sql', ['business_user = false', 'cursor = null'])
}

/** Production server sources (no tests, no test-only support). */
function serverSourceFiles(check) {
  return readdirSync(resolve(check.root, 'server/src'), { recursive: true })
    .map(file => String(file).split('\\').join('/'))
    .filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.startsWith('testing/') && !file.includes('/testing/'))
    .map(file => `server/src/${file}`)
}
