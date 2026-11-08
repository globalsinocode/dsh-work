import type {
  CreateModelRouteInput,
  CreateProviderInput,
  CreateProviderModelInput,
  DeleteProviderModelInput,
  UpdateProviderModelCapabilitiesInput,
  ModelProvider,
  ModelRoute,
  ModelRouteSnapshot,
  ProviderStatus,
  SetProviderApiKeyInput,
  SetProviderModelStatusInput,
  UpdateModelRouteInput,
  UpdateProviderInput,
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
  /** 删除未被任何模型路由引用的模型；被引用时拒绝并列出路由名。 */
  deleteProviderModel(tenantId: string, input: DeleteProviderModelInput): Promise<ModelProvider>
  /** 修改模型能力标签；只影响之后解析的路由快照，已开始的运行不变。 */
  updateProviderModelCapabilities(tenantId: string, input: UpdateProviderModelCapabilitiesInput): Promise<ModelProvider>
  /** 录入或轮换平台加密保存的厂商密钥（backend = postgres-encrypted）。 */
  setProviderApiKey(tenantId: string, input: SetProviderApiKeyInput): Promise<ModelProvider>
  listRoutes(tenantId: string): Promise<ModelRoute[]>
  createRoute(tenantId: string, input: CreateModelRouteInput): Promise<ModelRoute>
  updateRoute(tenantId: string, input: UpdateModelRouteInput): Promise<ModelRoute>
  /** 解析当前启用的默认路由（按用途，不按路由标识；模型路由方案 4.8）。 */
  resolveDefaultRoute(tenantId: string): Promise<ModelRouteSnapshot>
}
