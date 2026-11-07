import type { DatabaseClient } from '../../infrastructure/postgres/database.ts'

const tenantId = 'tenant-dsh-work'

/** 三级权限码按级别包含（weknora-knowledge-plan 5.1）：具备任意一个即“具备查看级别”。 */
export const knowledgeViewLevel = ['knowledge:view', 'knowledge:docs', 'knowledge:bases']
export const knowledgeDocsLevel = ['knowledge:docs', 'knowledge:bases']

export type KnowledgeLevel = 'none' | 'view' | 'docs' | 'bases'

/**
 * 员工可见的知识库 ID（5.3）：员工所属每个有效部门上的授权，加上其上级部门中勾选了
 * “包含下级”的授权。只用有效的部门与授权；没有部门的员工没有可见知识库（WK7）。
 */
export function visibleBaseIdsSql(database: DatabaseClient, userId: string) {
  return database`
    select g.knowledge_base_id
      from org_department_members m
      join org_departments d on d.tenant_id = m.tenant_id and d.id = m.department_id and d.status = 'active'
      join external_knowledge_base_grants g on g.tenant_id = m.tenant_id and g.status = 'active'
      join org_departments gd on gd.tenant_id = g.tenant_id and gd.id = g.department_id and gd.status = 'active'
     where m.tenant_id = ${tenantId} and m.user_id = ${userId}
       and (gd.id = d.id or (g.include_descendants and left(d.path, length(gd.path)) = gd.path))
  `
}

/**
 * 员工的知识库权限级别：有效角色（直接授予与来自部门的）权限并集中的最高级别。AI Hub（OIDC）
 * 账号没有部门，按部门授权不适用，视为 none（第 3 节）。
 */
export async function knowledgeLevelOf(database: DatabaseClient, userId: string): Promise<KnowledgeLevel> {
  const [row] = await database<{ permissions: string[] | null }[]>`
    select array_agg(distinct permission.value) filter (where permission.value like 'knowledge:%') as permissions
      from users u
      join user_roles ur on ur.tenant_id = u.tenant_id and ur.user_id = u.id
       and (ur.valid_until is null or ur.valid_until > now())
       and (ur.source_key = 'local' or ur.source_key like 'department:%')
      join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id and r.status = 'active'
      cross join lateral jsonb_array_elements_text(coalesce(r.permissions, '[]')) permission(value)
     where u.tenant_id = ${tenantId} and u.id = ${userId} and u.status = 'active'
       and u.identity_provider <> 'ai-hub'
  `
  const permissions = new Set(row?.permissions ?? [])
  if (permissions.has('knowledge:bases')) return 'bases'
  if (permissions.has('knowledge:docs')) return 'docs'
  if (permissions.has('knowledge:view')) return 'view'
  return 'none'
}
