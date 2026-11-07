-- 企业组织架构方案（docs/design/org-structure-plan.md）ORG-S1：本地维护的部门树与成员。
--
-- 每个企业有且只有一个根部门（parent_id 为空），以企业名称命名，由本迁移为已有企业创建；
-- 打开组织架构页不写入数据。path 是从根到本部门的 ID 路径（'/root/a/b/'），用于查询子树和
-- 拒绝把部门移到自己的下级之下；树的写操作在服务端按企业串行执行。删除部门是置为 removed，
-- 第二期的部门授权需要保留指向已删除部门的记录。
--
-- 员工可以属于多个部门，至多一个主部门；users.department_id 只作显示文本，由平台写入主部门
-- 名称。不考虑历史数据：上线时清空独立账号现有的部门文本，不转为部门。

create table if not exists org_departments (
  id text primary key,
  tenant_id text not null references tenants(id),
  parent_id text,
  name text not null check (char_length(name) between 1 and 60),
  path text not null,
  sort_order integer not null default 0,
  status text not null default 'active' check (status in ('active', 'removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,
  unique (tenant_id, id),
  foreign key (tenant_id, parent_id) references org_departments(tenant_id, id),
  check ((parent_id is null) = (path = '/' || id || '/'))
);

create unique index if not exists org_departments_one_root
  on org_departments (tenant_id) where parent_id is null;
create unique index if not exists org_departments_sibling_name
  on org_departments (tenant_id, parent_id, name) where status = 'active' and parent_id is not null;

create table if not exists org_department_members (
  tenant_id text not null references tenants(id),
  department_id text not null,
  user_id text not null,
  is_primary boolean not null default false,
  added_by text,
  added_at timestamptz not null default now(),
  primary key (tenant_id, department_id, user_id),
  foreign key (tenant_id, department_id) references org_departments(tenant_id, id),
  foreign key (tenant_id, user_id) references users(tenant_id, id)
);

create unique index if not exists org_department_members_one_primary
  on org_department_members (tenant_id, user_id) where is_primary;
create index if not exists org_department_members_by_user
  on org_department_members (tenant_id, user_id);

insert into org_departments (id, tenant_id, parent_id, name, path)
select 'dept-root-' || t.id, t.id, null, coalesce(nullif(left(btrim(t.name), 60), ''), '企业'), '/dept-root-' || t.id || '/'
  from tenants t
 where not exists (select 1 from org_departments d where d.tenant_id = t.id and d.parent_id is null);

-- AI Hub 账号的部门文本由目录同步维护（组织架构在该模式下不可用），不在这里清空。
update users set department_id = null, updated_at = now()
 where department_id is not null and identity_provider <> 'ai-hub';
