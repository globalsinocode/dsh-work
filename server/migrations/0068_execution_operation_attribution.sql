-- Preserve the human disclosure actor while recording the Agent that actually
-- executed an external capability or registered a task operation.
alter table mcp_invocation_audits add column executor_principal_id text;
alter table task_operations add column executor_principal_id text;

update mcp_invocation_audits audit
   set executor_principal_id = t.executed_as_principal_id
  from runs r join tasks t on t.tenant_id = r.tenant_id and t.id = r.task_id
 where r.tenant_id = audit.tenant_id and r.id = audit.run_id;

update task_operations op
   set executor_principal_id = t.executed_as_principal_id
  from tasks t
 where t.tenant_id = op.tenant_id and t.id = op.task_id and op.attempt_id is not null;

alter table mcp_invocation_audits add constraint mcp_audit_executor_principal_fk
  foreign key (tenant_id, executor_principal_id) references execution_principals(tenant_id, id);
alter table task_operations add constraint task_operation_executor_principal_fk
  foreign key (tenant_id, executor_principal_id) references execution_principals(tenant_id, id);
