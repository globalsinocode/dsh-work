-- M4-03 controlled, read-only Tool catalog backed by the verified DSH Runtime.

alter table connectors drop constraint if exists connectors_status_check;
alter table connectors add constraint connectors_status_check
  check (status in ('healthy', 'degraded', 'offline', 'disabled'));
alter table connectors
  add column if not exists system text not null default '企业系统',
  add column if not exists protocol text not null default 'rest'
    check (protocol in ('runtime', 'rest', 'openapi', 'mcp', 'database')),
  add column if not exists endpoint text not null default '',
  add column if not exists auth_type text not null default '未配置',
  add column if not exists scope_description text not null default '',
  add column if not exists latency_ms integer,
  add column if not exists last_checked_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

create table connector_health_checks (
  id text primary key,
  tenant_id text not null references tenants(id),
  connector_id text not null,
  status text not null check (status in ('healthy', 'degraded', 'offline')),
  latency_ms integer not null,
  message text not null,
  checked_by text not null,
  checked_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, connector_id) references connectors(tenant_id, id),
  foreign key (tenant_id, checked_by) references users(tenant_id, id)
);

alter table tools drop constraint if exists tools_status_check;
alter table tools add constraint tools_status_check check (status in ('available', 'degraded', 'disabled'));

alter table tools
  add column if not exists connector_id text,
  add column if not exists system text not null default 'DSH Runtime',
  add column if not exists description text not null default '平台预置工具',
  add column if not exists dsh_tool_name text,
  add column if not exists mode text not null default 'read' check (mode in ('read', 'write')),
  add column if not exists timeout_seconds integer not null default 30 check (timeout_seconds between 1 and 600),
  add column if not exists allowed_role_ids jsonb not null default '["role-employee"]'::jsonb,
  add column if not exists data_scopes jsonb not null default '["workspace:authorized"]'::jsonb,
  add column if not exists approval_policy text not null default 'none' check (approval_policy in ('none', 'sensitive', 'always')),
  add column if not exists last_checked_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

alter table tool_versions
  add column if not exists status text not null default 'published' check (status = 'published'),
  add column if not exists created_at timestamptz not null default now();

insert into connectors (
  id, tenant_id, key, name, connector_type, system, protocol, endpoint, auth_type,
  scope_description, status, latency_ms, last_checked_at
) values (
  'connector-dsh-workspace', 'tenant-dsh-work', 'dsh-workspace',
  'DSH Runtime 内置工具连接器', 'runtime', 'DSH Runtime', 'runtime', 'dsh://workspace',
  'Runtime Manifest + Sandbox', '承载 DSH Runtime 普通内置工具；仅访问当前 Run 显式挂载的工作空间与输入文件。',
  'healthy', 0, now()
)
on conflict (id) do nothing;

update tools set status = 'disabled', updated_at = now()
 where tenant_id = 'tenant-dsh-work' and id = 'tool-dsh-runtime';

insert into tools (
  id, tenant_id, key, name, source, status, connector_id, system, description,
  dsh_tool_name, mode, timeout_seconds, allowed_role_ids, data_scopes,
  approval_policy, last_checked_at
) values
  ('read', 'tenant-dsh-work', 'dsh-read', '读取文件', 'platform', 'available',
   'connector-dsh-workspace', 'DSH Runtime', '读取当前 Run 授权目录中的文本文件，支持分页读取。',
   'read', 'read', 30, '["role-employee"]', '["workspace:authorized"]', 'none', now()),
  ('glob', 'tenant-dsh-work', 'dsh-glob', '查找文件', 'platform', 'available',
   'connector-dsh-workspace', 'DSH Runtime', '在当前 Run 授权目录中按文件名模式查找文件。',
   'glob', 'read', 30, '["role-employee"]', '["workspace:authorized"]', 'none', now()),
  ('grep', 'tenant-dsh-work', 'dsh-grep', '搜索文件内容', 'platform', 'available',
   'connector-dsh-workspace', 'DSH Runtime', '在当前 Run 授权目录中按文本或正则表达式搜索文件内容。',
   'grep', 'read', 30, '["role-employee"]', '["workspace:authorized"]', 'none', now())
on conflict (id) do nothing;

insert into tool_versions (
  id, tenant_id, tool_id, version, input_schema, output_schema, risk_level, status
) values
  ('tool-version-read-1', 'tenant-dsh-work', 'read', '1.0.0',
   '{"type":"object","required":["file_path"],"properties":{"file_path":{"type":"string"},"offset":{"type":"integer"},"limit":{"type":"integer"}}}',
   '{"type":"object","properties":{"content":{"type":"string"}}}', 'low', 'published'),
  ('tool-version-glob-1', 'tenant-dsh-work', 'glob', '1.0.0',
   '{"type":"object","required":["pattern"],"properties":{"pattern":{"type":"string"},"path":{"type":"string"}}}',
   '{"type":"object","properties":{"paths":{"type":"array","items":{"type":"string"}}}}', 'low', 'published'),
  ('tool-version-grep-1', 'tenant-dsh-work', 'grep', '1.0.0',
   '{"type":"object","required":["pattern"],"properties":{"pattern":{"type":"string"},"path":{"type":"string"}}}',
   '{"type":"object","properties":{"matches":{"type":"array"}}}', 'low', 'published')
on conflict (id) do nothing;

alter table tools
  add constraint tools_connector_fk foreign key (tenant_id, connector_id) references connectors(tenant_id, id);

create index connector_health_checks_by_connector
  on connector_health_checks (tenant_id, connector_id, checked_at desc);
create index tools_by_connector
  on tools (tenant_id, connector_id, status);
