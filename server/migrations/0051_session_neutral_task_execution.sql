-- PF-01: allow a governed Task to execute without creating a product Session.
-- Session-backed conversation runs keep their existing references; task/API/event
-- runs use Task -> Run -> Attempt as the ownership chain.

alter table runs alter column session_id drop not null;

alter table tasks add column request_digest text
  check (request_digest is null or request_digest ~ '^[a-f0-9]{64}$');

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

alter table artifacts add column task_id text;

update artifacts a
   set task_id = source.task_id
  from (
    select distinct on (av.tenant_id, av.artifact_id)
           av.tenant_id, av.artifact_id, r.task_id
      from artifact_versions av
      join runs r on r.tenant_id = av.tenant_id and r.id = av.source_run_id
     order by av.tenant_id, av.artifact_id, av.version_no asc
  ) source
 where a.tenant_id = source.tenant_id and a.id = source.artifact_id;

alter table artifacts alter column session_id drop not null;
alter table artifacts add constraint artifacts_task_fk
  foreign key (tenant_id, task_id) references tasks(tenant_id, id);
alter table artifacts add constraint artifacts_owner_check
  check (session_id is not null or task_id is not null);
create index artifacts_by_task on artifacts (tenant_id, task_id, created_at desc);
