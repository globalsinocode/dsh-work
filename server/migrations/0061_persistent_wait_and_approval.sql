-- PF-04: durable wait, action-bound approval and resume through a new Attempt.

alter table runs drop constraint runs_status_check;
alter table runs add constraint runs_status_check
  check (status in ('queued', 'running', 'waiting', 'cancel_requested', 'succeeded', 'failed', 'cancelled'));

alter table run_attempts drop constraint run_attempts_status_check;
alter table run_attempts add constraint run_attempts_status_check
  check (status in ('queued', 'running', 'waiting', 'cancel_requested', 'succeeded', 'failed', 'cancelled'));

alter table attempt_budget_usage drop constraint attempt_budget_usage_terminal_status_check;
alter table attempt_budget_usage add constraint attempt_budget_usage_terminal_status_check
  check (terminal_status is null or terminal_status in ('waiting', 'succeeded', 'failed', 'cancelled'));

drop index if exists runs_active_by_tenant;
create index runs_active_by_tenant
  on runs (tenant_id, status)
  where status in ('queued', 'running', 'waiting', 'cancel_requested');
comment on index runs_active_by_tenant is
  'Supports active-work lookups; waiting Runs remain active business work even though their source Attempt and Worker have ended.';

create or replace function sync_task_status_from_run() returns trigger as $$
begin
  if old.status is distinct from new.status then
    update tasks
       set status = case new.status
         when 'queued' then 'accepted'
         when 'running' then 'running'
         when 'waiting' then 'waiting'
         when 'cancel_requested' then 'running'
         when 'succeeded' then 'succeeded'
         when 'failed' then 'failed'
         when 'cancelled' then 'cancelled'
       end,
       updated_at = now()
     where tenant_id = new.tenant_id and id = new.task_id;
  end if;
  return new;
end;
$$ language plpgsql;

create or replace function ensure_run_task_identity() returns trigger as $$
declare
  run_workspace_id text;
begin
  if new.task_id is not null then
    return new;
  end if;
  if new.session_id is null then
    raise exception 'session-neutral runs must provide task_id';
  end if;
  select workspace_id into run_workspace_id
    from sessions where tenant_id = new.tenant_id and id = new.session_id;
  new.task_id := 'task-' || new.id;
  insert into tasks (
    id, tenant_id, requested_by, source_type, source_ref, correlation_key,
    budget_scope_task_id, workspace_id, session_id, status, created_at, updated_at
  ) values (
    new.task_id, new.tenant_id, new.requested_by, 'session', new.session_id,
    'raw-run:' || new.id, new.task_id, run_workspace_id, new.session_id,
    case new.status
      when 'queued' then 'accepted'
      when 'running' then 'running'
      when 'waiting' then 'waiting'
      when 'cancel_requested' then 'running'
      when 'succeeded' then 'succeeded'
      when 'failed' then 'failed'
      when 'cancelled' then 'cancelled'
    end,
    coalesce(new.created_at, now()), coalesce(new.updated_at, now())
  );
  return new;
end;
$$ language plpgsql;

create table run_checkpoints (
  id text primary key,
  tenant_id text not null references tenants(id),
  run_id text not null,
  source_attempt_id text not null,
  strategy text not null check (strategy = 'new-attempt-context-v1'),
  runtime_id text,
  runtime_version text not null,
  source_manifest_sha256 text not null check (source_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  resume_context jsonb not null,
  resume_context_sha256 text not null check (resume_context_sha256 ~ '^[a-f0-9]{64}$'),
  checkpoint_digest text not null check (checkpoint_digest ~ '^[a-f0-9]{64}$'),
  correlation_key text not null,
  status text not null check (status in ('active', 'consumed', 'rejected', 'expired', 'cancelled', 'superseded')),
  expires_at timestamptz not null,
  consumed_by_attempt_id text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, run_id, correlation_key),
  foreign key (tenant_id, run_id) references runs(tenant_id, id),
  foreign key (tenant_id, run_id, source_attempt_id) references run_attempts(tenant_id, run_id, id),
  foreign key (tenant_id, run_id, consumed_by_attempt_id) references run_attempts(tenant_id, run_id, id),
  check ((status = 'active' and resolved_at is null and consumed_by_attempt_id is null)
    or (status = 'consumed' and resolved_at is not null and consumed_by_attempt_id is not null)
    or (status in ('rejected', 'expired', 'cancelled', 'superseded') and resolved_at is not null and consumed_by_attempt_id is null))
);

create unique index run_checkpoints_one_active_per_run
  on run_checkpoints (tenant_id, run_id) where status = 'active';
create index run_checkpoints_due
  on run_checkpoints (tenant_id, expires_at) where status = 'active';

create table run_approval_requests (
  id text primary key,
  tenant_id text not null references tenants(id),
  run_id text not null,
  source_attempt_id text not null,
  checkpoint_id text not null,
  correlation_key text not null,
  action_name text not null,
  parameter_digest text not null check (parameter_digest ~ '^[a-f0-9]{64}$'),
  resource_ref text not null,
  execution_identity text not null,
  data_version text not null,
  risk_level text not null check (risk_level in ('medium', 'high')),
  status text not null check (status in ('preparing', 'pending', 'approved', 'rejected', 'expired', 'cancelled')),
  expires_at timestamptz not null,
  requested_at timestamptz not null default now(),
  resolved_by text,
  resolved_at timestamptz,
  resolution_key text,
  resolution_comment text,
  resumed_attempt_id text,
  action_consumed_at timestamptz,
  action_call_id text,
  unique (tenant_id, id),
  unique (tenant_id, run_id, correlation_key),
  unique (tenant_id, resolution_key),
  foreign key (tenant_id, run_id) references runs(tenant_id, id),
  foreign key (tenant_id, run_id, source_attempt_id) references run_attempts(tenant_id, run_id, id),
  foreign key (tenant_id, checkpoint_id) references run_checkpoints(tenant_id, id),
  foreign key (tenant_id, run_id, resumed_attempt_id) references run_attempts(tenant_id, run_id, id),
  check ((status in ('preparing', 'pending') and resolved_at is null and resolved_by is null and resumed_attempt_id is null)
    or (status = 'approved' and resolved_at is not null and resolved_by is not null and resumed_attempt_id is not null)
    or (status in ('rejected', 'expired', 'cancelled') and resolved_at is not null and resumed_attempt_id is null)),
  check ((action_consumed_at is null and action_call_id is null)
    or (status = 'approved' and action_consumed_at is not null and action_call_id is not null))
);

create index run_approval_requests_queue
  on run_approval_requests (tenant_id, status, requested_at asc);

-- A waiting Attempt has released its Worker and cannot spend more from its old
-- reservation. Charge the elapsed attempt conservatively; the resumed Attempt
-- reserves a fresh bounded share from the same Task budget account.
create or replace function settle_attempt_budget_fallback() returns trigger as $$
declare
  scope_task_id text;
  elapsed bigint;
begin
  if new.status not in ('waiting', 'succeeded', 'failed', 'cancelled')
     or old.status = new.status then
    return new;
  end if;

  select budget_scope_task_id into scope_task_id
    from attempt_budget_usage
   where tenant_id = new.tenant_id and attempt_id = new.id and status = 'reserved';
  if scope_task_id is null then
    return new;
  end if;

  perform 1 from task_budget_accounts
   where tenant_id = new.tenant_id and budget_scope_task_id = scope_task_id
   for update;

  if old.status = 'queued' and old.started_at is null then
    update attempt_budget_usage
       set status = 'released', actual_duration_ms = 0, actual_tool_calls = 0,
           actual_output_bytes = 0, duration_measurement = 'zero',
           tool_measurement = 'zero', output_measurement = 'zero',
           terminal_status = new.status,
           settled_at = now()
     where tenant_id = new.tenant_id and attempt_id = new.id and status = 'reserved';
  else
    elapsed := greatest(0, floor(extract(epoch from (coalesce(new.ended_at, now())
      - coalesce(new.started_at, new.created_at))) * 1000)::bigint);
    update attempt_budget_usage
       set status = 'settled', actual_duration_ms = elapsed,
           actual_tool_calls = reserved_tool_calls,
           actual_output_bytes = reserved_output_bytes,
           duration_measurement = 'timestamps', tool_measurement = 'reserved',
           output_measurement = 'reserved',
           terminal_status = new.status,
           settled_at = now()
     where tenant_id = new.tenant_id and attempt_id = new.id and status = 'reserved';
  end if;
  return new;
end;
$$ language plpgsql;
