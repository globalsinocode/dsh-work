import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { authorizationDenied } from '../../domain/authorization-errors.ts'
import { invalidRequest, notFound, stateConflict } from '../../domain/request-errors.ts'
import type { DatabaseClient, DatabaseTransaction } from '../../infrastructure/postgres/database.ts'
import type { McpConnectionSnapshot } from '../runtime/runtime-types.ts'
import {
  authorizationUrl,
  createPkce,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
} from './mcp-oauth.ts'
import { McpUserCredentialStore, type McpUserTokenPair } from './mcp-user-credential-store.ts'
import { PostgresEncryptedCredentialStore } from './postgres-encrypted-credential-store.ts'

const tenantId = 'tenant-dsh-work'
const TRANSACTION_TTL_MS = 10 * 60 * 1000

export type McpUserGrantListStatus = 'unauthorized' | 'active' | 'reauthorization_required' | 'disabled'

export interface McpUserGrantListItem {
  connectorId: string
  name: string
  scopeDescription: string
  toolCount: number
  status: McpUserGrantListStatus
}

export interface McpUserGrantApplyResult {
  pins: McpConnectionSnapshot[]
  omitted: Array<{ connectorId: string; name: string }>
  blocked: Array<{ connectorId: string; name: string }>
}

export interface McpOAuthProbeRegistrationInput {
  name: string
  endpoint: string
  authorizationEndpoint: string
  tokenEndpoint: string
  clientId: string
  scopes: string[]
  resource?: string
}

export class McpUserGrantService {
  private readonly database: DatabaseClient
  private readonly userCredentials: McpUserCredentialStore
  private readonly connectorCredentials?: PostgresEncryptedCredentialStore
  private readonly fetchImpl: typeof fetch

  constructor(
    database: DatabaseClient,
    userCredentials: McpUserCredentialStore,
    connectorCredentials?: PostgresEncryptedCredentialStore,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.database = database
    this.userCredentials = userCredentials
    this.connectorCredentials = connectorCredentials
    this.fetchImpl = fetchImpl
  }

  async listForUser(userId: string, page = 1, pageSize = 100): Promise<{
    list: McpUserGrantListItem[]
    total: number
    page: number
    pageSize: number
  }> {
    const safePage = Math.max(1, page)
    const safePageSize = Math.min(100, Math.max(1, pageSize))
    const rows = await this.database<Array<{
      connectorId: string
      name: string
      scopeDescription: string
      toolCount: number
      grantStatus: string | null
      connectorStatus: string
    }>>`
      select c.id as "connectorId", c.name, c.scope_description as "scopeDescription",
             coalesce(p.capability_snapshot, '[]'::jsonb) as "capabilitySnapshot",
             jsonb_array_length(coalesce(p.capability_snapshot, '[]'::jsonb))::int as "toolCount",
             g.status as "grantStatus", c.status as "connectorStatus"
        from connectors c
        join mcp_connector_profiles p on p.tenant_id = c.tenant_id and p.connector_id = c.id
        left join mcp_user_grants g on g.tenant_id = c.tenant_id
          and g.connector_id = c.id and g.user_id = ${userId}
       where c.tenant_id = ${tenantId} and c.protocol = 'mcp' and c.auth_type = 'user_oauth'
         and c.deleted_at is null and c.status <> 'disabled'
       order by c.name
    `
    const list = rows.map(row => ({
      connectorId: row.connectorId,
      name: row.name,
      scopeDescription: row.scopeDescription,
      toolCount: row.toolCount,
      status: projectGrantListStatus(row.grantStatus, row.connectorStatus),
    }))
    const offset = (safePage - 1) * safePageSize
    return {
      list: list.slice(offset, offset + safePageSize),
      total: list.length,
      page: safePage,
      pageSize: safePageSize,
    }
  }

  async beginAuthorization(input: {
    connectorId: string
    userId: string
    portalOrigin: string
  }): Promise<{ authorizationUrl: string }> {
    const oauth = await this.requireConnectorOAuth(input.connectorId)
    const redirectUri = `${input.portalOrigin.replace(/\/$/, '')}/api/workbench/v1/mcp-grants/callback`
    const { verifier, challenge } = createPkce()
    const state = randomBytes(24).toString('base64url')
    const transactionId = `mcp-oauth-tx-${randomUUID()}`
    const sealed = this.userCredentials.seal({
      tenantId,
      credentialRefId: transactionId,
      userId: input.userId,
      tokens: { accessToken: verifier, refreshToken: null, accessExpiresAt: null },
    })
    const expiresAt = new Date(Date.now() + TRANSACTION_TTL_MS)
    await this.database`
      insert into mcp_oauth_transactions (
        id, tenant_id, user_id, connector_id, state_hash,
        code_verifier_ciphertext, code_verifier_nonce, code_verifier_auth_tag,
        redirect_uri, expires_at
      ) values (
        ${transactionId}, ${tenantId}, ${input.userId}, ${input.connectorId},
        ${hashState(state)},
        ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.authTag},
        ${redirectUri}, ${expiresAt}
      )
    `
    const url = authorizationUrl({
      authorizationEndpoint: oauth.authorizationEndpoint,
      clientId: oauth.clientId,
      redirectUri,
      scopes: oauth.scopes,
      resource: oauth.resource,
      state,
      codeChallenge: challenge,
    })
    return { authorizationUrl: url.toString() }
  }

  async beginProbe(input: {
    registration: McpOAuthProbeRegistrationInput
    userId: string
    portalOrigin: string
    clientSecret?: string
  }): Promise<{ authorizationUrl: string }> {
    const fingerprint = probeFingerprint(input.registration, input.clientSecret)
    probeRegistrationCache.set(fingerprint, { ...input.registration, clientSecret: input.clientSecret })
    const redirectUri = `${input.portalOrigin.replace(/\/$/, '')}/api/workbench/v1/mcp-grants/callback`
    const { verifier, challenge } = createPkce()
    const state = randomBytes(24).toString('base64url')
    const transactionId = `mcp-oauth-probe-${randomUUID()}`
    const sealed = this.userCredentials.seal({
      tenantId,
      credentialRefId: transactionId,
      userId: input.userId,
      tokens: { accessToken: verifier, refreshToken: null, accessExpiresAt: null },
    })
    const expiresAt = new Date(Date.now() + TRANSACTION_TTL_MS)
    await this.database`
      insert into mcp_oauth_transactions (
        id, tenant_id, user_id, probe_fingerprint, state_hash,
        code_verifier_ciphertext, code_verifier_nonce, code_verifier_auth_tag,
        redirect_uri, expires_at
      ) values (
        ${transactionId}, ${tenantId}, ${input.userId}, ${fingerprint},
        ${hashState(state)},
        ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.authTag},
        ${redirectUri}, ${expiresAt}
      )
    `
    const resource = input.registration.resource?.trim() || normalizeHttpsEndpoint(input.registration.endpoint)
    const url = authorizationUrl({
      authorizationEndpoint: input.registration.authorizationEndpoint,
      clientId: input.registration.clientId,
      redirectUri,
      scopes: input.registration.scopes,
      resource,
      state,
      codeChallenge: challenge,
    })
    return { authorizationUrl: url.toString() }
  }

  async completeAuthorization(input: {
    code: string
    state: string
    userId: string
  }): Promise<void> {
    const stateHash = hashState(input.state)
    const [transaction] = await this.database<{
      id: string
      userId: string
      connectorId: string | null
      probeFingerprint: string | null
      redirectUri: string
      expiresAt: Date
      consumedAt: Date | null
      verifierCipher: Buffer
      verifierNonce: Buffer
      verifierTag: Buffer
    }[]>`
      select id, user_id as "userId", connector_id as "connectorId",
             probe_fingerprint as "probeFingerprint", redirect_uri as "redirectUri",
             expires_at as "expiresAt", consumed_at as "consumedAt",
             code_verifier_ciphertext as "verifierCipher",
             code_verifier_nonce as "verifierNonce",
             code_verifier_auth_tag as "verifierTag"
        from mcp_oauth_transactions
       where tenant_id = ${tenantId} and state_hash = ${stateHash}
       for update
    `
    if (!transaction) throw invalidRequest('OAuth 状态无效或已过期')
    if (transaction.consumedAt) throw invalidRequest('OAuth 状态已被使用')
    if (transaction.expiresAt.getTime() <= Date.now()) throw invalidRequest('OAuth 状态已过期')
    if (transaction.userId !== input.userId) throw invalidRequest('OAuth 会话用户不匹配')

    const verifierPair = this.userCredentials.open({
      tenantId,
      credentialRefId: transaction.id,
      userId: input.userId,
      ciphertext: transaction.verifierCipher,
      nonce: transaction.verifierNonce,
      authTag: transaction.verifierTag,
      keyId: this.userCredentials.currentKeyId(),
    })

    if (transaction.probeFingerprint) {
      const tokens = await this.exchangeProbeCode(transaction, verifierPair.accessToken, input.code)
      await this.database.begin(async tx => {
        await tx`
          update mcp_oauth_transactions set consumed_at = now() where id = ${transaction.id}
        `
        const sealed = this.userCredentials.seal({
          tenantId,
          credentialRefId: transaction.id,
          userId: input.userId,
          tokens,
        })
        await tx`
          insert into mcp_oauth_probe_secrets (
            transaction_id, ciphertext, nonce, auth_tag, key_id, expires_at
          ) values (
            ${transaction.id}, ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.authTag},
            ${sealed.keyId}, ${transaction.expiresAt}
          )
          on conflict (transaction_id) do update
            set ciphertext = excluded.ciphertext, nonce = excluded.nonce,
                auth_tag = excluded.auth_tag, key_id = excluded.key_id,
                expires_at = excluded.expires_at
        `
      })
      return
    }

    if (!transaction.connectorId) throw invalidRequest('OAuth 交易缺少连接器')
    const oauth = await this.requireConnectorOAuth(transaction.connectorId)
    const clientSecret = await this.readClientSecret(oauth.clientSecretCredentialRefId)
    const exchanged = await exchangeAuthorizationCode({
      tokenEndpoint: oauth.tokenEndpoint,
      clientId: oauth.clientId,
      clientSecret,
      code: input.code,
      codeVerifier: verifierPair.accessToken,
      redirectUri: transaction.redirectUri,
      resource: oauth.resource,
      fetchImpl: this.fetchImpl,
    })
    await this.database.begin(async tx => {
      await tx`
        update mcp_oauth_transactions set consumed_at = now() where id = ${transaction.id}
      `
      await this.upsertUserGrant(tx, {
        connectorId: transaction.connectorId!,
        userId: input.userId,
        tokens: {
          accessToken: exchanged.accessToken,
          refreshToken: exchanged.refreshToken,
          accessExpiresAt: exchanged.expiresAt,
        },
      })
    })
  }

  async revoke(userId: string, connectorId: string): Promise<{ id: string; deleted: boolean }> {
    await this.database.begin(async tx => {
      const [grant] = await tx<{ credentialRefId: string }[]>`
        select credential_ref_id as "credentialRefId"
          from mcp_user_grants
         where tenant_id = ${tenantId} and connector_id = ${connectorId} and user_id = ${userId}
         for update
      `
      if (!grant) return
      await tx`delete from mcp_user_credential_secrets where tenant_id = ${tenantId} and credential_ref_id = ${grant.credentialRefId}`
      await tx`delete from mcp_user_grants where tenant_id = ${tenantId} and connector_id = ${connectorId} and user_id = ${userId}`
    })
    return { id: connectorId, deleted: true }
  }

  async applyToPins(
    pins: McpConnectionSnapshot[],
    scopeMode: 'all' | 'selected' | 'none',
    subjectUserId: string | null,
    options: { preview?: boolean } = {},
  ): Promise<McpUserGrantApplyResult> {
    if (scopeMode === 'none') {
      return { pins: [], omitted: [], blocked: [] }
    }
    const preview = options.preview === true
    const result: McpConnectionSnapshot[] = []
    const omitted: Array<{ connectorId: string; name: string }> = []
    const blocked: Array<{ connectorId: string; name: string }> = []

    for (const pin of pins) {
      if (pin.auth_type !== 'user_oauth') {
        result.push(pin)
        continue
      }
      const connectorName = await this.connectorDisplayName(pin.connector_id)
      const grant = subjectUserId
        ? await this.loadActiveGrant(pin.connector_id, subjectUserId)
        : null
      if (!grant || grant.status !== 'active') {
        const item = { connectorId: pin.connector_id, name: connectorName }
        if (scopeMode === 'selected') {
          if (preview) blocked.push(item)
          else throw authorizationDenied(`需要完成 MCP 连接器「${connectorName}」的个人授权后才能继续`)
        } else {
          omitted.push(item)
        }
        continue
      }
      try {
        const resolved = await this.materializeUserOauthPin(pin, subjectUserId!, grant)
        result.push(resolved)
      } catch {
        const item = { connectorId: pin.connector_id, name: connectorName }
        if (scopeMode === 'selected') {
          if (preview) blocked.push(item)
          else throw authorizationDenied(`需要完成 MCP 连接器「${connectorName}」的个人授权后才能继续`)
        } else {
          omitted.push(item)
        }
      }
    }
    return { pins: result, omitted, blocked }
  }

  async resolveAccessTokenForPin(pin: McpConnectionSnapshot): Promise<string> {
    if (pin.auth_type !== 'user_oauth' || !pin.grant_subject_id) {
      throw authorizationDenied('MCP 用户授权主体缺失')
    }
    const grant = await this.loadActiveGrant(pin.connector_id, pin.grant_subject_id)
    if (!grant || grant.status !== 'active' || grant.credentialVersion !== pin.credential_version) {
      throw authorizationDenied(`MCP Connector 用户授权已失效：${pin.connector_id}`)
    }
    const tokens = await this.readUserTokens(grant.credentialRefId, pin.grant_subject_id)
    return tokens.accessToken
  }

  async assertGrantMatchesPin(pin: McpConnectionSnapshot): Promise<void> {
    if (pin.auth_type !== 'user_oauth') return
    if (!pin.grant_subject_id || !Number.isInteger(pin.credential_version)) {
      throw authorizationDenied(`MCP Connector 用户授权快照不完整：${pin.connector_id}`)
    }
    const grant = await this.loadActiveGrant(pin.connector_id, pin.grant_subject_id)
    if (!grant || grant.status !== 'active' || grant.credentialVersion !== pin.credential_version) {
      throw authorizationDenied(`固定的 MCP Connector 已停用、删除或能力摘要已变化：${pin.connector_id}`)
    }
  }

  async readProbeAccessToken(
    userId: string,
    registration: McpOAuthProbeRegistrationInput,
    clientSecret?: string,
  ): Promise<string | null> {
    const fingerprint = probeFingerprint(registration, clientSecret)
    const [row] = await this.database<{
      transactionId: string
      expiresAt: Date
      ciphertext: Buffer
      nonce: Buffer
      authTag: Buffer
      keyId: string
    }[]>`
      select t.id as "transactionId", t.expires_at as "expiresAt",
             s.ciphertext, s.nonce, s.auth_tag as "authTag", s.key_id as "keyId"
        from mcp_oauth_transactions t
        join mcp_oauth_probe_secrets s on s.transaction_id = t.id
       where t.tenant_id = ${tenantId} and t.user_id = ${userId}
         and t.probe_fingerprint = ${fingerprint} and t.consumed_at is not null
         and t.expires_at > now()
       order by t.expires_at desc
       limit 1
    `
    if (!row) return null
    const tokens = this.userCredentials.open({
      tenantId,
      credentialRefId: row.transactionId,
      userId,
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      authTag: row.authTag,
      keyId: row.keyId,
    })
    return tokens.accessToken
  }

  async adoptProbeGrantOnRegister(input: {
    userId: string
    connectorId: string
    registration: McpOAuthProbeRegistrationInput
    clientSecret?: string
  }): Promise<void> {
    const fingerprint = probeFingerprint(input.registration, input.clientSecret)
    const [row] = await this.database<{
      transactionId: string
      ciphertext: Buffer
      nonce: Buffer
      authTag: Buffer
      keyId: string
      expiresAt: Date
    }[]>`
      select t.id as "transactionId", s.ciphertext, s.nonce, s.auth_tag as "authTag",
             s.key_id as "keyId", t.expires_at as "expiresAt"
        from mcp_oauth_transactions t
        join mcp_oauth_probe_secrets s on s.transaction_id = t.id
       where t.tenant_id = ${tenantId} and t.user_id = ${input.userId}
         and t.probe_fingerprint = ${fingerprint} and t.expires_at > now()
       order by t.expires_at desc
       limit 1
    `
    if (!row) throw stateConflict('探活授权已失效，请重新测试连接')
    const tokens = this.userCredentials.open({
      tenantId,
      credentialRefId: row.transactionId,
      userId: input.userId,
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      authTag: row.authTag,
      keyId: row.keyId,
    })
    await this.database.begin(async tx => {
      await this.upsertUserGrant(tx, {
        connectorId: input.connectorId,
        userId: input.userId,
        tokens,
      })
      await tx`delete from mcp_oauth_probe_secrets where transaction_id = ${row.transactionId}`
      await tx`delete from mcp_oauth_transactions where id = ${row.transactionId}`
    })
  }

  async invalidateProbe(userId: string, fingerprint: string): Promise<void> {
    await this.database`
      delete from mcp_oauth_transactions
       where tenant_id = ${tenantId} and user_id = ${userId} and probe_fingerprint = ${fingerprint}
    `
  }

  private async materializeUserOauthPin(
    pin: McpConnectionSnapshot,
    subjectUserId: string,
    grant: { credentialRefId: string; credentialVersion: number; status: string; accessExpiresAt: Date | null },
  ): Promise<McpConnectionSnapshot> {
    let tokens = await this.readUserTokens(grant.credentialRefId, subjectUserId)
    if (grant.accessExpiresAt && grant.accessExpiresAt.getTime() <= Date.now()) {
      const refreshed = await this.refreshGrantTokens(pin.connector_id, subjectUserId, tokens)
      if (!refreshed) {
        await this.markReauthorizationRequired(pin.connector_id, subjectUserId)
        throw authorizationDenied('用户授权需要重新授权')
      }
      grant = (await this.loadActiveGrant(pin.connector_id, subjectUserId))!
      tokens = refreshed
    }
    return {
      ...pin,
      grant_subject_id: subjectUserId,
      credential_version: grant.credentialVersion,
    }
  }

  private async refreshGrantTokens(
    connectorId: string,
    userId: string,
    current: McpUserTokenPair,
  ): Promise<McpUserTokenPair | null> {
    if (!current.refreshToken) {
      await this.markReauthorizationRequired(connectorId, userId)
      return null
    }
    const oauth = await this.requireConnectorOAuth(connectorId)
    const clientSecret = await this.readClientSecret(oauth.clientSecretCredentialRefId)
    try {
      const exchanged = await exchangeRefreshToken({
        tokenEndpoint: oauth.tokenEndpoint,
        clientId: oauth.clientId,
        clientSecret,
        refreshToken: current.refreshToken,
        resource: oauth.resource,
        authorizationEndpoint: oauth.authorizationEndpoint,
        fetchImpl: this.fetchImpl,
      })
      await this.database.begin(async tx => {
        await this.upsertUserGrant(tx, {
          connectorId,
          userId,
          tokens: {
            accessToken: exchanged.accessToken,
            refreshToken: exchanged.refreshToken ?? current.refreshToken,
            accessExpiresAt: exchanged.expiresAt,
          },
        })
      })
      return {
        accessToken: exchanged.accessToken,
        refreshToken: exchanged.refreshToken ?? current.refreshToken,
        accessExpiresAt: exchanged.expiresAt,
      }
    } catch {
      await this.markReauthorizationRequired(connectorId, userId)
      return null
    }
  }

  private async exchangeProbeCode(
    transaction: { id: string; redirectUri: string; probeFingerprint: string | null },
    codeVerifier: string,
    code: string,
  ): Promise<McpUserTokenPair> {
    const registration = probeRegistrationCache.get(transaction.probeFingerprint!)
    if (!registration) throw invalidRequest('探活登记资料已变化，请重新测试连接')
    const resource = registration.resource?.trim() || normalizeHttpsEndpoint(registration.endpoint)
    const exchanged = await exchangeAuthorizationCode({
      tokenEndpoint: registration.tokenEndpoint,
      clientId: registration.clientId,
      clientSecret: registration.clientSecret,
      code,
      codeVerifier,
      redirectUri: transaction.redirectUri,
      resource,
      fetchImpl: this.fetchImpl,
    })
    return {
      accessToken: exchanged.accessToken,
      refreshToken: exchanged.refreshToken,
      accessExpiresAt: exchanged.expiresAt,
    }
  }

  private async upsertUserGrant(
    tx: DatabaseTransaction,
    input: { connectorId: string; userId: string; tokens: McpUserTokenPair },
  ): Promise<void> {
    const credentialRefId = `mcp-user-grant-${randomUUID()}`
    const [existing] = await tx<{ credentialRefId: string }[]>`
      select credential_ref_id as "credentialRefId"
        from mcp_user_grants
       where tenant_id = ${tenantId} and connector_id = ${input.connectorId} and user_id = ${input.userId}
       for update
    `
    const targetRef = existing?.credentialRefId ?? credentialRefId
    const sealed = this.userCredentials.seal({
      tenantId,
      credentialRefId: targetRef,
      userId: input.userId,
      tokens: input.tokens,
    })
    const [versionRow] = await tx<{ version: number }[]>`
      select version from mcp_user_credential_secrets
       where tenant_id = ${tenantId} and credential_ref_id = ${targetRef}
    `
    const nextVersion = (versionRow?.version ?? 0) + 1
    if (!existing) {
      await tx`
        insert into mcp_user_grants (
          tenant_id, connector_id, user_id, status, credential_ref_id, access_expires_at, updated_at
        ) values (
          ${tenantId}, ${input.connectorId}, ${input.userId}, 'active', ${targetRef},
          ${input.tokens.accessExpiresAt}, now()
        )
      `
    } else {
      await tx`
        update mcp_user_grants
           set status = 'active', access_expires_at = ${input.tokens.accessExpiresAt}, updated_at = now()
         where tenant_id = ${tenantId} and connector_id = ${input.connectorId} and user_id = ${input.userId}
      `
    }
    await tx`
      insert into mcp_user_credential_secrets (
        tenant_id, credential_ref_id, user_id, algorithm, key_id, version,
        ciphertext, nonce, auth_tag
      ) values (
        ${tenantId}, ${targetRef}, ${input.userId}, 'aes-256-gcm', ${sealed.keyId}, ${nextVersion},
        ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.authTag}
      )
      on conflict (tenant_id, credential_ref_id) do update
        set user_id = excluded.user_id, key_id = excluded.key_id, version = excluded.version,
            ciphertext = excluded.ciphertext, nonce = excluded.nonce, auth_tag = excluded.auth_tag
    `
  }

  private async loadActiveGrant(connectorId: string, userId: string) {
    const [row] = await this.database<{
      status: string
      credentialRefId: string
      credentialVersion: number
      accessExpiresAt: Date | null
    }[]>`
      select g.status, g.credential_ref_id as "credentialRefId",
             s.version as "credentialVersion", g.access_expires_at as "accessExpiresAt"
        from mcp_user_grants g
        join mcp_user_credential_secrets s on s.tenant_id = g.tenant_id
          and s.credential_ref_id = g.credential_ref_id
       where g.tenant_id = ${tenantId} and g.connector_id = ${connectorId} and g.user_id = ${userId}
    `
    return row ?? null
  }

  private async readUserTokens(credentialRefId: string, userId: string): Promise<McpUserTokenPair> {
    const [secret] = await this.database<{
      ciphertext: Buffer
      nonce: Buffer
      authTag: Buffer
      keyId: string
    }[]>`
      select ciphertext, nonce, auth_tag as "authTag", key_id as "keyId"
        from mcp_user_credential_secrets
       where tenant_id = ${tenantId} and credential_ref_id = ${credentialRefId}
    `
    if (!secret) throw authorizationDenied('MCP 用户凭据不存在')
    return this.userCredentials.open({
      tenantId,
      credentialRefId,
      userId,
      ciphertext: secret.ciphertext,
      nonce: secret.nonce,
      authTag: secret.authTag,
      keyId: secret.keyId,
    })
  }

  private async requireConnectorOAuth(connectorId: string) {
    const [row] = await this.database<{
      authorizationEndpoint: string
      tokenEndpoint: string
      clientId: string
      clientSecretCredentialRefId: string | null
      scopes: string[]
      resource: string
      status: string
      authType: string
    }[]>`
      select o.authorization_endpoint as "authorizationEndpoint",
             o.token_endpoint as "tokenEndpoint", o.client_id as "clientId",
             o.client_secret_credential_ref_id as "clientSecretCredentialRefId",
             o.scopes, o.resource, c.status, c.auth_type as "authType"
        from mcp_connector_oauth o
        join connectors c on c.tenant_id = o.tenant_id and c.id = o.connector_id
       where o.tenant_id = ${tenantId} and o.connector_id = ${connectorId}
         and c.deleted_at is null
    `
    if (!row || row.authType !== 'user_oauth') throw notFound(`MCP 用户授权连接器不存在：${connectorId}`)
    if (row.status === 'disabled') throw stateConflict('MCP 连接器已停用')
    return row
  }

  private async readClientSecret(credentialRefId: string | null): Promise<string | undefined> {
    if (!credentialRefId || !this.connectorCredentials) return undefined
    return this.connectorCredentials.readBearerToken(tenantId, credentialRefId)
  }

  private async connectorDisplayName(connectorId: string): Promise<string> {
    const [row] = await this.database<{ name: string }[]>`
      select name from connectors where tenant_id = ${tenantId} and id = ${connectorId}
    `
    return row?.name ?? connectorId
  }

  private async markReauthorizationRequired(connectorId: string, userId: string) {
    await this.database`
      update mcp_user_grants
         set status = 'reauthorization_required', updated_at = now()
       where tenant_id = ${tenantId} and connector_id = ${connectorId} and user_id = ${userId}
    `
  }
}

const probeRegistrationCache = new Map<string, McpOAuthProbeRegistrationInput & { clientSecret?: string }>()

export function probeFingerprint(input: McpOAuthProbeRegistrationInput, clientSecret?: string): string {
  const secretHash = clientSecret
    ? createHash('sha256').update(clientSecret, 'utf8').digest('hex')
    : ''
  return createHash('sha256').update(JSON.stringify({
    name: input.name.trim(),
    endpoint: normalizeHttpsEndpoint(input.endpoint),
    authorizationEndpoint: input.authorizationEndpoint.trim(),
    tokenEndpoint: input.tokenEndpoint.trim(),
    clientId: input.clientId.trim(),
    scopes: [...input.scopes].sort(),
    resource: (input.resource?.trim() || normalizeHttpsEndpoint(input.endpoint)),
    clientSecretHash: secretHash,
  }), 'utf8').digest('hex')
}

export function normalizeHttpsEndpoint(endpoint: string): string {
  const url = new URL(endpoint.trim())
  if (url.protocol !== 'https:') throw invalidRequest('MCP 服务地址必须是 HTTPS')
  return url.toString()
}

function hashState(state: string) {
  return createHash('sha256').update(state, 'utf8').digest('hex')
}

function projectGrantListStatus(grantStatus: string | null, connectorStatus: string): McpUserGrantListStatus {
  if (connectorStatus === 'disabled') return 'disabled'
  if (!grantStatus) return 'unauthorized'
  if (grantStatus === 'reauthorization_required') return 'reauthorization_required'
  return 'active'
}
