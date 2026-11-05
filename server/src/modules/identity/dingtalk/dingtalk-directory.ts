/**
 * 钉钉开放平台的内部端口（钉钉接入方案 4.2、4.3、8.1）。身份与绑定只依赖这个端口：生产实现为
 * `DingTalkOpenApiDirectory`，测试替身只用于测试与 P0 冒烟服务，不作为生产备用实现。
 */
export interface DingTalkMember {
  /** 钉钉 `userid`（企业内唯一）。 */
  userId: string
  unionId: string | null
  name: string | null
}

export interface DingTalkAuthCodeIdentity extends DingTalkMember {
  /**
   * 授权码所属企业。`topapi/v2/user/getuserinfo` 不返回企业 ID：授权码只能用本企业应用的 access_token
   * 换取，换取成功即证明属于本企业；生产实现在换取成功时填入配置的 `corpId`，非本企业的授权码在换取时失败
   * （`DingTalkDirectoryError` code `auth_code_invalid`）。服务层仍核对该字段，防止实现错误放过他企业身份。
   */
  corpId: string
}

export interface DingTalkMemberDetail extends DingTalkMember {
  departmentIds: number[]
}

export type DingTalkDirectoryErrorCode =
  /** 授权码无效、过期、已使用或不属于本企业应用。 */
  | 'auth_code_invalid'
  /** 明确返回“用户不存在”（离职检查只把它当作离职）。 */
  | 'member_not_found'
  /** 无效手机号。 */
  | 'invalid_mobile'
  /** 部门不存在。 */
  | 'department_not_found'
  /** 应用缺少权限或成员不在通讯录范围内：属于配置异常，不计入单个员工的检查失败。 */
  | 'permission_denied'
  /** 凭据错误、出口 IP 未登记等应用配置问题。 */
  | 'configuration_invalid'
  /** 限流、超时、系统繁忙等可重试错误。 */
  | 'unavailable'

export class DingTalkDirectoryError extends Error {
  readonly code: DingTalkDirectoryErrorCode
  readonly upstreamCode: number | null

  constructor(code: DingTalkDirectoryErrorCode, message: string, upstreamCode: number | null = null) {
    super(message)
    this.name = 'DingTalkDirectoryError'
    this.code = code
    this.upstreamCode = upstreamCode
  }
}

export interface DingTalkDirectory {
  readonly corpId: string
  /** 免登：一次性授权码换钉钉身份。不缓存、不重放。 */
  exchangeAuthCode(authCode: string): Promise<DingTalkAuthCodeIdentity>
  /** 管理员代绑：按手机号查成员 `userid`（只能查到在职员工）。 */
  findUserIdByMobile(mobile: string): Promise<string>
  /** 代绑预览与离职检查：按 `userid` 查成员详情。 */
  getMember(userId: string): Promise<DingTalkMemberDetail>
  /** 部门 ID 转名称（代绑预览显示）。根部门返回企业名称。 */
  getDepartmentName(departmentId: number): Promise<string>
  /** “钉钉集成”页的连接检查：凭据能否换取 access_token。 */
  checkCredentials(): Promise<void>
}

/** 没有配置钉钉应用时的端口：所有调用明确报告不可用，不降级。 */
export class UnconfiguredDingTalkDirectory implements DingTalkDirectory {
  readonly corpId = ''
  private fail(): never {
    throw new DingTalkDirectoryError('configuration_invalid', '钉钉应用未配置')
  }
  async exchangeAuthCode(): Promise<DingTalkAuthCodeIdentity> { this.fail() }
  async findUserIdByMobile(): Promise<string> { this.fail() }
  async getMember(): Promise<DingTalkMemberDetail> { this.fail() }
  async getDepartmentName(): Promise<string> { this.fail() }
  async checkCredentials(): Promise<void> { this.fail() }
}
