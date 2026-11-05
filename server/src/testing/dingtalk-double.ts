import {
  DingTalkDirectoryError, type DingTalkAuthCodeIdentity, type DingTalkDirectory, type DingTalkMemberDetail,
} from '../modules/identity/dingtalk/dingtalk-directory.ts'

interface MemberFixture {
  userId: string
  name: string
  unionId?: string
  mobile?: string
  departmentIds?: number[]
}

/**
 * 钉钉开放平台测试替身：只用于测试与 P0 冒烟服务，不得在生产启动中接线（钉钉接入方案第 5 节）。
 * 授权码一次性；`issueForeignCode` 模拟其他企业应用的授权码（真实钉钉在换取时失败）。
 */
export class DingTalkDirectoryDouble implements DingTalkDirectory {
  readonly corpId: string
  private readonly members = new Map<string, MemberFixture>()
  private readonly departments = new Map<number, string>()
  private readonly codes = new Map<string, { userId: string; corpId: string }>()
  private sequence = 0
  /** 设置后所有调用抛出该错误（模拟限流、权限或凭据问题）。 */
  failure: DingTalkDirectoryError | null = null
  /** 按 userid 指定成员查询的错误（离职检查用）。 */
  readonly memberErrors = new Map<string, DingTalkDirectoryError>()
  readonly calls: string[] = []

  constructor(corpId = 'ding-corp-test') {
    this.corpId = corpId
  }

  addMember(member: MemberFixture) {
    this.members.set(member.userId, member)
    return this
  }

  removeMember(userId: string) {
    this.members.delete(userId)
  }

  addDepartment(id: number, name: string) {
    this.departments.set(id, name)
    return this
  }

  issueAuthCode(userId: string) {
    const code = `code-${++this.sequence}-${userId.replace(/[^A-Za-z0-9_-]/g, '')}`
    this.codes.set(code, { userId, corpId: this.corpId })
    return code
  }

  /** 非本企业应用的授权码：生产实现中换取失败，这里同样换取失败。 */
  issueForeignCode(userId: string) {
    const code = `foreign-${++this.sequence}`
    this.codes.set(code, { userId, corpId: 'ding-corp-other' })
    return code
  }

  async exchangeAuthCode(authCode: string): Promise<DingTalkAuthCodeIdentity> {
    this.calls.push('exchangeAuthCode')
    this.throwIfFailing()
    const issued = this.codes.get(authCode)
    this.codes.delete(authCode)
    if (!issued || issued.corpId !== this.corpId) throw new DingTalkDirectoryError('auth_code_invalid', '授权码无效', 40078)
    const member = this.members.get(issued.userId)
    return { userId: issued.userId, unionId: member?.unionId ?? null, name: member?.name ?? null, corpId: issued.corpId }
  }

  async findUserIdByMobile(mobile: string) {
    this.calls.push('findUserIdByMobile')
    this.throwIfFailing()
    if (!/^\+?\d{6,20}$/.test(mobile)) throw new DingTalkDirectoryError('invalid_mobile', '手机号格式无效', 40104)
    const member = [...this.members.values()].find(item => item.mobile === mobile)
    if (!member) throw new DingTalkDirectoryError('member_not_found', '企业钉钉中没有找到这个手机号', 60121)
    return member.userId
  }

  async getMember(userId: string): Promise<DingTalkMemberDetail> {
    this.calls.push('getMember')
    this.throwIfFailing()
    const error = this.memberErrors.get(userId)
    if (error) throw error
    const member = this.members.get(userId)
    if (!member) throw new DingTalkDirectoryError('member_not_found', '钉钉成员不存在', 33012)
    return { userId, unionId: member.unionId ?? null, name: member.name, departmentIds: member.departmentIds ?? [] }
  }

  async getDepartmentName(departmentId: number) {
    this.calls.push('getDepartmentName')
    this.throwIfFailing()
    const name = this.departments.get(departmentId)
    if (!name) throw new DingTalkDirectoryError('department_not_found', '钉钉部门不存在', 60003)
    return name
  }

  async checkCredentials() {
    this.calls.push('checkCredentials')
    this.throwIfFailing()
  }

  private throwIfFailing() {
    if (this.failure) throw this.failure
  }
}
