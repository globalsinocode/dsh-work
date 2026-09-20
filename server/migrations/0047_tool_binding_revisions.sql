-- B-03 / I-04 真实绑定修订与发布追溯。
-- 每个工具版本的平台批准绑定（连接、凭据槽位、执行身份策略、数据范围、环境）
-- 形成不可变修订行；任一语义字段变化产生新修订（content_digest 区分）。
-- 绑定为平台所有，包/候选不可声明；不回填历史发布记录——既有工具的初始
-- 修订由服务层在首次解析时按当前真实配置物化。

create table tool_binding_revisions (
  id text primary key,
  tenant_id text not null references tenants(id),
  tool_id text not null,
  tool_version text not null,
  revision integer not null,
  connector_id text not null,
  executor text not null,
  endpoint text not null,
  credential_ref text,
  identity_policy text not null,
  environment text not null default 'default',
  allowed_role_ids jsonb not null default '[]'::jsonb,
  data_scopes jsonb not null default '[]'::jsonb,
  approval_policy text not null,
  content_digest text not null,
  status text not null check (status in ('active', 'superseded', 'revoked')),
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, tool_id, revision),
  foreign key (tenant_id, tool_id) references tools(tenant_id, id),
  foreign key (tenant_id, connector_id) references connectors(tenant_id, id),
  foreign key (tenant_id, created_by) references users(tenant_id, id)
);

create index tool_binding_revisions_active
  on tool_binding_revisions (tenant_id, tool_id, tool_version)
  where status = 'active';

-- 发布版本与候选封存的绑定依据：Attempt Manifest 固定同一引用集，发布事务
-- 内比较当前解析结果与封存依据，绑定漂移即证据失效。
alter table agent_versions
  add column if not exists binding_refs jsonb not null default '[]'::jsonb;

alter table agent_release_submissions
  add column if not exists binding_refs jsonb not null default '[]'::jsonb;
