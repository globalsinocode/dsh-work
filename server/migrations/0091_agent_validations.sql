-- Agent configuration and release redesign, stage S3: validation replaces the
-- release candidate / trial / evidence machinery.
--
-- Version lifecycle: draft (editable, one per Agent) -> candidate (frozen when a
-- validation starts, immutable) -> published (pointer target). The candidate is
-- the draft row frozen in place; editing afterwards starts a new draft version.
-- Validation results bind to the immutable candidate version id, so no
-- fingerprints, candidate revisions or sealed revisions are needed.

-- 1. Version status gains `candidate`.
do $$
declare constraint_name text;
begin
  select conname into constraint_name from pg_constraint
   where conrelid = 'agent_versions'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%status%''draft''%''published''%';
  if constraint_name is not null then
    execute format('alter table agent_versions drop constraint %I', constraint_name);
  end if;
end $$;
alter table agent_versions add constraint agent_versions_status_check
  check (status in ('draft', 'candidate', 'published', 'disabled'));

-- 2. Frozen versions are immutable. A candidate may only become published
--    (status and publication stamps change; content never does).
create function prevent_frozen_agent_version_update() returns trigger language plpgsql as $$
begin
  if old.status = 'published' then
    raise exception 'published versions are immutable';
  end if;
  if old.status = 'candidate' then
    if tg_op = 'DELETE' then
      raise exception 'candidate versions are immutable';
    end if;
    if new.status not in ('candidate', 'published')
       or (to_jsonb(new) - array['status', 'published_at', 'published_by'])
          is distinct from (to_jsonb(old) - array['status', 'published_at', 'published_by']) then
      raise exception 'candidate versions are immutable';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger agent_versions_immutable on agent_versions;
create trigger agent_versions_immutable before update or delete on agent_versions
  for each row execute function prevent_frozen_agent_version_update();

-- 3. Custom test questions belong to the Agent and are reused across versions.
create table agent_test_cases (
  id text primary key,
  tenant_id text not null references tenants(id),
  agent_id text not null,
  position integer not null check (position >= 0),
  prompt text not null check (length(btrim(prompt)) between 1 and 2000),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, agent_id, position),
  foreign key (tenant_id, agent_id) references agents(tenant_id, id),
  foreign key (tenant_id, created_by) references users(tenant_id, id)
);

-- 4. One validation = one frozen candidate run through its case snapshot.
--    Only the newest validation of an Agent is live; older ones are superseded.
create table agent_validations (
  id text primary key,
  tenant_id text not null references tenants(id),
  agent_id text not null,
  agent_version_id text not null,
  session_id text not null,
  status text not null check (status in ('running', 'completed', 'superseded', 'published')),
  created_by text not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, agent_id) references agents(tenant_id, id),
  foreign key (tenant_id, agent_version_id) references agent_versions(tenant_id, id),
  foreign key (tenant_id, session_id) references sessions(tenant_id, id),
  foreign key (tenant_id, created_by) references users(tenant_id, id)
);
create unique index agent_validations_live
  on agent_validations (tenant_id, agent_id) where status in ('running', 'completed');
create index agent_validations_by_agent
  on agent_validations (tenant_id, agent_id, created_at desc);

create table agent_validation_cases (
  id text primary key,
  tenant_id text not null references tenants(id),
  validation_id text not null,
  position integer not null check (position >= 0),
  source text not null check (source in ('example', 'routine', 'custom')),
  source_ref text,
  prompt text not null check (length(btrim(prompt)) between 1 and 8000),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'interrupted', 'cancelled')),
  run_id text,
  attempt_id text,
  run_count integer not null default 0 check (run_count >= 0),
  -- Fixed machine checks: run recorded, execution succeeded, non-empty answer.
  checks jsonb not null default '{}'::jsonb check (jsonb_typeof(checks) = 'object'),
  output text not null default '',
  error text,
  verdict text check (verdict in ('passed', 'failed')),
  verdict_note text,
  verdict_by text,
  verdict_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, validation_id, position),
  foreign key (tenant_id, validation_id) references agent_validations(tenant_id, id),
  foreign key (tenant_id, verdict_by) references users(tenant_id, id),
  check (verdict is distinct from 'failed' or length(btrim(coalesce(verdict_note, ''))) > 0)
);
create index agent_validation_cases_by_run on agent_validation_cases (tenant_id, run_id);

-- 5. Copy historical release records into audit_events. Do not drop
--    agent_release_submissions / evidence / packages / records: globasino
--    发布治理仍以这些表为契约（三方合并能力决策）。
insert into audit_events (id, tenant_id, actor_type, actor_id, action, object_type, object_id,
                          result, trace_id, safe_context, occurred_at)
select 'audit-' || r.id, r.tenant_id, 'user', r.actor_id,
       case r.action
         when 'published' then 'agent.release.publish'
         when 'enabled' then 'agent.enable'
         when 'disabled' then 'agent.disable'
         else 'agent.rollback'
       end,
       'agent', r.agent_id, 'success', 'trace-' || r.id,
       jsonb_build_object('agentVersionId', r.agent_version_id, 'note', r.note, 'migratedFrom', 'agent_release_records'),
       r.created_at
  from agent_release_records r
on conflict (id) do nothing;
