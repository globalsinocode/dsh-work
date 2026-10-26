create table mcp_connector_oauth (
  tenant_id text not null,
  connector_id text not null,
  authorization_endpoint text not null,
  token_endpoint text not null,
  client_id text not null,
  client_secret_credential_ref_id text,
  scopes text[] not null check (cardinality(scopes) >= 1),
  resource text not null,
  primary key (tenant_id, connector_id),
  foreign key (tenant_id, connector_id) references connectors (tenant_id, id)
);

create table mcp_user_grants (
  tenant_id text not null,
  connector_id text not null,
  user_id text not null,
  status text not null check (status in ('active', 'reauthorization_required')),
  credential_ref_id text not null,
  access_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, connector_id, user_id),
  unique (tenant_id, credential_ref_id),
  foreign key (tenant_id, connector_id) references connectors (tenant_id, id),
  foreign key (tenant_id, user_id) references users (tenant_id, id)
);

create table mcp_user_credential_secrets (
  tenant_id text not null,
  credential_ref_id text not null,
  user_id text not null,
  algorithm text not null check (algorithm = 'aes-256-gcm'),
  key_id text not null,
  version integer not null check (version > 0),
  ciphertext bytea not null,
  nonce bytea not null check (octet_length(nonce) = 12),
  auth_tag bytea not null check (octet_length(auth_tag) = 16),
  primary key (tenant_id, credential_ref_id),
  foreign key (tenant_id, credential_ref_id)
    references mcp_user_grants (tenant_id, credential_ref_id)
);

create table mcp_oauth_transactions (
  id text primary key,
  tenant_id text not null,
  user_id text not null,
  connector_id text,
  probe_fingerprint text,
  state_hash text not null,
  code_verifier_ciphertext bytea not null,
  code_verifier_nonce bytea not null,
  code_verifier_auth_tag bytea not null,
  redirect_uri text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check ((connector_id is not null) <> (probe_fingerprint is not null))
);

create table mcp_oauth_probe_secrets (
  transaction_id text primary key references mcp_oauth_transactions (id) on delete cascade,
  ciphertext bytea not null,
  nonce bytea not null,
  auth_tag bytea not null,
  key_id text not null,
  expires_at timestamptz not null
);

alter table mcp_invocation_audits
  add column if not exists grant_subject_id text;
