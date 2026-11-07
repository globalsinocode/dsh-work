-- 企业组织架构方案（docs/design/org-structure-plan.md）ORG-S2：按部门授予角色。
--
-- 管理员把一个角色授给部门（可包含所有下级部门），覆盖到的每名员工得到一行
-- user_roles，source_key = 'department:<grant_id>'。读取权限的代码仍只查 user_roles；
-- 管理员直接授予与撤销只操作 source_key = 'local' 的行，两种来源互不覆盖。
-- 第一版只授角色，不授数据范围（OD7）；含 admin:*、admin:write、admin:read、audit:read 的
-- 管理类角色不能授给部门（OD8），由服务端在授权和修改角色权限时检查。
-- 部门被删除时其授权置为 invalid，不转移给上级部门；展开结果由服务端在同一事务中重算。

create table if not exists org_department_grants (
  id text primary key,
  tenant_id text not null references tenants(id),
  department_id text not null,
  role_id text not null,
  include_descendants boolean not null default true,
  status text not null default 'active' check (status in ('active', 'invalid')),
  granted_by text,
  created_at timestamptz not null default now(),
  invalidated_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, department_id) references org_departments(tenant_id, id),
  foreign key (tenant_id, role_id) references roles(tenant_id, id)
);

create unique index if not exists org_department_grants_active_role
  on org_department_grants (tenant_id, department_id, role_id) where status = 'active';

alter table user_roles drop constraint if exists user_roles_local_source_check;
alter table user_roles
  add constraint user_roles_source_check check (source_key = 'local' or source_key like 'department:%');
