-- PF-02: cumulative Task budgets and one durable reservation/usage fact per Attempt.
-- A budget scope is a Task today; PF-06 may attach delegated child Tasks to the
-- same root scope without changing the accounting contract.

alter table tasks add column budget_scope_task_id text;
update tasks set budget_scope_task_id = id where budget_scope_task_id is null;
alter table tasks alter column budget_scope_task_id set not null;
alter table tasks add constraint tasks_budget_scope_fk
  foreign key (tenant_id, budget_scope_task_id) references tasks(tenant_id, id);
create index tasks_by_budget_scope on tasks (tenant_id, budget_scope_task_id, created_at asc);

create table task_budget_accounts (
  tenant_id text not null references tenants(id),
  budget_scope_task_id text not null,
  max_duration_ms bigint check (max_duration_ms is null or max_duration_ms between 1000 and 86400000),
  max_tool_calls bigint check (max_tool_calls is null or max_tool_calls between 0 and 100000),
  max_output_bytes bigint check (max_output_bytes is null or max_output_bytes between 1024 and 1073741824),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, budget_scope_task_id),
  foreign key (tenant_id, budget_scope_task_id) references tasks(tenant_id, id)
);

insert into task_budget_accounts (tenant_id, budget_scope_task_id)
select tenant_id, id from tasks
on conflict (tenant_id, budget_scope_task_id) do nothing;

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

-- Maintenance fixtures and guarded raw Run inserts are still allowed to rely
-- on runs_ensure_task_identity. Ensure the Task created by that BEFORE trigger
-- receives the same unbounded budget account as repository-created Tasks.
create function ensure_run_budget_account() returns trigger as $$
begin
  insert into task_budget_accounts (tenant_id, budget_scope_task_id)
  select tenant_id, budget_scope_task_id from tasks
   where tenant_id = new.tenant_id and id = new.task_id
  on conflict (tenant_id, budget_scope_task_id) do nothing;
  return new;
end;
$$ language plpgsql;

create trigger runs_ensure_budget_account
after insert on runs
for each row execute function ensure_run_budget_account();

create table attempt_budget_usage (
  id text primary key,
  tenant_id text not null references tenants(id),
  budget_scope_task_id text not null,
  task_id text not null,
  run_id text not null,
  attempt_id text not null,
  status text not null check (status in ('reserved', 'settled', 'released')),
  reserved_duration_ms bigint not null check (reserved_duration_ms >= 0),
  reserved_tool_calls bigint not null check (reserved_tool_calls >= 0),
  reserved_output_bytes bigint not null check (reserved_output_bytes >= 0),
  actual_duration_ms bigint check (actual_duration_ms is null or actual_duration_ms >= 0),
  actual_tool_calls bigint check (actual_tool_calls is null or actual_tool_calls >= 0),
  actual_output_bytes bigint check (actual_output_bytes is null or actual_output_bytes >= 0),
  input_tokens bigint check (input_tokens is null or input_tokens >= 0),
  output_tokens bigint check (output_tokens is null or output_tokens >= 0),
  cost_amount numeric(20, 8) check (cost_amount is null or cost_amount >= 0),
  cost_currency text,
  token_measurement text not null default 'unavailable'
    check (token_measurement in ('reported', 'unavailable')),
  cost_measurement text not null default 'unavailable'
    check (cost_measurement in ('reported', 'unavailable')),
  duration_measurement text not null default 'reserved'
    check (duration_measurement in ('runtime', 'timestamps', 'reserved', 'zero')),
  tool_measurement text not null default 'reserved'
    check (tool_measurement in ('runtime', 'reserved', 'zero')),
  output_measurement text not null default 'reserved'
    check (output_measurement in ('platform', 'reserved', 'zero')),
  terminal_status text check (terminal_status is null or terminal_status in ('succeeded', 'failed', 'cancelled')),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  unique (tenant_id, attempt_id),
  foreign key (tenant_id, budget_scope_task_id)
    references task_budget_accounts(tenant_id, budget_scope_task_id),
  foreign key (tenant_id, task_id) references tasks(tenant_id, id),
  foreign key (tenant_id, task_id, run_id) references runs(tenant_id, task_id, id),
  foreign key (tenant_id, run_id, attempt_id) references run_attempts(tenant_id, run_id, id),
  check ((status = 'reserved' and settled_at is null and terminal_status is null)
    or (status in ('settled', 'released') and settled_at is not null and terminal_status is not null)),
  check ((cost_amount is null and cost_currency is null) or (cost_amount is not null and cost_currency is not null))
);

create index attempt_budget_usage_by_scope
  on attempt_budget_usage (tenant_id, budget_scope_task_id, status, created_at asc);

-- Attempts queued or active before PF-02 already own immutable per-Attempt
-- limits. Reserve those limits in the newly created unbounded Task account so
-- restart recovery and terminal fallback use the same accounting path as new
-- Attempts. Malformed maintenance fixtures fall back to the platform defaults;
-- the Runtime compiler still rejects malformed executable manifests.
insert into attempt_budget_usage (
  id, tenant_id, budget_scope_task_id, task_id, run_id, attempt_id, status,
  reserved_duration_ms, reserved_tool_calls, reserved_output_bytes, created_at
)
select
  'budget-usage-upgrade-' || a.id,
  a.tenant_id,
  t.budget_scope_task_id,
  r.task_id,
  r.id,
  a.id,
  'reserved',
  case when jsonb_typeof(a.manifest #> '{limits,timeout_seconds}') = 'number'
    then ((a.manifest #>> '{limits,timeout_seconds}')::numeric * 1000)::bigint
    else 300000 end,
  case when jsonb_typeof(a.manifest #> '{limits,max_tool_calls}') = 'number'
    then (a.manifest #>> '{limits,max_tool_calls}')::numeric::bigint
    else 20 end,
  case when jsonb_typeof(a.manifest #> '{limits,max_output_bytes}') = 'number'
    then (a.manifest #>> '{limits,max_output_bytes}')::numeric::bigint
    else 65536 end,
  a.created_at
from run_attempts a
join runs r on r.tenant_id = a.tenant_id and r.id = a.run_id
join tasks t on t.tenant_id = r.tenant_id and t.id = r.task_id
where a.status in ('queued', 'running', 'cancel_requested')
on conflict (tenant_id, attempt_id) do nothing;

-- Any terminal path that does not provide a precise PF-02 settlement still
-- closes its reservation exactly once. A never-started Attempt releases all
-- reserved capacity; an interrupted active Attempt charges known elapsed time
-- and conservatively charges the reserved tool/output ceilings.
create function settle_attempt_budget_fallback() returns trigger as $$
declare
  scope_task_id text;
  elapsed bigint;
begin
  if new.status not in ('succeeded', 'failed', 'cancelled')
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
           terminal_status = new.status, settled_at = now()
     where tenant_id = new.tenant_id and attempt_id = new.id and status = 'reserved';
  else
    elapsed := greatest(0, floor(extract(epoch from (coalesce(new.ended_at, now())
      - coalesce(new.started_at, new.created_at))) * 1000)::bigint);
    update attempt_budget_usage
       set status = 'settled', actual_duration_ms = elapsed,
           actual_tool_calls = reserved_tool_calls,
           actual_output_bytes = reserved_output_bytes,
           duration_measurement = 'timestamps', tool_measurement = 'reserved',
           output_measurement = 'reserved', terminal_status = new.status,
           settled_at = now()
     where tenant_id = new.tenant_id and attempt_id = new.id and status = 'reserved';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger run_attempts_settle_budget_fallback
after update of status on run_attempts
for each row execute function settle_attempt_budget_fallback();
