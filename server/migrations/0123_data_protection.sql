-- 数据防护（数据防护方案 5.3、5.9，DLP-S2）。
-- 词表与白名单保存即生效，管理界面在 DLP-S3 提供。
create table data_protection_terms (
  id text primary key,
  tenant_id text not null references tenants(id),
  value text not null check (length(value) between 1 and 200),
  case_sensitive boolean not null default false,
  whole_word boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, value)
);

create table data_protection_allowlist (
  id text primary key,
  tenant_id text not null references tenants(id),
  value text not null check (length(value) between 1 and 500),
  created_at timestamptz not null default now(),
  unique (tenant_id, value)
);

-- 网关每个请求一条。只记录类别次数与处理方式，不保存原值、原值哈希或上下文（D8）。
create table data_protection_gateway_events (
  id text primary key,
  tenant_id text not null references tenants(id),
  user_id text,
  run_id text not null,
  attempt_id text not null,
  provider_key text not null,
  model_key text not null,
  endpoint text not null check (endpoint in ('chat', 'search')),
  trust_level text not null check (trust_level in ('internal', 'external')),
  secret_count integer not null default 0 check (secret_count >= 0),
  personal_count integer not null default 0 check (personal_count >= 0),
  term_count integer not null default 0 check (term_count >= 0),
  action text not null check (action in ('masked', 'passed')),
  has_image boolean not null default false,
  created_at timestamptz not null default now()
);

create index data_protection_gateway_events_run on data_protection_gateway_events (tenant_id, run_id, created_at);
create index data_protection_gateway_events_time on data_protection_gateway_events (tenant_id, created_at);
