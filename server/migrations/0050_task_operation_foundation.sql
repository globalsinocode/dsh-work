-- PF-01: session-neutral task identity and durable external-operation receipts.
-- Existing Run rows are assigned a Task. A database guard also assigns a Task
-- to raw inserts, so every Run has a stable owner even when a maintenance or
-- test fixture bypasses PostgresRunRepository.

create table tasks (
  id text primary key,
  tenant_id text not null references tenants(id),
  requested_by text not null,
  source_type text not null check (source_type in ('session', 'automation', 'api', 'event', 'system')),
  source_ref text,
  correlation_key text not null,
  workspace_id text,
  session_id text,
  status text not null check (status in ('accepted', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, source_type, correlation_key),
  foreign key (tenant_id, requested_by) references users(tenant_id, id),
  foreign key (tenant_id, workspace_id) references workspaces(tenant_id, id),
  foreign key (tenant_id, session_id) references sessions(tenant_id, id),
  check (source_type <> 'session' or session_id is not null)
);

alter table runs add column task_id text;

insert into tasks (
  id, tenant_id, requested_by, source_type, source_ref, correlation_key,
  workspace_id, session_id, status, created_at, updated_at
)
select
  'task-' || r.id,
  r.tenant_id,
  r.requested_by,
  'session',
  r.session_id,
  'legacy-run:' || r.id,
  s.workspace_id,
  r.session_id,
  case r.status
    when 'queued' then 'accepted'
    when 'running' then 'running'
    when 'cancel_requested' then 'running'
    when 'succeeded' then 'succeeded'
    when 'failed' then 'failed'
    when 'cancelled' then 'cancelled'
  end,
  r.created_at,
  r.updated_at
from runs r
join sessions s on s.tenant_id = r.tenant_id and s.id = r.session_id;

update runs set task_id = 'task-' || id where task_id is null;

create function ensure_run_task_identity() returns trigger as $$
declare
  run_workspace_id text;
begin
  if new.task_id is not null then
    return new;
  end if;
  select workspace_id into run_workspace_id
    from sessions where tenant_id = new.tenant_id and id = new.session_id;
  new.task_id := 'task-' || new.id;
  insert into tasks (
    id, tenant_id, requested_by, source_type, source_ref, correlation_key,
    workspace_id, session_id, status, created_at, updated_at
  ) values (
    new.task_id, new.tenant_id, new.requested_by, 'session', new.session_id,
    'raw-run:' || new.id, run_workspace_id, new.session_id,
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

create trigger runs_ensure_task_identity
before insert on runs
for each row execute function ensure_run_task_identity();

alter table runs alter column task_id set not null;

create function sync_task_status_from_run() returns trigger as $$
begin
  if old.status is distinct from new.status then
    update tasks
       set status = case new.status
         when 'queued' then 'accepted'
         when 'running' then 'running'
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

create trigger runs_sync_task_status
after update of status on runs
for each row execute function sync_task_status_from_run();

alter table runs add constraint runs_task_fk
  foreign key (tenant_id, task_id) references tasks(tenant_id, id);
alter table runs add constraint runs_task_unique unique (tenant_id, task_id);
alter table runs add constraint runs_task_identity_unique unique (tenant_id, task_id, id);
create index runs_by_task on runs (tenant_id, task_id, created_at desc);

create table task_operations (
  id text primary key,
  tenant_id text not null references tenants(id),
  task_id text not null,
  run_id text,
  attempt_id text,
  operation_key text not null,
  action_type text not null,
  action_ref text not null,
  parameter_digest text not null check (parameter_digest ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('accepted', 'completed', 'failed', 'unknown')),
  receipt jsonb not null default '{}'::jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, task_id, operation_key),
  foreign key (tenant_id, task_id) references tasks(tenant_id, id),
  foreign key (tenant_id, task_id, run_id) references runs(tenant_id, task_id, id),
  foreign key (tenant_id, run_id, attempt_id) references run_attempts(tenant_id, run_id, id),
  check (attempt_id is null or run_id is not null),
  check (status <> 'failed' or error_code is not null),
  check (status = 'failed' or error_code is null)
);

create index task_operations_by_task on task_operations (tenant_id, task_id, created_at asc);
create index task_operations_unresolved on task_operations (tenant_id, status, updated_at asc)
  where status in ('accepted', 'unknown');
