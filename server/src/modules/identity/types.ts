import type { IncomingMessage } from 'node:http'

import type { UserProfile } from '../../domain/types.ts'

export type ApiAudience = 'workbench' | 'admin'
export type IdentityProvider = 'prototype-sso' | 'ai-hub-oidc'

/** Business permissions are defined and evaluated only by dsh-work. */
export const LOCAL_PERMISSIONS = {
  workbenchUse: 'workbench:use',
  workbenchManage: 'workbench:manage',
  adminAll: 'admin:*',
  adminRead: 'admin:read',
  adminWrite: 'admin:write',
  auditRead: 'audit:read',
} as const

export interface RequestIdentity {
  audience: ApiAudience
  applicationId: string
  sessionHash: string
  userId: string
  subject: string
  profile: UserProfile
  roleIds: string[]
  permissions: string[]
  dataScopes: string[]
  authorizationVersion: number
  identityProvider: IdentityProvider
}

export type ApiAuthenticator = (
  request: IncomingMessage,
  audience: ApiAudience,
) => Promise<RequestIdentity>

export interface OidcAudienceConfiguration {
  audience: ApiAudience
  applicationId: string
  issuer: string
  tokenAudience: string
  clientId: string
  clientSecret: string
  allowedOrigins: string[]
  defaultOrigin: string
  redirectUriByOrigin: Readonly<Record<string, string>>
  sessionCookieName: string
  transactionCookieName: string
  loginScopes: string[]
}

export interface PrototypeIdentityConfiguration {
  mode: 'prototype'
}

export interface OidcIdentityConfiguration {
  /** Explicit fresh-install opt-in. A consumed application/environment claim always closes it. */
  adminBootstrapEnabled?: boolean
  mode: 'oidc'
  platformUrl: string
  applicationId: string
  environment: string
  sessionSecret: string
  sessionTtlSeconds: number
  transactionTtlSeconds: number
  cookieSecure: boolean
  directorySyncIntervalSeconds: number
  jwksCacheTtlSeconds: number
  jwksStaleTtlSeconds: number
  audiences: Record<ApiAudience, OidcAudienceConfiguration>
}

export type IdentityConfiguration = PrototypeIdentityConfiguration | OidcIdentityConfiguration

export interface CurrentPlatformUser {
  user_id: string
  subject: string
  display_name: string
  email: string | null
  status: string
  organization_id: string
  organization_name: string
  business_user: boolean
  authorization_version: number
}

export interface AdminBootstrapClaim {
  application_id: string
  environment: string
  initial_admin_user_id: string
  claimed_user_id: string
  status: 'CONSUMED'
  consumed_at: string
}

export interface DirectoryUser {
  user_id: string
  subject: string
  display_name: string
  email: string | null
  status: string
  organization_id: string
  organization_name: string
  business_user: boolean
  updated_at: string
  tombstone: boolean
}

export interface DirectoryPage {
  items: DirectoryUser[]
  next_cursor: string | null
  has_more: boolean
  synchronized_at: string
}

export interface OAuthTokenResponse {
  accessToken: string
  refreshToken: string | null
  idToken: string | null
  expiresIn: number
  scope: string
}

export interface VerifiedToken {
  subject: string
  issuer: string
  audiences: string[]
  expiresAt: number
  issuedAt: number
  scopes: string[]
  actorType: string | null
  authorizationVersion: number | null
  displayName: string | null
  email: string | null
  claims: Record<string, unknown>
}
