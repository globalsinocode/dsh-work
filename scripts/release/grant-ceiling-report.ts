/**
 * 功能规则第 13 节的上线存量清单：列出由非平台管理员授出、且超出其当前权限的
 * 部门授权与 Agent 岗位权限。只读，不修改任何数据；结果供平台管理员复核。
 *
 * 用法（在目标环境的应用目录执行）：
 *   node --experimental-strip-types --env-file-if-exists=.env scripts/release/grant-ceiling-report.ts
 */
import { createDatabase } from '../../server/src/infrastructure/postgres/database.ts'
import { listGrantCeilingExceptions } from '../../server/src/modules/authorization/grant-ceiling-report.ts'

const url = process.env.DSH_WORK_DATABASE_URL
if (!url) {
  console.error('请先配置 DSH_WORK_DATABASE_URL')
  process.exit(1)
}
const database = createDatabase({ url, maxConnections: 2 })
try {
  const exceptions = await listGrantCeilingExceptions(database)
  if (!exceptions.length) {
    console.log('没有超出授予人权限的存量授权。')
  } else {
    console.log(`共 ${exceptions.length} 项超出授予人当前权限的存量授权（按授予人当前权限比较，未自动回收）：`)
    for (const item of exceptions) {
      const kind = item.kind === 'department-grant' ? '部门授权' : 'Agent 岗位权限'
      const missing = [
        item.missingPermissions.length ? `权限 ${item.missingPermissions.join('、')}` : '',
        item.missingDataScopes.length ? `数据范围 ${item.missingDataScopes.join('、')}` : '',
      ].filter(Boolean).join('；')
      console.log(`- ${kind}：${item.objectName}（${item.objectId}），授予人 ${item.grantedByName}，超出 ${missing}`)
    }
  }
} finally {
  await database.end()
}
