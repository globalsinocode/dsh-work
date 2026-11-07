import type { DatabaseTransaction } from '../../infrastructure/postgres/database.ts'

/** 安装与审核共用的 Skill 身份规则：名称规范化、版本递增、默认试运行提示与同名互斥锁。 */
export const DEFAULT_SKILL_TEST_PROMPT = '请按照 Skill 说明完成一个最小示例；有参考资料时实际读取并说明结果，缺少业务输入时明确指出。'

/** 防止重复安装的规范化名称（`skills.installation_key`）。 */
export function installationKey(name: string) {
  return name.trim().normalize('NFC').toLowerCase()
}

export function nextInstalledVersion(current: string) {
  const [major = 0, minor = 0] = current.split('.').map(Number)
  return `${major}.${minor + 1}.0`
}

/** 同一规范化名称的安装、审核发布在事务内互斥，避免并发时撞唯一索引。 */
export async function lockInstallationKey(transaction: DatabaseTransaction, tenantId: string, key: string) {
  await transaction`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:skill-install:${key}`}, 0))`
}
