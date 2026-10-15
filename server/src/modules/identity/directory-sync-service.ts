import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'
import { AiHubClient } from './ai-hub-client.ts'
import { OidcProviderClient } from './oidc-client.ts'
import { IdentitySessionRepository } from './session-repository.ts'
import type { DirectoryUser, OidcIdentityConfiguration } from './types.ts'
import { dependencyUnavailable, invalidRequest, stateConflict } from '../../domain/request-errors.ts'

const serviceScopes = ['ai_hub.identity', 'platform.directory.read']

export class IdentityDirectorySyncService {
  private readonly configuration: OidcIdentityConfiguration
  private readonly repository: IdentitySessionRepository
  private readonly platform: AiHubClient
  private readonly provider: OidcProviderClient

  constructor(configuration: OidcIdentityConfiguration, database: DatabaseClient) {
    this.configuration = configuration
    this.repository = new IdentitySessionRepository(database)
    this.platform = new AiHubClient(configuration.platformUrl)
    const settings = configuration.audiences.admin
    this.provider = new OidcProviderClient({
      issuer: settings.issuer,
      clientId: settings.clientId,
      clientSecret: settings.clientSecret,
      expectedAudience: settings.tokenAudience,
      cacheTtlSeconds: configuration.jwksCacheTtlSeconds,
      staleTtlSeconds: configuration.jwksStaleTtlSeconds,
    })
  }

  state() {
    return this.repository.directorySyncState(
      this.configuration.applicationId,
      this.configuration.environment,
    )
  }

  async synchronize(input: { actorId: string; full?: boolean }) {
    const applicationId = this.configuration.applicationId
    const environment = this.configuration.environment
    if (input.full) await this.repository.resetDirectoryCursor(applicationId, environment)
    const run = await this.repository.beginDirectorySync(applicationId, environment)
    if (!run) throw stateConflict('员工目录同步当前状态为运行中，请稍后刷新状态')

    let cursor = run.cursor
    let synchronizedUsers = 0
    try {
      const tokens = await this.provider.clientCredentials(serviceScopes)
      if (tokens.scope) requireGrantedScopes(tokens.scope, serviceScopes)
      for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
        const page = await this.platform.directoryUsers(
          tokens.accessToken,
          applicationId,
          { cursor, limit: 500 },
        )
        for (const user of page.items) {
          await this.repository.synchronizeIdentity(directoryIdentity(user))
          synchronizedUsers += 1
        }
        const nextCursor = page.next_cursor
        await this.repository.advanceDirectorySync({
          applicationId,
          environment,
          runId: run.runId,
          cursor: nextCursor,
          synchronizedUsers,
        })
        if (!page.has_more) {
          cursor = nextCursor
          break
        }
        if (!nextCursor || nextCursor === cursor) {
          throw new Error('AI Hub 员工目录游标没有向前推进')
        }
        cursor = nextCursor
        if (pageNumber === 9_999) throw invalidRequest('AI Hub 员工目录分页超过安全上限')
      }
      await this.repository.finishDirectorySync({
        applicationId,
        environment,
        runId: run.runId,
        cursor,
        synchronizedUsers,
      })
      await this.repository.appendAudit({
        userId: input.actorId,
        action: 'identity.directory.sync',
        result: 'success',
        audience: input.actorId.startsWith('service:') ? 'system' : 'admin',
        objectType: 'identity_directory',
        objectId: applicationId,
        context: { environment, full: Boolean(input.full), synchronizedUsers },
      })
      return this.state()
    } catch (error) {
      const message = safeErrorMessage(error)
      await this.repository.failDirectorySync({
        applicationId,
        environment,
        runId: run.runId,
        error: message,
      })
      await this.repository.appendAudit({
        userId: input.actorId,
        action: 'identity.directory.sync',
        result: 'failed',
        audience: input.actorId.startsWith('service:') ? 'system' : 'admin',
        objectType: 'identity_directory',
        objectId: applicationId,
        context: { environment, full: Boolean(input.full), error: message },
      })
      throw error
    }
  }

  startScheduler() {
    const synchronize = () => {
      void this.synchronize({ actorId: 'service:dsh-work-directory' }).catch((error) => {
        console.warn('employee directory synchronization failed', safeErrorMessage(error))
      })
    }
    // Reconcile immediately after migrations so fail-closed legacy rows do not
    // wait for the first interval and platform accounts are removed promptly.
    synchronize()
    if (this.configuration.directorySyncIntervalSeconds === 0) return null
    const interval = setInterval(
      synchronize,
      this.configuration.directorySyncIntervalSeconds * 1000,
    )
    interval.unref()
    return interval
  }
}

function directoryIdentity(user: DirectoryUser) {
  return {
    externalUserId: user.user_id,
    subject: user.subject,
    displayName: user.display_name,
    email: user.email,
    organizationName: user.organization_name,
    businessUser: user.business_user,
    status: user.status,
    tombstone: user.tombstone,
    updatedAt: user.updated_at,
  }
}

function requireGrantedScopes(scope: string, required: string[]) {
  const granted = new Set(scope.split(/\s+/).filter(Boolean))
  const missing = required.filter(item => !granted.has(item))
  if (missing.length > 0) {
    throw dependencyUnavailable(`AI Hub 服务令牌不可用：缺少目录 Scope ${missing.join('、')}`)
  }
}

function safeErrorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : '员工目录同步失败'
  return raw.replace(/[\r\n\t]+/g, ' ').slice(0, 500)
}
