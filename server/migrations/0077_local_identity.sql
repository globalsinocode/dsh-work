-- Local credentials attach to stable users; existing authorization and business data remain intact.
create table local_user_credentials (
  tenant_id text not null references tenants(id),
  user_id text not null,
  username text not null check (username ~ '^[a-z0-9][a-z0-9._@-]{2,79}$'),
  password_hash text not null,
  must_change_password boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id),
  unique (tenant_id, username),
  foreign key (tenant_id, user_id) references users(tenant_id, id)
);

create table local_identity_bootstrap (
  tenant_id text primary key references tenants(id),
  user_id text not null references users(id),
  consumed_at timestamptz not null default now()
);

-- Shared across processes and restarts; keys are HMACs, not usernames or addresses.
create table local_auth_rate_limits (
  key_hash text primary key,
  attempts integer not null check (attempts > 0),
  expires_at timestamptz not null
);
create index local_auth_rate_limits_expiry on local_auth_rate_limits (expires_at);

alter table authentication_sessions
  add column authentication_provider text not null default 'ai-hub-oidc'
    check (authentication_provider in ('ai-hub-oidc', 'local-password')),
  alter column access_token_encrypted drop not null,
  alter column token_expires_at drop not null;

alter table authentication_sessions add constraint authentication_session_credentials check (
  (authentication_provider = 'ai-hub-oidc' and access_token_encrypted is not null and token_expires_at is not null)
  or (authentication_provider = 'local-password' and access_token_encrypted is null and refresh_token_encrypted is null and token_expires_at is null)
);
