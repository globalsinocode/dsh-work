/**
 * 团队动态（TW-08 / design §2.9）的展示文案。
 *
 * 服务端 `GET /workspaces/:id/activity` 只返回 `kind` + `actorDisplayName` +
 * `safeMetadata`（id／角色／版本号白名单），**从不返回名称**。因此这里只根据
 * kind 与白名单字段生成文案，绝不把 `objectId` 当名称渲染；文件类动态的名称
 * 由宿主从「成员本来就能读」的文件列表解析后以 `fileName` 传入，解析不到时
 * 使用「一个文件」这类中性占位。
 */

/** 与服务端 migration 0026／0088 CHECK 约束一致的闭合集合。 */
export type WorkspaceActivityKind =
  | 'member_added'
  | 'member_removed'
  | 'member_exit'
  | 'role_changed'
  | 'owner_transferred'
  | 'agent_member_added'
  | 'agent_member_removed'
  | 'file_uploaded'
  | 'file_removed'
  | 'file_version_added'
  | 'workspace_archived'
  | 'workspace_restored'
  | 'brief_updated'
  | 'project_task_created'
  | 'project_task_completed'

export interface WorkspaceActivityDescriptor {
  kind: WorkspaceActivityKind
  actorDisplayName: string
  /** safeMetadata：仅含 id／角色／版本号，不携带名称与正文。 */
  safeMetadata?: Record<string, unknown> | null
  /** 宿主从文件列表解析出的文件名；解析不到时省略。 */
  fileName?: string
}

const ROLE_LABELS: Record<string, string> = {
  owner: '负责人',
  admin: '管理员',
  member: '成员',
  viewer: '只读成员',
}

/**
 * 缺少演员名称时用中性称谓，不把 id 或空白暴露给用户。
 *
 * 运行期必须容忍契约外的值（`null`/数字/对象）：契约把 `actorDisplayName` 声明为
 * `string`，但值来自服务端响应，一条坏数据不能让整个右栏（成员/Agent/动态）渲染失败
 * ——评审实测 `null.trim()` 会抛 TypeError 并掀翻整块面板。
 */
function actorName(actorDisplayName: unknown): string {
  return typeof actorDisplayName === 'string' && actorDisplayName.trim() ? actorDisplayName.trim() : '某位成员'
}

function roleLabel(value: unknown): string | null {
  return typeof value === 'string' && ROLE_LABELS[value] ? ROLE_LABELS[value]! : null
}

/**
 * 版本号只接受正整数（并限制在合理量级）：契约外的 `1e21`／`-1`／1 万位数字串都不该
 * 变成用户可见的 `V1e+21` 或 10000 字长句，超出范围就当作「没有版本号」降级。
 */
function versionLabel(value: unknown): string | null {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^[0-9]{1,6}$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 1_000_000) return null
  return `V${numeric}`
}

function fileLabel(fileName: string | undefined): string {
  return fileName ? `文件“${fileName}”` : '一个文件'
}

/** 单条动态的可读描述（含演员）。 */
export function describeWorkspaceActivity(input: WorkspaceActivityDescriptor): string {
  const actor = actorName(input.actorDisplayName)
  const metadata = input.safeMetadata ?? {}

  switch (input.kind) {
    case 'member_added': {
      const role = roleLabel(metadata['role'])
      return role ? `${actor} 以${role}身份加入了空间` : `${actor} 加入了空间`
    }
    case 'member_removed':
      return `${actor} 移除了成员`
    case 'member_exit':
      return `${actor} 退出了空间`
    case 'role_changed': {
      const from = roleLabel(metadata['from'])
      const to = roleLabel(metadata['to'])
      return from && to
        ? `${actor} 将成员角色从${from}改为${to}`
        : `${actor} 调整了成员角色`
    }
    case 'owner_transferred':
      return `${actor} 转交了负责人`
    case 'agent_member_added':
      return `${actor} 添加了 Agent 成员`
    case 'agent_member_removed':
      return `${actor} 移除了 Agent 成员`
    case 'file_uploaded':
      return `${actor} 上传了${fileLabel(input.fileName)}`
    case 'file_removed':
      return `${actor} 移除了${fileLabel(input.fileName)}`
    case 'file_version_added': {
      const version = versionLabel(metadata['versionNo'])
      if (input.fileName) {
        return version
          ? `${actor} 上传了文件“${input.fileName}”的 ${version} 版本`
          : `${actor} 上传了文件“${input.fileName}”的新版本`
      }
      return version ? `${actor} 上传了文件 ${version} 的新版本` : `${actor} 上传了文件的新版本`
    }
    case 'workspace_archived':
      return `${actor} 归档了空间`
    case 'workspace_restored':
      return `${actor} 恢复了空间`
    case 'brief_updated': {
      const version = versionLabel(metadata['versionNo'])
      return version ? `${actor} 更新了项目简报（${version}）` : `${actor} 更新了项目简报`
    }
    case 'project_task_created':
      return metadata['assigneeType'] === 'agent' ? `${actor} 创建了一项 Agent 任务` : `${actor} 创建了一项任务`
    case 'project_task_completed':
      return `${actor} 完成了一项任务`
    default:
      // 服务端 kind 是闭合集合，但响应值仍可能越界（版本错配/被篡改）。渲染一句中性
      // 文案而不是空白行，也绝不回退去展示 objectId。
      return `${actor} 更新了空间动态`
  }
}
