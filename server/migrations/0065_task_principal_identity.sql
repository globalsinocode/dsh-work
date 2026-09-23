-- AE-02: Task records distinguish who initiated the work from the principal
-- that executes each Attempt. requested_by remains the human requester used
-- by existing disclosure and Session authorization until all consumers move.
-- approved_by_principal_id is reserved for a Task-level approval; PF-04
-- action approvals keep their own per-action approver and do not fill it.

alter table tasks
  add column initiated_by_principal_id text,
  add column executed_as_principal_id text,
  add column approved_by_principal_id text;

update tasks t
   set initiated_by_principal_id = ep.id
  from execution_principals ep
 where ep.tenant_id = t.tenant_id
   and ((t.source_type = 'system' and ep.kind = 'system' and ep.system_key = 'platform')
     or (t.source_type <> 'system' and ep.kind = 'human' and ep.human_user_id = t.requested_by));

alter table tasks alter column initiated_by_principal_id set not null;
alter table tasks add constraint tasks_initiator_principal_fk
  foreign key (tenant_id, initiated_by_principal_id) references execution_principals(tenant_id, id);
alter table tasks add constraint tasks_executor_principal_fk
  foreign key (tenant_id, executed_as_principal_id) references execution_principals(tenant_id, id);
alter table tasks add constraint tasks_approver_principal_fk
  foreign key (tenant_id, approved_by_principal_id) references execution_principals(tenant_id, id);

-- Existing Attempts are attributed only when their version resolves to an
-- actual Agent Principal. An invalid historical version stays unknown instead
-- of being falsely presented as platform execution.
with latest as (
  select distinct on (r.task_id) r.tenant_id, r.task_id, ra.manifest
    from runs r
    join run_attempts ra on ra.tenant_id = r.tenant_id and ra.run_id = r.id
   order by r.task_id, ra.attempt_no desc, ra.created_at desc
), resolved as (
  select latest.tenant_id, latest.task_id,
         case when nullif(latest.manifest->>'agent_version_id', '') is null
           then system_principal.id else agent_principal.id end as principal_id
    from latest
    left join agent_versions av on av.tenant_id = latest.tenant_id
      and av.id = nullif(latest.manifest->>'agent_version_id', '')
    left join execution_principals agent_principal on agent_principal.tenant_id = av.tenant_id
      and agent_principal.agent_id = av.agent_id and agent_principal.kind = 'agent'
    left join execution_principals system_principal on system_principal.tenant_id = latest.tenant_id
      and system_principal.kind = 'system' and system_principal.system_key = 'platform'
)
update tasks t set executed_as_principal_id = resolved.principal_id
  from resolved
 where t.tenant_id = resolved.tenant_id and t.id = resolved.task_id
   and resolved.principal_id is not null;

create function assign_task_initiator_principal() returns trigger as $$
declare
  expected_principal text;
begin
  select ep.id into expected_principal
    from execution_principals ep
   where ep.tenant_id = new.tenant_id
     and ep.status = 'active'
     and ((new.source_type = 'system' and ep.kind = 'system' and ep.system_key = 'platform')
       or (new.source_type <> 'system' and ep.kind = 'human' and ep.human_user_id = new.requested_by));
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

create trigger tasks_assign_initiator_principal
before insert on tasks
for each row execute function assign_task_initiator_principal();

create function pin_task_executor_principal() returns trigger as $$
declare
  task_ref text;
  task_requester text;
  task_initiator text;
  version_ref text;
  principal_ref text;
  principal_revision integer;
begin
  select r.task_id, t.requested_by, t.initiated_by_principal_id
    into task_ref, task_requester, task_initiator
    from runs r join tasks t on t.tenant_id = r.tenant_id and t.id = r.task_id
   where r.tenant_id = new.tenant_id and r.id = new.run_id;
  version_ref := nullif(new.manifest->>'agent_version_id', '');
  if version_ref is null then
    select id, authorization_version into principal_ref, principal_revision from execution_principals
     where tenant_id = new.tenant_id and kind = 'system' and system_key = 'platform' and status = 'active';
  else
    select ep.id, ep.authorization_version into principal_ref, principal_revision
      from agent_versions av
      join execution_principals ep on ep.tenant_id = av.tenant_id and ep.agent_id = av.agent_id
     where av.tenant_id = new.tenant_id and av.id = version_ref
       and ep.kind = 'agent' and ep.status = 'active';
  end if;
  if task_ref is null or principal_ref is null then
    raise exception 'Attempt executor principal is missing or inactive' using errcode = '23503';
  end if;
  if new.manifest ? 'principal_context' and (
    new.manifest #>> '{principal_context,initiated_by}' is distinct from task_initiator
    or new.manifest #>> '{principal_context,executed_as}' is distinct from principal_ref
    or new.manifest #>> '{principal_context,disclosure_user_id}' is distinct from task_requester
    or (case when new.manifest ? 'resume' then
          (new.manifest #>> '{principal_context,executor_authorization_version}')::integer > principal_revision
        else (new.manifest #>> '{principal_context,executor_authorization_version}')::integer is distinct from principal_revision
        end)
  ) then
    raise exception 'Attempt principal context does not match current Task and executor' using errcode = '23514';
  end if;
  update tasks set executed_as_principal_id = principal_ref
   where tenant_id = new.tenant_id and id = task_ref
     and (executed_as_principal_id is null or executed_as_principal_id = principal_ref);
  if not found then
    raise exception 'Task executor principal cannot change across Attempts' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger run_attempts_pin_task_executor_principal
after insert on run_attempts
for each row execute function pin_task_executor_principal();
