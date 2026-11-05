import { createHmac } from 'node:crypto'

import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import { IdentityAccessError } from './auth-service.ts'

/**
 * 登录尝试窗口（跨进程与重启共享，键为 HMAC，不保存账号或钉钉 userid 原文）。
 *
 * 反向代理之后所有请求共用同一个对端地址，按连接地址限流会变成全公司共用一个配额，因此应用内不按 IP
 * 限流；按 IP 的限流在公网反向代理上配置（部署手册“公网入口”）。尝试在校验前预留（并发猜测不能超过上限），
 * 成功后清除，只有连续失败才会锁定。
 */
export class LoginRateLimiter {
  private readonly database: DatabaseClient
  private readonly secret: string

  constructor(database: DatabaseClient, secret: string) {
    this.database = database
    this.secret = secret
  }

  async consume(key: string, limit = 10) {
    const [row] = await this.database<{ attempts: number }[]>`
      insert into local_auth_rate_limits (key_hash, attempts, expires_at)
      values (${this.hash(key)}, 1, now() + interval '15 minutes')
      on conflict (key_hash) do update set
        attempts = case when local_auth_rate_limits.expires_at <= now() then 1 else least(local_auth_rate_limits.attempts + 1, 1000) end,
        expires_at = case when local_auth_rate_limits.expires_at <= now() then now() + interval '15 minutes' else local_auth_rate_limits.expires_at end
      returning attempts
    `
    if (!row || row.attempts > limit) throw new IdentityAccessError(429, 'login_rate_limited', '尝试次数过多，请 15 分钟后重试')
    await this.database`delete from local_auth_rate_limits where expires_at < now() - interval '1 day'`
  }

  async clear(key: string) {
    await this.database`delete from local_auth_rate_limits where key_hash = ${this.hash(key)}`
  }

  private hash(key: string) {
    return createHmac('sha256', this.secret).update(key).digest('hex')
  }
}
