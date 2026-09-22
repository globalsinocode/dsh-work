-- PF-05 controlled memory and experience governance.
-- Memory remains separate from authoritative knowledge and business records.

create table memory_consents (
  id text primary key,
  tenant_id text not null references tenants(id),
  source_user_id text not null,
  source_run_id text not null,
  source_attempt_id text not null,
  workspace_id text not null,
  agent_version_id text not null,
  visibility text not null check (visibility in ('private', 'workspace', 'organization')),
  retention_until timestamptz not null,
  purpose text not null,
  status text not null check (status in ('active', 'withdrawn')),
  withdrawn_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, source_user_id) references users(tenant_id, id),
  foreign key (tenant_id, source_run_id) references runs(tenant_id, id),
  foreign key (tenant_id, source_attempt_id) references run_attempts(tenant_id, id),
  foreign key (tenant_id, workspace_id) references workspaces(tenant_id, id),
  foreign key (tenant_id, agent_version_id) references agent_versions(tenant_id, id)
);

create table memory_entries (
  id text primary key,
  tenant_id text not null references tenants(id),
  memory_key text not null,
  kind text not null check (kind in ('preference', 'experience')),
  visibility text not null check (visibility in ('private', 'workspace', 'organization')),
  scope_ref text not null default '',
  agent_version_id text not null,
  current_version_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, memory_key, kind, visibility, scope_ref, agent_version_id),
  foreign key (tenant_id, agent_version_id) references agent_versions(tenant_id, id)
);

create table memory_candidates (
  id text primary key,
  tenant_id text not null references tenants(id),
  consent_id text not null,
  submission_key text not null,
  request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
  memory_key text not null,
  kind text not null check (kind in ('preference', 'experience')),
  title text not null,
  content text not null,
  content_digest text not null,
  visibility text not null check (visibility in ('private', 'workspace', 'organization')),
  scope_ref text not null default '',
  allowed_role_ids jsonb not null default '[]'::jsonb,
  retention_until timestamptz not null,
  status text not null check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  submitted_by text not null,
  reviewed_by text,
  reviewed_at timestamptz,
  review_comment text,
  resolution_key text,
  approved_entry_id text,
  approved_version_id text,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, submitted_by, submission_key),
  foreign key (tenant_id, consent_id) references memory_consents(tenant_id, id),
  foreign key (tenant_id, submitted_by) references users(tenant_id, id),
  foreign key (tenant_id, reviewed_by) references users(tenant_id, id),
  foreign key (tenant_id, approved_entry_id) references memory_entries(tenant_id, id)
);

create table memory_versions (
  id text primary key,
  tenant_id text not null references tenants(id),
  entry_id text not null,
  candidate_id text not null,
  version integer not null check (version > 0),
  title text not null,
  content text not null,
  content_digest text not null,
  kind text not null check (kind in ('preference', 'experience')),
  visibility text not null check (visibility in ('private', 'workspace', 'organization')),
  scope_ref text not null default '',
  agent_version_id text not null,
  allowed_role_ids jsonb not null default '[]'::jsonb,
  source_user_id text not null,
  source_run_id text not null,
  source_attempt_id text not null,
  retention_until timestamptz not null,
  published_by text not null,
  published_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, entry_id, version),
  foreign key (tenant_id, entry_id) references memory_entries(tenant_id, id),
  foreign key (tenant_id, candidate_id) references memory_candidates(tenant_id, id),
  foreign key (tenant_id, agent_version_id) references agent_versions(tenant_id, id),
  foreign key (tenant_id, source_user_id) references users(tenant_id, id),
  foreign key (tenant_id, source_run_id) references runs(tenant_id, id),
  foreign key (tenant_id, source_attempt_id) references run_attempts(tenant_id, id),
  foreign key (tenant_id, published_by) references users(tenant_id, id)
);

alter table memory_candidates
  add constraint memory_candidates_approved_version_fk
  foreign key (tenant_id, approved_version_id) references memory_versions(tenant_id, id);

alter table memory_entries
  add constraint memory_entries_current_version_fk
  foreign key (tenant_id, current_version_id) references memory_versions(tenant_id, id);

create table run_memory_sources (
  id text primary key,
  tenant_id text not null references tenants(id),
  run_id text not null,
  attempt_id text not null,
  memory_version_id text not null,
  relevance_score integer not null check (relevance_score > 0),
  excerpt text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, attempt_id, memory_version_id),
  foreign key (tenant_id, run_id) references runs(tenant_id, id),
  foreign key (tenant_id, attempt_id) references run_attempts(tenant_id, id),
  foreign key (tenant_id, memory_version_id) references memory_versions(tenant_id, id)
);

create index memory_candidates_review_queue
  on memory_candidates (tenant_id, status, created_at);
create index memory_consents_by_owner
  on memory_consents (tenant_id, source_user_id, created_at desc);
create index memory_versions_by_entry
  on memory_versions (tenant_id, entry_id, version desc);
create index run_memory_sources_by_run
  on run_memory_sources (tenant_id, run_id, created_at);

create function prevent_memory_version_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'published memory versions are immutable';
end;
$$;

create trigger memory_versions_immutable before update or delete on memory_versions
  for each row execute function prevent_memory_version_mutation();
