alter table sessions add column audience text not null default 'workbench' check (audience in ('workbench', 'admin'));
alter table sessions alter column agent_version_id drop not null;
alter table sessions alter column workspace_id drop not null;
alter table sessions add constraint sessions_audience_configuration check (
  (audience = 'workbench' and agent_version_id is not null and workspace_id is not null)
  or (audience = 'admin' and agent_version_id is null and workspace_id is null)
);
create index admin_conversations_by_owner on sessions (tenant_id, created_by, last_active_at desc) where audience = 'admin';
create table skill_installations (
  id text primary key,
  tenant_id text not null,
  run_id text not null,
  created_by text not null,
  source jsonb not null,
  resolved_url text,
  resolved_ref text,
  package jsonb,
  status text not null default 'pending' check (status in ('pending', 'installed', 'cancelled')),
  skill_id text,
  version_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, run_id),
  foreign key (tenant_id, run_id) references runs (tenant_id, id),
  foreign key (tenant_id, created_by) references users (tenant_id, id),
  foreign key (tenant_id, skill_id) references skills (tenant_id, id),
  foreign key (tenant_id, version_id) references skill_versions (tenant_id, id),
  check (status <> 'installed' or (skill_id is not null and version_id is not null and package is not null))
);
