import { RequestError } from '../../domain/request-errors.ts'
import type { RequestIdentity } from '../identity/types.ts'
import type { WeknoraClient, WeknoraSession } from './client.ts'
import { WeknoraAccountNotProvisionedError } from './client.ts'
import type { WeknoraConfig } from './config.ts'
import type { WeknoraLinkStore } from './link-store.ts'
import { cacheExpiryMs, cacheKey, WeknoraSessionCache } from './session-cache.ts'

export type WeknoraDirectoryAccount = 'none' | 'missing' | 'linked'

export interface WeknoraStatus {
  configured: boolean
  linked: boolean
  source: 'directory' | 'bind' | null
  canUnlink: boolean
  directoryAccount: WeknoraDirectoryAccount
}

export interface WeknoraIdentityContext {
  userId: string
  subject: string
  identityProvider: RequestIdentity['identityProvider']
  externalUserId: string | null
}

export interface WeknoraUserDirectoryLookup {
  loadExternalUserId(userId: string): Promise<string | null>
}

export class WeknoraAccessService {
  private readonly config: WeknoraConfig | null
  readonly client: WeknoraClient | null
  private readonly links: WeknoraLinkStore
  private readonly directory: WeknoraUserDirectoryLookup
  private readonly cache: WeknoraSessionCache

  constructor(
    config: WeknoraConfig | null,
    client: WeknoraClient | null,
    links: WeknoraLinkStore,
    directory: WeknoraUserDirectoryLookup,
    cache = new WeknoraSessionCache(),
  ) {
    this.config = config
    this.client = client
    this.links = links
    this.directory = directory
    this.cache = cache
  }

  isConfigured() {
    return this.config !== null && this.client !== null
  }

  async getStatus(identity: WeknoraIdentityContext): Promise<WeknoraStatus> {
    if (!this.isConfigured()) {
      return {
        configured: false,
        linked: false,
        source: null,
        canUnlink: false,
        directoryAccount: 'none',
      }
    }
    const link = await this.links.findByUserId(identity.userId)
    const directoryAccount = await this.resolveDirectoryAccount(identity)
    const linked = directoryAccount === 'linked' || link !== null
    let source: WeknoraStatus['source'] = null
    if (directoryAccount === 'linked') source = 'directory'
    else if (link) source = 'bind'
    const canUnlink = Boolean(link && source !== 'directory')
    return {
      configured: true,
      linked,
      source,
      canUnlink,
      directoryAccount,
    }
  }

  async startBind(identity: WeknoraIdentityContext, redirectUri: string, state: string) {
    this.requireConfigured()
    const status = await this.getStatus(identity)
    if (status.linked && status.source === 'directory') {
      throw new RequestError(409, 'state_conflict', '知识库账号已连接')
    }
    await this.links.purgeExpiredBindStates()
    await this.links.saveBindState(state, identity.userId, new Date(Date.now() + 10 * 60 * 1000))
    return this.client!.startBind(redirectUri, state)
  }

  async completeBind(expectedUserId: string, bindCode: string) {
    this.requireConfigured()
    const { userId: weknoraUserId } = await this.client!.redeemBindCode(bindCode)
    await this.links.upsert(expectedUserId, weknoraUserId, 'bind')
    this.cache.deleteByUser(expectedUserId)
  }

  async unlink(identity: WeknoraIdentityContext) {
    await this.links.delete(identity.userId)
    this.cache.deleteByUser(identity.userId)
  }

  async consumeBindState(state: string) {
    return this.links.consumeBindState(state)
  }

  async loadExternalUserId(userId: string) {
    return this.directory.loadExternalUserId(userId)
  }

  async withAccessToken<T>(
    identity: WeknoraIdentityContext,
    run: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    this.requireLinked(await this.getStatus(identity))
    const session = await this.ensureSession(identity)
    try {
      return await run(session.accessToken)
    } catch (error) {
      if (error instanceof RequestError && error.code === 'weknora_unavailable') {
        this.cache.delete(cacheKey(identity.userId, session.weknoraUserId))
        const retrySession = await this.ensureSession(identity, true)
        return run(retrySession.accessToken)
      }
      throw error
    }
  }

  private async ensureSession(identity: WeknoraIdentityContext, forceRefresh = false): Promise<CachedWeknoraSession> {
    const link = await this.links.findByUserId(identity.userId)
    const directoryAccount = await this.resolveDirectoryAccount(identity)
    let weknoraUserId = link?.weknoraUserId
    let source: 'directory' | 'bind' | null = link ? 'bind' : null

    if (directoryAccount === 'linked') {
      const directorySession = await this.exchangeDirectory(identity)
      weknoraUserId = directorySession.userId
      if (!link || link.weknoraUserId !== weknoraUserId) {
        await this.links.upsert(identity.userId, weknoraUserId, 'directory')
      }
      source = 'directory'
    } else if (link) {
      weknoraUserId = link.weknoraUserId
    }

    if (!weknoraUserId) {
      throw new RequestError(409, 'weknora_not_linked', '请先连接知识库账号')
    }

    const key = cacheKey(identity.userId, weknoraUserId)
    if (!forceRefresh) {
      const cached = this.cache.get(key)
      if (cached) return cached
    }

    const session = source === 'directory' || directoryAccount === 'linked'
      ? await this.exchangeDirectory(identity)
      : await this.client!.exchangeSession({ userId: weknoraUserId })

    const cached: CachedWeknoraSession = {
      accessToken: session.accessToken,
      weknoraUserId: session.userId,
      expiresAtMs: cacheExpiryMs(session.expiresIn),
    }
    this.cache.set(key, cached)
    return cached
  }

  private async exchangeDirectory(identity: WeknoraIdentityContext): Promise<WeknoraSession> {
    const externalUserId = await this.directory.loadExternalUserId(identity.userId)
    return this.client!.exchangeSession({
      subject: identity.subject,
      aiHubUserId: externalUserId ?? undefined,
    })
  }

  private async resolveDirectoryAccount(identity: WeknoraIdentityContext): Promise<WeknoraDirectoryAccount> {
    if (identity.identityProvider !== 'ai-hub-oidc') return 'none'
    try {
      await this.exchangeDirectory(identity)
      return 'linked'
    } catch (error) {
      if (error instanceof WeknoraAccountNotProvisionedError) return 'missing'
      return 'none'
    }
  }

  private requireConfigured() {
    if (!this.isConfigured()) {
      throw new RequestError(503, 'weknora_not_configured', '知识库尚未配置')
    }
  }

  private requireLinked(status: WeknoraStatus) {
    this.requireConfigured()
    if (!status.linked) {
      throw new RequestError(409, 'weknora_not_linked', '请先连接知识库账号')
    }
  }
}

interface CachedWeknoraSession {
  accessToken: string
  weknoraUserId: string
  expiresAtMs: number
}

export function toWeknoraIdentity(identity: RequestIdentity, externalUserId: string | null): WeknoraIdentityContext {
  return {
    userId: identity.userId,
    subject: identity.subject,
    identityProvider: identity.identityProvider,
    externalUserId,
  }
}
