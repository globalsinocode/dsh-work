-- MCP Connector deletion is a governed soft-delete. Runtime authorization,
-- current Agent availability and credentials are revoked immediately, while review and invocation
-- evidence remains available for audit and incident investigation.

alter table connectors
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by text,
  add constraint connectors_deleted_by_fk
    foreign key (tenant_id, deleted_by) references users(tenant_id, id);

create index if not exists connectors_active_by_tenant
  on connectors (tenant_id, name)
  where deleted_at is null;
