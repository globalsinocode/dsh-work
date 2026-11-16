import type { IncomingMessage } from 'node:http'

import type { UserProfile } from '../../domain/types.ts'

export type ApiAudience = 'workbench' | 'admin'
export type IdentityProvider = 'prototype-sso' | 'local-password' | 'dingtalk'

/** Business permissions are defined and evaluated only by dsh-work. */
export const LOCAL_PERMISSIONS = {
  workbenchUse: 'workbench:use',
  workbenchManage: 'workbench:manage',
  adminAll: 'admin:*',
  adminRead: 'admin:read',
  adminWrite: 'admin:write',
  auditRead: 'audit:read',
  dataProtectionTerms: 'data-protection:terms',
  knowledgeView: 'knowledge:view',
  knowledgeDocs: 'knowledge:docs',
  knowledgeBases: 'knowledge:bases',
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

export interface LocalAudienceConfiguration {
  audience: ApiAudience
  applicationId: string
  allowedOrigins: string[]
  defaultOrigin: string
  sessionCookieName: string
}

export interface LocalIdentityConfiguration {
  mode: 'local'
  /** 已不再读取的旧配置变量名（如 AI_HUB_*），启动时只记警告；从不出现在公开登录接口中。 */
  ignoredLegacySettings?: string[]
  sessionSecret: string
  sessionTtlSeconds: number
  cookieSecure: boolean
  audiences: Record<ApiAudience, LocalAudienceConfiguration>
}

export type IdentityConfiguration = LocalIdentityConfiguration
