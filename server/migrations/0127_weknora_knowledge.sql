-- 企业知识库接入 WeKnora 方案（docs/design/weknora-knowledge-plan.md）WK-S1。
--
-- 文档解析、分段、向量化与检索交给 WeKnora；平台只保存连接、经平台创建的知识库、按部门的
-- 可见范围授权、会话所选知识库和每次注入的引用快照。可见范围在查看、管理和检索时实时计算，
-- 不展开写入授权表。员工在个人空间对话中添加了知识库才检索（WK4）。
--
-- 原有本地知识库模块随本迁移删除（WK1）：四张表、两篇合成文档与检索函数一并删除，旧执行的
-- 引用记录不迁移。prevent_published_version_update 由多张表共用，保留。

create table if not exists external_knowledge_connections (
  id text primary key,
  tenant_id text not null references tenants(id),
  provider text not null default 'weknora' check (provider = 'weknora'),
  base_url text not null,
  -- WK-S1 由部署配置写入，API Key 不入库；WK-S3 改为加密凭据存储引用。
  credential_ref text,
  credential_hint text,
  credential_expires_at timestamptz,
  embedding_model_id text,
  status text not null default 'active' check (status in ('active', 'disabled')),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_failure_reason text,
  updated_by text,
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create unique index if not exists external_knowledge_connections_one_per_tenant
  on external_knowledge_connections (tenant_id);

create table if not exists external_knowledge_bases (
  id text primary key,
  tenant_id text not null references tenants(id),
  connection_id text not null,
  external_id text not null,
  name text not null check (char_length(name) between 1 and 60 and btrim(name) <> ''),
  description text not null default '',
  owner_department_id text not null,
  embedding_model_id text,
  status text not null default 'active' check (status in ('active', 'deleted', 'unavailable')),
  created_by text,
  created_at timestamptz not null default now(),
  updated_by text,
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (connection_id, external_id),
  foreign key (tenant_id, connection_id) references external_knowledge_connections(tenant_id, id),
  foreign key (tenant_id, owner_department_id) references org_departments(tenant_id, id)
);

create table if not exists external_knowledge_base_grants (
  id text primary key,
  tenant_id text not null references tenants(id),
  knowledge_base_id text not null,
  department_id text not null,
  include_descendants boolean not null default true,
  status text not null default 'active' check (status in ('active', 'invalid')),
  granted_by text,
  granted_via text not null check (granted_via in ('employee', 'admin')),
  created_at timestamptz not null default now(),
  invalidated_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, knowledge_base_id) references external_knowledge_bases(tenant_id, id),
  foreign key (tenant_id, department_id) references org_departments(tenant_id, id)
);

create unique index if not exists external_knowledge_base_grants_active
  on external_knowledge_base_grants (tenant_id, knowledge_base_id, department_id) where status = 'active';
create index if not exists external_knowledge_base_grants_by_department
  on external_knowledge_base_grants (tenant_id, department_id) where status = 'active';

create table if not exists session_knowledge_bases (
  tenant_id text not null references tenants(id),
  session_id text not null,
  knowledge_base_id text not null,
  added_by text not null,
  added_at timestamptz not null default now(),
  primary key (tenant_id, session_id, knowledge_base_id),
  foreign key (tenant_id, session_id) references sessions(tenant_id, id),
  foreign key (tenant_id, knowledge_base_id) references external_knowledge_bases(tenant_id, id)
);

-- 引用快照不依赖外部文档仍然存在：文档之后被删除，页脚与来源展示仍可读。
create table if not exists run_knowledge_citations (
  id text primary key,
  tenant_id text not null references tenants(id),
  run_id text not null,
  attempt_id text not null,
  ordinal integer not null check (ordinal > 0),
  external_document_id text not null,
  knowledge_base_id text not null,
  knowledge_base_name text not null,
  title text not null,
  file_name text not null default '',
  document_updated_at timestamptz not null,
  content_checksum text not null,
  excerpt text not null,
  relevance_score double precision not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, attempt_id, ordinal),
  foreign key (tenant_id, run_id) references runs(tenant_id, id),
  foreign key (tenant_id, attempt_id) references run_attempts(tenant_id, id)
);

create index if not exists run_knowledge_citations_by_run
  on run_knowledge_citations (tenant_id, run_id, attempt_id);

-- 三级权限码（5.1）：现有带 workbench:use 的角色默认可以查看和检索。
update roles
   set permissions = permissions || '["knowledge:view"]'::jsonb
 where permissions ? 'workbench:use'
   and not permissions ? 'knowledge:view';

drop table if exists run_knowledge_sources;
drop table if exists knowledge_chunks;
drop table if exists knowledge_documents;
drop table if exists knowledge_sources;
drop function if exists knowledge_index_document();
drop function if exists knowledge_split_chunks(text, integer);
drop function if exists knowledge_search_terms(text);
