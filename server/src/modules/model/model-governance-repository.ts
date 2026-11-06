import type {
  CreateModelRouteInput,
  CreateProviderInput,
  CreateProviderModelInput,
  ModelProvider,
  ModelRoute,
  ModelRouteSnapshot,
  ProviderStatus,
  SetProviderApiKeyInput,
  SetProviderModelStatusInput,
  UpdateModelRouteInput,
  UpdateProviderInput,
  UpsertCredentialReferenceInput,
} from './model-types.ts'

export interface ModelGovernanceRepository {
  listProviders(tenantId: string): Promise<ModelProvider[]>
  createProvider(tenantId: string, input: CreateProviderInput): Promise<ModelProvider>
  updateProvider(tenantId: string, input: UpdateProviderInput): Promise<ModelProvider>
  setProviderStatus(
    tenantId: string,
    providerId: string,
    status: ProviderStatus,
    actor: string,
  ): Promise<ModelProvider>
  createProviderModel(tenantId: string, input: CreateProviderModelInput): Promise<ModelProvider>
  setProviderModelStatus(tenantId: string, input: SetProviderModelStatusInput): Promise<ModelProvider>
  /** 录入或轮换平台加密保存的厂商密钥（backend = postgres-encrypted）。 */
  setProviderApiKey(tenantId: string, input: SetProviderApiKeyInput): Promise<ModelProvider>
  upsertCredentialReference(
    tenantId: string,
    input: UpsertCredentialReferenceInput,
  ): Promise<ModelProvider>
  listRoutes(tenantId: string): Promise<ModelRoute[]>
  createRoute(tenantId: string, input: CreateModelRouteInput): Promise<ModelRoute>
  updateRoute(tenantId: string, input: UpdateModelRouteInput): Promise<ModelRoute>
  /** 解析当前启用的默认路由（按用途，不按路由标识；模型路由方案 4.8）。 */
  resolveDefaultRoute(tenantId: string): Promise<ModelRouteSnapshot>
}
