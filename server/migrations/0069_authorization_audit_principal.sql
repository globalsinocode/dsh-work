-- Authorization audit keeps the human caller as actor while identifying the
-- independent Agent whose execution grant was evaluated.
alter table audit_events add column executor_principal_id text;
alter table audit_events add constraint audit_executor_principal_fk
  foreign key (tenant_id, executor_principal_id) references execution_principals(tenant_id, id);
