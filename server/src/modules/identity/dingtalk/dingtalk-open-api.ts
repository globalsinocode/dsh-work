import { DingTalkDirectoryError, type DingTalkDirectory, type DingTalkAuthCodeIdentity, type DingTalkMemberDetail } from './dingtalk-directory.ts'
import type { DingTalkConfiguration } from './dingtalk-config.ts'

interface DingTalkResponse<T> {
  errcode?: number
  errmsg?: string
  result?: T
  access_token?: string
  expires_in?: number
}

/** 可重试：系统繁忙、限流、并发过高。 */
const retryableCodes = new Set([-1, 88, 90002, 90006, 90018])
/** 权限不足或成员不在通讯录范围内。 */
const permissionCodes = new Set([60011, 60020, 50002, 50004])
/** access_token 失效：刷新一次后重试。 */
const tokenCodes = new Set([40001, 40014, 42001, 40089])

/**
 * 钉钉开放平台（旧版服务端 API，oapi.dingtalk.com）实现。接口与错误码以 2026-11-04/05 读取的官方文档为准
 * （钉钉接入方案 8.1）；实际错误码在 P2 真实环境确认后回写方案。
 */
export class DingTalkOpenApiDirectory implements DingTalkDirectory {
  readonly corpId: string
  private readonly configuration: DingTalkConfiguration
  private readonly fetcher: typeof fetch
  private token: { value: string; expiresAt: number } | null = null
  private pendingToken: Promise<string> | null = null

  constructor(configuration: DingTalkConfiguration, fetcher: typeof fetch = fetch) {
    this.configuration = configuration
    this.corpId = configuration.corpId
    this.fetcher = fetcher
  }

  async exchangeAuthCode(authCode: string): Promise<DingTalkAuthCodeIdentity> {
    const result = await this.call<{ userid?: string; unionid?: string; name?: string }>('/topapi/v2/user/getuserinfo', { code: authCode }, code => {
      // 授权码无效、过期、已使用或属于其他企业应用时，钉钉返回非零错误码（如 40078）。
      // 限流、权限与凭据问题交给通用分类：它们是配置或可用性问题，不能报成“授权码无效”。
      if (retryableCodes.has(code) || permissionCodes.has(code) || tokenCodes.has(code)) return null
      return new DingTalkDirectoryError('auth_code_invalid', '钉钉授权码无效或已过期', code)
    })
    if (!result.userid) throw new DingTalkDirectoryError('auth_code_invalid', '钉钉授权码未返回成员身份')
    // 授权码只能用本企业应用的 access_token 换取，换取成功即属于本企业（见端口说明）。
    return { userId: result.userid, unionId: result.unionid || null, name: result.name || null, corpId: this.configuration.corpId }
  }

  async findUserIdByMobile(mobile: string) {
    const result = await this.call<{ userid?: string }>('/topapi/v2/user/getbymobile', { mobile }, code => {
      if (code === 60121) return new DingTalkDirectoryError('member_not_found', '企业钉钉中没有找到这个手机号', code)
      if (code === 40104) return new DingTalkDirectoryError('invalid_mobile', '手机号格式无效', code)
      return null
    })
    if (!result.userid) throw new DingTalkDirectoryError('member_not_found', '企业钉钉中没有找到这个手机号')
    return result.userid
  }

  async getMember(userId: string): Promise<DingTalkMemberDetail> {
    const result = await this.call<{ userid?: string; unionid?: string; name?: string; dept_id_list?: number[] }>('/topapi/v2/user/get', { userid: userId, language: 'zh_CN' }, code => {
      // 离职检查只把“明确不存在”当作离职（8.1）：33012 无效的 userId、60121 找不到该用户。
      if (code === 33012 || code === 60121) return new DingTalkDirectoryError('member_not_found', '钉钉成员不存在', code)
      return null
    })
    return {
      userId: result.userid ?? userId,
      unionId: result.unionid || null,
      name: result.name || null,
      departmentIds: Array.isArray(result.dept_id_list) ? result.dept_id_list.filter(id => Number.isInteger(id)) : [],
    }
  }

  async getDepartmentName(departmentId: number) {
    const result = await this.call<{ name?: string }>('/topapi/v2/department/get', { dept_id: departmentId, language: 'zh_CN' }, code => {
      if (code === 60003) return new DingTalkDirectoryError('department_not_found', '钉钉部门不存在', code)
      return null
    })
    if (!result.name) throw new DingTalkDirectoryError('department_not_found', '钉钉部门没有名称')
    return result.name
  }

  async checkCredentials() {
    this.token = null
    await this.accessToken()
  }

  private async call<T>(path: string, body: Record<string, unknown>, mapError: (code: number) => DingTalkDirectoryError | null, retried = false): Promise<T> {
    const token = await this.accessToken()
    const url = new URL(path, this.configuration.apiBaseUrl)
    url.searchParams.set('access_token', token)
    const payload = await this.request<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const code = payload.errcode ?? 0
    if (code === 0) return (payload.result ?? {}) as T
    if (tokenCodes.has(code) && !retried) {
      this.token = null
      return this.call(path, body, mapError, true)
    }
    const mapped = mapError(code)
    if (mapped) throw mapped
    throw classify(code, payload.errmsg)
  }

  private async accessToken() {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value
    this.pendingToken ??= (async () => {
      const url = new URL('/gettoken', this.configuration.apiBaseUrl)
      url.searchParams.set('appkey', this.configuration.appKey)
      url.searchParams.set('appsecret', this.configuration.appSecret)
      const payload = await this.request<never>(url, { method: 'GET' })
      if ((payload.errcode ?? 0) !== 0 || !payload.access_token) {
        const code = payload.errcode ?? null
        throw code !== null && retryableCodes.has(code)
          ? new DingTalkDirectoryError('unavailable', '钉钉暂时不可用，请稍后重试', code)
          : new DingTalkDirectoryError('configuration_invalid', '钉钉应用凭据无效或服务器出口 IP 未登记', code)
      }
      // 提前 5 分钟刷新（官方有效期 7200 秒）。
      const lifetime = Math.max(60, (payload.expires_in ?? 7200) - 300)
      this.token = { value: payload.access_token, expiresAt: Date.now() + lifetime * 1000 }
      return payload.access_token
    })().finally(() => { this.pendingToken = null })
    return this.pendingToken
  }

  private async request<T>(url: URL, init: RequestInit): Promise<DingTalkResponse<T>> {
    let response: Response
    try {
      response = await this.fetcher(url, { ...init, signal: AbortSignal.timeout(this.configuration.timeoutMs) })
    } catch {
      throw new DingTalkDirectoryError('unavailable', '无法连接钉钉开放平台')
    }
    if (!response.ok) throw new DingTalkDirectoryError('unavailable', `钉钉开放平台返回 HTTP ${response.status}`)
    try {
      return await response.json() as DingTalkResponse<T>
    } catch {
      throw new DingTalkDirectoryError('unavailable', '钉钉开放平台返回了无法解析的响应')
    }
  }
}

function classify(code: number, message: string | undefined) {
  if (retryableCodes.has(code)) return new DingTalkDirectoryError('unavailable', '钉钉暂时不可用，请稍后重试', code)
  if (permissionCodes.has(code)) return new DingTalkDirectoryError('permission_denied', '钉钉应用缺少接口权限或成员不在通讯录范围内', code)
  return new DingTalkDirectoryError('unavailable', `钉钉接口返回错误 ${code}${message ? `：${message.slice(0, 120)}` : ''}`, code)
}
