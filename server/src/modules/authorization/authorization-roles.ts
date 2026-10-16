/**
 * 平台治理角色与「部署面 / 使用面」分离的判定。
 *
 * 持有平台治理角色的用户负责平台级配置与 Agent 生命周期，因此可以**部署**任何已发布
 * 且开放加入的 Agent（把它加进自己负责的团队空间），不参与
 * `agent_versions.visible_role_ids` 的「哪些员工能看到/使用」判定。
 *
 * 这是部署面的豁免，不是使用面：成员真正执行时仍由 `authorizeRuntimeDecision` 的
 * 可见性校验与 Agent 独立执行身份的授权共同约束，数据边界不因此放宽。
 *
 * 不加这个豁免会形成死锁：空间负责人通常是平台管理员，而被创建出来面向普通员工的
 * Agent 可见角色只含 `role-employee`，交集为空后连候选都搜不到；管理端又没有把
 * Agent 加入空间的端点，当创建者与空间负责人是同一人时无人能代为部署。
 */
export const PLATFORM_GOVERNANCE_ROLE_ID = 'role-platform-admin'

/** 是否持有平台治理角色（按调用方传入的当前有效角色集合判定）。 */
export function isPlatformGovernance(roleIds: readonly string[]): boolean {
  return roleIds.includes(PLATFORM_GOVERNANCE_ROLE_ID)
}
