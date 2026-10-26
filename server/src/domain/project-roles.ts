/**
 * 项目空间成员角色与固定权限集合。路由与两个工作台服务共用，避免多处各写一份后漂移。
 * 具体业务规则见 docs/development/feature-rules.md 第 3 节。
 */
export type ProjectTeamRole = 'owner' | 'admin' | 'member' | 'viewer'

/** 可读：全部现任成员（含只读成员）。 */
export const projectAllRoles: ProjectTeamRole[] = ['owner', 'admin', 'member', 'viewer']

/** 可写：非只读成员。 */
export const projectWriterRoles: ProjectTeamRole[] = ['owner', 'admin', 'member']

/** 治理：负责人与管理员（成员、Agent 名册、简报等）。 */
export const projectGovernanceRoles: ProjectTeamRole[] = ['owner', 'admin']

/** 仅负责人（转交、归档、添加/移出 Agent 等）。 */
export const projectOwnerRoles: ProjectTeamRole[] = ['owner']
