-- Agent 发布治理持久化：ZIP 包登记、候选提交、试运行与版本证据。
-- 前端原型（agent-governance-proto overlay）的服务端承载。

create table agent_packages (
  id text primary key,
  tenant_id text not null references tenants(id),
  agent_id text not null,
  file_name text not null,
  sha256 text not null,
  storage_dir text not null,
  manifest jsonb not null,
  files jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, agent_id) references agents(tenant_id, id),
  foreign key (tenant_id, created_by) references users(tenant_id, id)
);

create index agent_packages_by_agent
  on agent_packages (tenant_id, agent_id, created_at desc);

-- 每个 Agent 同时只允许一个进行中的候选提交；发布后保留行供审计。
create table agent_release_submissions (
  id text primary key,
  tenant_id text not null references tenants(id),
  agent_id text not null,
  agent_version_id text not null,
  bound_fingerprint text not null default '',
  revision integer not null default 1,
  status text not null check (status in ('draft', 'submitted', 'changes_requested', 'published', 'withdrawn')),
  source text not null check (source in ('config', 'zip')),
  sealed_revision integer,
  sealed_at timestamptz,
  cases jsonb not null default '[]'::jsonb,
  package_refs jsonb not null default '{"skills": [], "tools": []}'::jsonb,
  missing_deps jsonb not null default '{"skills": [], "tools": []}'::jsonb,
  checks jsonb not null default '[]'::jsonb,
  plan jsonb not null default '[]'::jsonb,
  review_note text,
  package_id text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, agent_id) references agents(tenant_id, id),
  foreign key (tenant_id, agent_version_id) references agent_versions(tenant_id, id),
  foreign key (tenant_id, package_id) references agent_packages(tenant_id, id),
  foreign key (tenant_id, created_by) references users(tenant_id, id)
);

create unique index agent_release_submissions_active
  on agent_release_submissions (tenant_id, agent_id)
  where status in ('draft', 'submitted', 'changes_requested');

create table agent_trial_runs (
  id text primary key,
  tenant_id text not null references tenants(id),
  submission_id text not null,
  agent_id text not null,
  submission_revision integer not null,
  status text not null check (status in ('checking', 'queued', 'executing', 'asserting', 'passed', 'failed', 'cancelled')),
  steps jsonb not null default '[]'::jsonb,
  failure_stage text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_by text not null,
  unique (tenant_id, id),
  foreign key (tenant_id, submission_id) references agent_release_submissions(tenant_id, id),
  foreign key (tenant_id, agent_id) references agents(tenant_id, id),
  foreign key (tenant_id, created_by) references users(tenant_id, id)
);

create index agent_trial_runs_by_submission
  on agent_trial_runs (tenant_id, submission_id, started_at desc);

-- 版本级证据：发布时按候选检查/试运行/审核结论写入，管理端版本详情展示。
create table agent_version_evidence (
  id text primary key,
  tenant_id text not null references tenants(id),
  agent_id text not null,
  agent_version_id text not null,
  kind text not null check (kind in ('configuration_checked', 'runtime_verified', 'business_accepted')),
  summary text not null,
  run_id text,
  scope text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, agent_id) references agents(tenant_id, id),
  foreign key (tenant_id, agent_version_id) references agent_versions(tenant_id, id),
  foreign key (tenant_id, created_by) references users(tenant_id, id)
);

create index agent_version_evidence_by_agent
  on agent_version_evidence (tenant_id, agent_id, created_at desc);
