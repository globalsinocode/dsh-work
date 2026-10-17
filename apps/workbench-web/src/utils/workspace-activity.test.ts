import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  describeWorkspaceActivity,
  type WorkspaceActivityKind,
} from '@dsh-work/workbench-components'
import type { WorkspaceActivityItem, WorkspaceFile } from '@/types/domain'
import { buildActivityDisplayItems, resolveActivityFileName } from './workspace-activity'

/** 服务端动态 kind 的闭合集合（迁移 0026，0088 扩充项目空间动态），前端必须逐一给出可读文案。 */
const ALL_KINDS: WorkspaceActivityKind[] = [
  'member_added',
  'member_removed',
  'workspace_archived',
  'member_exit',
  'role_changed',
  'owner_transferred',
  'agent_member_added',
  'agent_member_removed',
  'file_uploaded',
  'file_removed',
  'file_version_added',
  'workspace_restored',
  'brief_updated',
  'project_task_created',
  'project_task_completed',
]

function item(overrides: Partial<WorkspaceActivityItem> = {}): WorkspaceActivityItem {
  return {
    id: 'act-1',
    kind: 'file_uploaded',
    actorUserId: 'user/a',
    actorDisplayName: '林岚',
    objectType: 'file',
    objectId: 'wfile-secret-id',
    safeMetadata: {},
    occurredAt: '2026-09-10T08:00:00.000Z',
    ...overrides,
  }
}

const files: WorkspaceFile[] = [
  {
    id: 'file-object-1',
    logicalFileId: 'wfile-1',
    name: '库存明细.xlsx',
    type: 'XLSX',
    size: '12 KB',
    uploadedBy: '林岚',
    uploadedAt: '2026-09-10 08:00',
  },
]

describe('团队动态文案（design §2.9 / TW-08）', () => {
  it('全部 kind 都映射为非空且互不相同的描述', () => {
    const descriptions = ALL_KINDS.map(kind => describeWorkspaceActivity({ kind, actorDisplayName: '林岚' }))

    expect(descriptions.every(text => text.length > 0)).toBe(true)
    // 判别性：任何两种 kind 撞成同一句都会让用户分不清发生了什么。
    expect(new Set(descriptions).size).toBe(ALL_KINDS.length)
  })

  it('文件类动态解析不到名称时用中性占位，绝不把 objectId 当名称', () => {
    const text = describeWorkspaceActivity({ kind: 'file_uploaded', actorDisplayName: '林岚' })

    expect(text).toContain('一个文件')
    expect(text).not.toContain('wfile-secret-id')
  })

  it('文件类动态有名称时使用文件列表解析出的名称', () => {
    const text = describeWorkspaceActivity({
      kind: 'file_version_added',
      actorDisplayName: '林岚',
      safeMetadata: { versionNo: 3 },
      fileName: '库存明细.xlsx',
    })

    expect(text).toContain('库存明细.xlsx')
    expect(text).toContain('V3')
  })

  it('角色与版本号只取 safeMetadata 白名单字段，未知角色不渲染原始值', () => {
    const added = describeWorkspaceActivity({
      kind: 'member_added',
      actorDisplayName: '林岚',
      safeMetadata: { userId: 'user-secret', role: 'admin' },
    })
    expect(added).toContain('管理员')
    expect(added).not.toContain('user-secret')

    const changed = describeWorkspaceActivity({
      kind: 'role_changed',
      actorDisplayName: '林岚',
      safeMetadata: { userId: 'user-secret', from: 'member', to: 'viewer' },
    })
    expect(changed).toContain('只读成员')
    expect(changed).not.toContain('user-secret')
  })

  it('缺少演员名称时使用中性称谓而不是 id', () => {
    const text = describeWorkspaceActivity({ kind: 'member_removed', actorDisplayName: '' })

    expect(text).toContain('某位成员')
    expect(text).not.toContain('user/a')
  })

  it('演员名是契约外的非字符串时不得抛错（评审 P2-2：一条坏数据掀翻整块右栏）', () => {
    for (const actor of [null, undefined, 42, { name: 'x' }, ['林岚']]) {
      const text = describeWorkspaceActivity({
        kind: 'member_removed',
        actorDisplayName: actor as unknown as string,
      })
      expect(text).toContain('某位成员')
    }
  })

  it('越界 kind 也要给一句中性文案，不得渲染空白行', () => {
    const text = describeWorkspaceActivity({
      kind: 'message_sent' as never,
      actorDisplayName: '林岚',
    })
    expect(text.length).toBeGreaterThan(0)
    expect(text).toContain('林岚')
  })

  it('版本号只接受正整数：1e21 / -1 / 超长数字串都降级为不带版本号的文案', () => {
    for (const versionNo of [1e21, -1, 0, 2.5, '1e2', '9'.repeat(10000)]) {
      const text = describeWorkspaceActivity({
        kind: 'file_version_added',
        actorDisplayName: '林岚',
        safeMetadata: { versionNo },
      })
      expect(text).not.toContain('e+')
      expect(text.length).toBeLessThan(120)
      expect(text).toContain('新版本')
    }
    expect(describeWorkspaceActivity({
      kind: 'file_version_added',
      actorDisplayName: '林岚',
      safeMetadata: { versionNo: 3 },
    })).toContain('V3')
  })
})

describe('团队动态 kind 集合与服务端契约一致', () => {
  it('前端 kind 集合与最新迁移（0088）的 CHECK 约束逐一相等', () => {
    // 判别性：任何一侧加了新 kind 而另一侧没跟上，这条用例都会红——避免只靠
    // 「两处联合类型长得一样」这种人工同步。
    const sql = readFileSync(findMigration('0088_project_space.sql'), 'utf8')
    const check = sql.match(/workspace_activity_events_kind_check\s+check\s*\(kind\s+in\s*\(([\s\S]*?)\)\)/i)
    expect(check).not.toBeNull()
    const serverKinds = [...check![1]!.matchAll(/'([a-z_]+)'/g)].map(match => match[1]!).sort()

    expect(serverKinds).toEqual([...ALL_KINDS].sort())
  })
})

/** 从当前工作目录向上找迁移文件（vitest 的 cwd 是包目录，也兼容仓库根目录运行）。 */
function findMigration(name: string): string {
  let directory = process.cwd()
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = resolve(directory, `server/migrations/${name}`)
    if (existsSync(candidate)) return candidate
    directory = resolve(directory, '..')
  }
  throw new Error(`未找到迁移 ${name}：无法校验 kind 契约`)
}

describe('团队动态展示项装配', () => {
  it('按 logicalFileId 解析文件名，解析不到时保留中性占位', () => {
    expect(resolveActivityFileName('wfile-1', files)).toBe('库存明细.xlsx')
    expect(resolveActivityFileName('wfile-unknown', files)).toBeUndefined()

    const [resolved] = buildActivityDisplayItems([item({ objectId: 'wfile-1' })], files)
    expect(resolved?.fileName).toBe('库存明细.xlsx')

    const [unresolved] = buildActivityDisplayItems([item({ objectId: 'wfile-unknown' })], [])
    expect(unresolved?.fileName).toBeUndefined()
    // 装配出的展示项不得把 objectId 当成名称带出来。
    const text = describeWorkspaceActivity({
      kind: unresolved!.kind,
      actorDisplayName: unresolved!.actorDisplayName,
      safeMetadata: unresolved!.safeMetadata,
      fileName: unresolved!.fileName,
    })
    expect(text).not.toContain('wfile-unknown')
  })

  it('兼容以 file_objects.id 为 objectId 的历史移除动态', () => {
    expect(resolveActivityFileName('file-object-1', files)).toBe('库存明细.xlsx')
  })

  it('items 越界（非数组）时返回空列表，而不是在渲染期抛错', () => {
    expect(buildActivityDisplayItems(undefined as unknown as never[], files)).toEqual([])
    expect(buildActivityDisplayItems('nope' as unknown as never[], files)).toEqual([])
  })

  it('展示项带上原始 ISO 时间，供 <time datetime> 使用', () => {
    const [row] = buildActivityDisplayItems([item({})], files)
    expect(row?.occurredAt).toBe('2026-09-10T08:00:00.000Z')
  })

  it('只为文件类动态解析名称，并生成时间文案', () => {
    const [member] = buildActivityDisplayItems(
      [item({ kind: 'member_added', objectType: 'member', objectId: 'user/a' })],
      files,
    )
    expect(member?.fileName).toBeUndefined()
    expect(member?.time).toBeTruthy()
    expect(member?.time).not.toBe('2026-09-10T08:00:00.000Z')
  })
})
