-- AE-05: Agent-owned routines are distinct from employee-owned automations.
-- The recipient is a disclosure subject, never the routine's owner or initiator.
create table agent_routines (
  id text primary key,
  tenant_id text not null references tenants(id),
  agent_id text not null,
  agent_version_id text not null,
  workspace_id text not null,
  recipient_user_id text not null,
  name text not null check (char_length(name) between 1 and 120),
  schedule jsonb not null,
  schedule_revision integer not null default 1 check (schedule_revision > 0),
  next_slot_utc timestamptz,
  input_template jsonb not null,
  approved_role_ids text[] not null default '{}',
  approved_data_scopes text[] not null default '{}',
  confirmed_config_revision text not null default '',
  revision integer not null default 1 check (revision > 0),
  status text not null default 'draft' check (status in ('draft', 'enabled', 'paused', 'disabled')),
  created_by text not null,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, agent_id) references agents(tenant_id, id),
  foreign key (tenant_id, agent_version_id) references agent_versions(tenant_id, id),
  foreign key (tenant_id, workspace_id) references workspaces(tenant_id, id),
  foreign key (tenant_id, recipient_user_id) references users(tenant_id, id),
  foreign key (tenant_id, created_by) references users(tenant_id, id),
  foreign key (tenant_id, approved_by) references users(tenant_id, id)
);
create index agent_routines_due on agent_routines(tenant_id, next_slot_utc)
  where status = 'enabled' and next_slot_utc is not null;
create index agent_routines_by_agent on agent_routines(tenant_id, agent_id, created_at desc);

create table agent_routine_executions (
  id text primary key,
  tenant_id text not null references tenants(id),
  routine_id text not null,
  trigger_id text not null,
  kind text not null check (kind in ('scheduled', 'manual', 'event', 'missed')),
  planned_slot_utc timestamptz,
  missed_from_utc timestamptz,
  missed_to_utc timestamptz,
  routine_revision integer not null,
  schedule_revision integer not null,
  request_fingerprint text,
  trigger_evidence jsonb not null default '{}'::jsonb,
  execution_config jsonb not null default '{}'::jsonb,
  task_id text,
  run_id text,
  admission_status text not null check (admission_status in ('accepted', 'skipped', 'interrupted')),
  reason_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, routine_id, trigger_id),
  foreign key (tenant_id, routine_id) references agent_routines(tenant_id, id),
  foreign key (tenant_id, task_id) references tasks(tenant_id, id),
  foreign key (tenant_id, run_id) references runs(tenant_id, id),
  check ((admission_status = 'accepted' and task_id is not null and run_id is not null)
    or admission_status in ('skipped', 'interrupted')),
  check ((kind = 'missed' and missed_from_utc is not null and missed_to_utc is not null)
    or (kind in ('scheduled', 'manual', 'event') and planned_slot_utc is not null))
);
create unique index agent_routine_executions_run on agent_routine_executions(tenant_id, run_id)
  where run_id is not null;
create index agent_routine_executions_by_routine on agent_routine_executions(tenant_id, routine_id, created_at desc);

alter table tasks drop constraint tasks_source_type_check;
alter table tasks add constraint tasks_source_type_check
  check (source_type in ('session', 'automation', 'api', 'event', 'system', 'delegation', 'agent_routine'));

create or replace function assign_task_initiator_principal() returns trigger as $$
declare expected_principal text;
begin
  if new.source_type = 'agent_routine' then
    select ep.id into expected_principal
      from agent_routines routine
      join execution_principals ep on ep.tenant_id = routine.tenant_id
        and ep.agent_id = routine.agent_id and ep.kind = 'agent' and ep.status = 'active'
     where routine.tenant_id = new.tenant_id and routine.id = new.source_ref
       and routine.status = 'enabled' and routine.recipient_user_id = new.requested_by;
  else
    select ep.id into expected_principal
      from execution_principals ep
     where ep.tenant_id = new.tenant_id and ep.status = 'active'
       and ((new.source_type = 'system' and ep.kind = 'system' and ep.system_key = 'platform')
         or (new.source_type <> 'system' and ep.kind = 'human' and ep.human_user_id = new.requested_by));
  end if;
  if expected_principal is null then
    raise exception 'Task initiator principal is missing' using errcode = '23503';
  end if;
  if new.initiated_by_principal_id is not null and new.initiated_by_principal_id <> expected_principal then
    raise exception 'Task initiator principal does not match the source' using errcode = '23514';
  end if;
  if new.executed_as_principal_id is not null or new.approved_by_principal_id is not null then
    raise exception 'Task executor or approver cannot be supplied at creation' using errcode = '23514';
  end if;
  new.initiated_by_principal_id := expected_principal;
  return new;
end;
$$ language plpgsql;
