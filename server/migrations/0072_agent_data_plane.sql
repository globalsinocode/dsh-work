-- AE-03: fixed platform tables. Installing an Agent never runs package SQL or
-- creates an Agent-specific table/index. Shared records outlive an installation.

create table agent_installations (
  id text primary key,
  tenant_id text not null references tenants(id),
  agent_id text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, agent_id),
  foreign key (tenant_id, agent_id) references agents(tenant_id, id)
);

insert into agent_installations (id, tenant_id, agent_id)
select 'installation-' || id, tenant_id, id from agents;

create function create_agent_installation() returns trigger as $$
begin
  insert into agent_installations (id, tenant_id, agent_id)
  values ('installation-' || new.id, new.tenant_id, new.id);
  return new;
end;
$$ language plpgsql;

create trigger agents_create_installation
after insert on agents
for each row execute function create_agent_installation();

create table agent_state (
  tenant_id text not null references tenants(id),
  agent_installation_id text not null,
  namespace text not null check (length(namespace) between 1 and 80),
  key text not null check (length(key) between 1 and 160),
  value_json jsonb not null,
  version integer not null check (version > 0),
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by_principal_id text not null,
  source_run_id text,
  source_attempt_id text,
  primary key (tenant_id, agent_installation_id, namespace, key),
  foreign key (tenant_id, agent_installation_id) references agent_installations(tenant_id, id),
  foreign key (tenant_id, updated_by_principal_id) references execution_principals(tenant_id, id),
  foreign key (tenant_id, source_run_id) references runs(tenant_id, id),
  foreign key (tenant_id, source_attempt_id) references run_attempts(tenant_id, id),
  check ((source_run_id is null) = (source_attempt_id is null)),
  check (octet_length(value_json::text) <= 16384)
);
create index agent_state_expiry on agent_state(expires_at) where expires_at is not null;

create table agent_data_collections (
  id text primary key,
  tenant_id text not null references tenants(id),
  collection_key text not null check (collection_key ~ '^[a-z][a-z0-9_]{2,79}$'),
  owner_type text not null check (owner_type in ('tenant', 'workspace')),
  owner_workspace_id text,
  access_scope text not null check (access_scope in ('installation', 'workspace', 'tenant')),
  private_installation_id text,
  schema_version integer not null check (schema_version > 0),
  schema_json jsonb not null check (jsonb_typeof(schema_json) = 'object'),
  query_fields text[] not null default '{}',
  retention_days integer not null check (retention_days between 1 and 3650),
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, collection_key),
  foreign key (tenant_id, owner_workspace_id) references workspaces(tenant_id, id),
  foreign key (tenant_id, private_installation_id) references agent_installations(tenant_id, id),
  foreign key (tenant_id, created_by) references users(tenant_id, id),
  check ((owner_type = 'workspace') = (owner_workspace_id is not null)),
  check ((access_scope = 'installation') = (private_installation_id is not null)),
  check (access_scope <> 'workspace' or owner_workspace_id is not null)
);

create table agent_data_collection_grants (
  tenant_id text not null references tenants(id),
  collection_id text not null,
  agent_installation_id text not null,
  actions text[] not null check (cardinality(actions) > 0 and actions <@ array['query', 'propose', 'create', 'update', 'transition']::text[]),
  granted_by text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, collection_id, agent_installation_id),
  foreign key (tenant_id, collection_id) references agent_data_collections(tenant_id, id),
  foreign key (tenant_id, agent_installation_id) references agent_installations(tenant_id, id),
  foreign key (tenant_id, granted_by) references users(tenant_id, id)
);

create table agent_data_records (
  id text primary key,
  tenant_id text not null references tenants(id),
  collection_id text not null,
  scope_key text not null,
  record_key text not null check (length(record_key) between 1 and 160),
  current_version_id text,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by_principal_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, collection_id, scope_key, record_key),
  foreign key (tenant_id, collection_id) references agent_data_collections(tenant_id, id),
  foreign key (tenant_id, created_by_principal_id) references execution_principals(tenant_id, id)
);

create table agent_data_record_versions (
  id text primary key,
  tenant_id text not null references tenants(id),
  record_id text not null,
  version integer not null check (version > 0),
  schema_version integer not null check (schema_version > 0),
  data_json jsonb not null check (jsonb_typeof(data_json) = 'object'),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  written_by_principal_id text not null,
  source_run_id text not null,
  source_attempt_id text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, record_id, version),
  unique (tenant_id, record_id, id),
  foreign key (tenant_id, record_id) references agent_data_records(tenant_id, id),
  foreign key (tenant_id, written_by_principal_id) references execution_principals(tenant_id, id),
  foreign key (tenant_id, source_run_id) references runs(tenant_id, id),
  foreign key (tenant_id, source_attempt_id) references run_attempts(tenant_id, id),
  check (octet_length(data_json::text) <= 65536)
);

alter table agent_data_records add constraint agent_data_records_current_version_fk
  foreign key (tenant_id, id, current_version_id)
  references agent_data_record_versions(tenant_id, record_id, id);

create table agent_data_record_operations (
  tenant_id text not null references tenants(id),
  source_attempt_id text not null,
  operation_key text not null,
  request_sha256 text not null check (request_sha256 ~ '^[a-f0-9]{64}$'),
  record_version_id text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, source_attempt_id, operation_key),
  foreign key (tenant_id, source_attempt_id) references run_attempts(tenant_id, id),
  foreign key (tenant_id, record_version_id) references agent_data_record_versions(tenant_id, id)
);

-- A fixed per-installation, per-minute write budget prevents one Agent from
-- saturating shared state or collection storage. Buckets are disposable.
create table agent_data_write_counters (
  tenant_id text not null references tenants(id),
  agent_installation_id text not null,
  scope_key text not null,
  bucket_at timestamptz not null,
  used integer not null check (used between 1 and 120),
  primary key (tenant_id, agent_installation_id, scope_key, bucket_at),
  foreign key (tenant_id, agent_installation_id) references agent_installations(tenant_id, id)
);
create index agent_data_write_counters_expiry on agent_data_write_counters(bucket_at);

create index agent_data_records_by_collection on agent_data_records(tenant_id, collection_id, scope_key, updated_at desc);
create index agent_data_versions_by_record on agent_data_record_versions(tenant_id, record_id, version desc);

-- A model-generated value is a proposal until a human accepts it. The
-- operation key is scoped to the source Attempt, never to a later retry.
create table agent_data_proposals (
  id text primary key,
  tenant_id text not null references tenants(id),
  collection_id text not null,
  agent_installation_id text not null,
  record_key text not null,
  data_json jsonb not null check (jsonb_typeof(data_json) = 'object'),
  expected_version integer not null check (expected_version >= 0),
  source_run_id text not null,
  source_attempt_id text not null,
  operation_key text not null,
  request_sha256 text not null check (request_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  record_version_id text,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, source_attempt_id, operation_key),
  foreign key (tenant_id, collection_id) references agent_data_collections(tenant_id, id),
  foreign key (tenant_id, agent_installation_id) references agent_installations(tenant_id, id),
  foreign key (tenant_id, source_run_id) references runs(tenant_id, id),
  foreign key (tenant_id, source_attempt_id) references run_attempts(tenant_id, id),
  foreign key (tenant_id, reviewed_by) references users(tenant_id, id),
  check (octet_length(data_json::text) <= 65536),
  check ((status = 'pending') = (reviewed_at is null)),
  check (status <> 'approved' or record_version_id is not null)
);
create index agent_data_proposals_pending on agent_data_proposals(tenant_id, created_at) where status = 'pending';

create table agent_data_record_deletions (
  id text primary key,
  tenant_id text not null references tenants(id),
  collection_id text not null,
  record_key text not null,
  scope_key text not null,
  version_id text not null,
  content_sha256 text not null,
  source_run_id text not null,
  source_attempt_id text not null,
  reason text not null check (reason in ('retention', 'administrator')),
  deleted_by text,
  deleted_at timestamptz not null default now(),
  unique (tenant_id, version_id),
  foreign key (tenant_id, collection_id) references agent_data_collections(tenant_id, id),
  foreign key (tenant_id, source_run_id) references runs(tenant_id, id),
  foreign key (tenant_id, source_attempt_id) references run_attempts(tenant_id, id),
  foreign key (tenant_id, deleted_by) references users(tenant_id, id)
);

-- Keep old collection contracts for traceability while only the current
-- published version is writable. Agent Version declarations pin that version.
create table agent_data_collection_schema_versions (
  tenant_id text not null references tenants(id),
  collection_id text not null,
  version integer not null check (version > 0),
  schema_json jsonb not null check (jsonb_typeof(schema_json) = 'object'),
  query_fields text[] not null,
  published_by text not null,
  published_at timestamptz not null default now(),
  primary key (tenant_id, collection_id, version),
  foreign key (tenant_id, collection_id) references agent_data_collections(tenant_id, id),
  foreign key (tenant_id, published_by) references users(tenant_id, id)
);
