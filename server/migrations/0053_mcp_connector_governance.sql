-- PF-03: MCP extends the existing Connector control plane. Authorization is
-- intentionally connector-scoped: an Agent can use every Tool exposed by an
-- approved MCP server, or none of them. Per-tool platform grants are not
-- created and MCP capabilities never become tool_versions implicitly.

create table mcp_connector_profiles (
  tenant_id text not null references tenants(id),
  connector_id text not null,
  server_name text not null check (server_name ~ '^[A-Za-z0-9_-]{1,32}$'),
  transport text not null default 'streamable-http'
    check (transport = 'streamable-http'),
  approval_status text not null default 'draft'
    check (approval_status in ('draft', 'pending_review', 'approved', 'changes_pending')),
  capability_digest text,
  approved_digest text,
  capability_snapshot jsonb not null default '[]'::jsonb,
  discovered_at timestamptz,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, connector_id),
  unique (tenant_id, server_name),
  foreign key (tenant_id, connector_id) references connectors(tenant_id, id),
  foreign key (tenant_id, reviewed_by) references users(tenant_id, id),
  check (capability_digest is null or capability_digest ~ '^[a-f0-9]{64}$'),
  check (approved_digest is null or approved_digest ~ '^[a-f0-9]{64}$')
);

create table agent_mcp_grants (
  tenant_id text not null references tenants(id),
  agent_id text not null,
  connector_id text not null,
  status text not null check (status in ('active', 'revoked')),
  granted_by text not null,
  granted_at timestamptz not null default now(),
  revoked_by text,
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, agent_id, connector_id),
  foreign key (tenant_id, agent_id) references agents(tenant_id, id),
  foreign key (tenant_id, connector_id) references connectors(tenant_id, id),
  foreign key (tenant_id, granted_by) references users(tenant_id, id),
  foreign key (tenant_id, revoked_by) references users(tenant_id, id)
);

create index agent_mcp_grants_by_connector
  on agent_mcp_grants (tenant_id, connector_id, status);

create table mcp_invocation_audits (
  id text primary key,
  tenant_id text not null references tenants(id),
  run_id text not null,
  attempt_id text not null,
  connector_id text not null,
  actor_user_id text not null,
  call_id text not null,
  capability_name text not null,
  parameter_digest text not null check (parameter_digest ~ '^[a-f0-9]{64}$'),
  result text not null check (result in ('success', 'failed', 'unknown')),
  occurred_at timestamptz not null default now(),
  unique (tenant_id, attempt_id, call_id),
  foreign key (tenant_id, run_id) references runs(tenant_id, id),
  foreign key (tenant_id, attempt_id) references run_attempts(tenant_id, id),
  foreign key (tenant_id, connector_id) references connectors(tenant_id, id),
  foreign key (tenant_id, actor_user_id) references users(tenant_id, id)
);

create index mcp_invocation_audits_by_connector
  on mcp_invocation_audits (tenant_id, connector_id, occurred_at desc);
