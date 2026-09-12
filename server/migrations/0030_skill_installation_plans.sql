-- Structured Skill install plans and auditable runtime activation evidence.
alter table skill_installations
  add column plan jsonb,
  add column plan_sha256 text,
  add column compatibility_status text check (compatibility_status in ('compatible', 'needs_review', 'incompatible'));

create table skill_version_dependencies (
  tenant_id text not null,
  skill_version_id text not null,
  dependency_skill_version_id text not null,
  dependency_type text not null check (dependency_type = 'skill'),
  evidence text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, skill_version_id, dependency_skill_version_id),
  foreign key (tenant_id, skill_version_id) references skill_versions (tenant_id, id),
  foreign key (tenant_id, dependency_skill_version_id) references skill_versions (tenant_id, id),
  check (skill_version_id <> dependency_skill_version_id)
);

create table skill_runtime_activations (
  id text primary key,
  tenant_id text not null,
  run_id text not null,
  attempt_id text not null,
  skill_id text not null,
  skill_version text not null,
  content_sha256 text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, attempt_id, skill_id, skill_version),
  foreign key (tenant_id, run_id) references runs (tenant_id, id),
  foreign key (tenant_id, attempt_id) references run_attempts (tenant_id, id)
);

create index skill_runtime_activations_by_run
  on skill_runtime_activations (tenant_id, run_id, created_at);

create table skill_python_executions (
  id text primary key,
  tenant_id text not null,
  run_id text not null,
  attempt_id text not null,
  skill_id text not null,
  entry_path text not null,
  succeeded boolean not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, run_id) references runs (tenant_id, id),
  foreign key (tenant_id, attempt_id) references run_attempts (tenant_id, id)
);
