-- AE-04: an Agent can suggest short-lived memory text, but only a human can
-- consent to its scope/retention and submit it for the existing admin review.
create table memory_proposals (
  id text primary key,
  tenant_id text not null references tenants(id),
  run_id text not null,
  attempt_id text not null,
  agent_version_id text not null,
  agent_principal_id text not null,
  requested_by text not null,
  workspace_id text not null,
  proposal_key text not null check (proposal_key ~ '^[a-f0-9]{64}$'),
  kind text not null check (kind in ('preference', 'experience')),
  title text not null,
  content text not null,
  content_digest text not null check (content_digest ~ '^[a-f0-9]{64}$'),
  status text not null default 'proposed' check (status in ('proposed', 'submitted')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  unique (tenant_id, id),
  unique (tenant_id, attempt_id, proposal_key),
  foreign key (tenant_id, run_id) references runs(tenant_id, id),
  foreign key (tenant_id, attempt_id) references run_attempts(tenant_id, id),
  foreign key (tenant_id, agent_version_id) references agent_versions(tenant_id, id),
  foreign key (tenant_id, agent_principal_id) references execution_principals(tenant_id, id),
  foreign key (tenant_id, requested_by) references users(tenant_id, id),
  foreign key (tenant_id, workspace_id) references workspaces(tenant_id, id)
);

alter table memory_candidates add column source_proposal_id text;
alter table memory_candidates add constraint memory_candidates_source_proposal_fk
  foreign key (tenant_id, source_proposal_id) references memory_proposals(tenant_id, id);
create unique index memory_candidate_per_proposal on memory_candidates(tenant_id, source_proposal_id)
  where source_proposal_id is not null;
create index memory_proposals_by_attempt on memory_proposals(tenant_id, attempt_id, created_at desc);
