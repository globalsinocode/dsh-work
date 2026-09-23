-- Keep the existing human disclosure/approval fields while attributing the
-- action to the actual Agent executor and the human approval Principal.
alter table run_approval_requests
  add column executor_principal_id text,
  add column resolver_principal_id text;

update run_approval_requests a
   set executor_principal_id = t.executed_as_principal_id,
       resolver_principal_id = (
         select ep.id from execution_principals ep
          where ep.tenant_id = a.tenant_id and ep.kind = 'human'
            and ep.human_user_id = a.resolved_by
       )
  from runs r
  join tasks t on t.tenant_id = r.tenant_id and t.id = r.task_id
 where r.tenant_id = a.tenant_id and r.id = a.run_id;

alter table run_approval_requests add constraint approval_executor_principal_fk
  foreign key (tenant_id, executor_principal_id) references execution_principals(tenant_id, id);
alter table run_approval_requests add constraint approval_resolver_principal_fk
  foreign key (tenant_id, resolver_principal_id) references execution_principals(tenant_id, id);
