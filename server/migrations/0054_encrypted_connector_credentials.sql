alter table credential_refs drop constraint if exists credential_refs_backend_check;
alter table credential_refs add constraint credential_refs_backend_check
  check (backend in ('dsh-managed', 'keychain', 'secret-manager', 'postgres-encrypted'));

create table credential_secrets (
  tenant_id text not null references tenants(id),
  credential_ref_id text not null,
  algorithm text not null check (algorithm = 'aes-256-gcm'),
  key_id text not null,
  version integer not null default 1 check (version > 0),
  ciphertext bytea not null check (octet_length(ciphertext) > 0),
  nonce bytea not null check (octet_length(nonce) = 12),
  auth_tag bytea not null check (octet_length(auth_tag) = 16),
  created_by text not null,
  updated_by text not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, credential_ref_id),
  foreign key (tenant_id, credential_ref_id) references credential_refs(tenant_id, id) on delete cascade,
  foreign key (tenant_id, created_by) references users(tenant_id, id),
  foreign key (tenant_id, updated_by) references users(tenant_id, id)
);

comment on table credential_secrets is
  'Application-encrypted bearer credentials. The AES-256-GCM master key is supplied outside PostgreSQL.';

-- Legacy MCP Bearer connectors used dsh-managed environment-variable references.
-- SQL cannot safely import those process values, so preserve the Connector,
-- and review history while blocking execution until an
-- administrator re-enters the Token through the rotation endpoint.
update connectors c
   set status = case when c.status = 'disabled' then 'disabled' else 'degraded' end,
       updated_at = now()
 where c.protocol = 'mcp'
   and c.auth_type = 'bearer'
   and c.credential_ref_id is not null
   and not exists (
     select 1
       from credential_secrets cs
      where cs.tenant_id = c.tenant_id
        and cs.credential_ref_id = c.credential_ref_id
   );
