import { createHash } from 'node:crypto'

/**
 * 工具绑定修订契约（B-03 / I-04）：平台批准的连接、凭据槽位、执行身份策略、
 * 数据范围与环境的语义快照。任一字段变化产生新修订；凭据槽位标识入摘要，
 * 槽位背后的密钥值轮换不进入绑定语义（等价轮换不产生新修订）。
 */
export interface ToolBindingSnapshot {
  toolId: string
  toolVersion: string
  connectorId: string
  executor: string
  endpoint: string
  credentialRef: string | null
  identityPolicy: string
  environment: string
  allowedRoleIds: string[]
  dataScopes: string[]
  approvalPolicy: string
}

export function toolBindingDigest(snapshot: ToolBindingSnapshot): string {
  return createHash('sha256').update(JSON.stringify({
    toolId: snapshot.toolId,
    toolVersion: snapshot.toolVersion,
    connectorId: snapshot.connectorId,
    executor: snapshot.executor,
    endpoint: snapshot.endpoint,
    credentialRef: snapshot.credentialRef,
    identityPolicy: snapshot.identityPolicy,
    environment: snapshot.environment,
    allowedRoleIds: [...snapshot.allowedRoleIds].sort(),
    dataScopes: [...snapshot.dataScopes].sort(),
    approvalPolicy: snapshot.approvalPolicy,
  })).digest('hex')
}

/** 已解析的绑定修订：发布计划、版本绑定依据与管理端展示的公共形态。 */
export interface ResolvedToolBinding {
  tool: string
  bindingId: string
  revision: number
  digest: string
  connectorId: string
  executor: string
  endpoint: string
  credentialRef: string | null
  identityPolicy: string
  environment: string
  approvalPolicy: string
  status: 'active' | 'superseded' | 'revoked'
  sealedAt: string
}

/** Attempt Manifest 固定的绑定引用：执行时按此复核当前绑定是否仍然有效。 */
export interface ManifestToolBinding {
  tool: string
  binding_id: string
  revision: number
  digest: string
}

export function toManifestToolBinding(binding: ResolvedToolBinding): ManifestToolBinding {
  return {
    tool: binding.tool,
    binding_id: binding.bindingId,
    revision: binding.revision,
    digest: binding.digest,
  }
}

/** 绑定依据集合的规范化比较键：发布门禁据此判定封存后绑定是否漂移。 */
export function bindingBasisKey(pins: readonly ManifestToolBinding[]): string {
  return JSON.stringify(
    [...pins]
      .map(pin => ({ tool: pin.tool, binding_id: pin.binding_id, revision: pin.revision, digest: pin.digest }))
      .sort((left, right) => left.tool.localeCompare(right.tool)),
  )
}
