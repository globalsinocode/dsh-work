-- AE-02 foundation: stable platform principals are distinct from governance owners.
-- Existing requested_by/user_context fields remain human identities until the
-- Task, Manifest, authorization and result contracts migrate together.

create table execution_principals (
  id text primary key,
  tenant_id text not null references tenants(id),
  kind text not null check (kind in ('human', 'agent', 'system')),
  human_user_id text,
  agent_id text,
  system_key text,
  status text not null default 'active' check (status in ('active', 'disabled')),
  authorization_version integer not null default 1 check (authorization_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, human_user_id),
  unique (tenant_id, agent_id),
  unique (tenant_id, system_key),
  foreign key (tenant_id, human_user_id) references users(tenant_id, id),
  foreign key (tenant_id, agent_id) references agents(tenant_id, id),
  check (
    (kind = 'human' and human_user_id is not null and agent_id is null and system_key is null)
    or (kind = 'agent' and human_user_id is null and agent_id is not null and system_key is null)
    or (kind = 'system' and human_user_id is null and agent_id is null and system_key is not null)
  )
);

insert into execution_principals (id, tenant_id, kind, human_user_id)
select 'principal-human-' || id, tenant_id, 'human', id from users;

insert into execution_principals (id, tenant_id, kind, agent_id)
select 'principal-agent-' || id, tenant_id, 'agent', id from agents;

insert into execution_principals (id, tenant_id, kind, system_key)
select 'principal-system-' || id, id, 'system', 'platform' from tenants;

create function create_human_execution_principal() returns trigger as $$
begin
  insert into execution_principals (id, tenant_id, kind, human_user_id)
  values ('principal-human-' || new.id, new.tenant_id, 'human', new.id);
  return new;
end;
$$ language plpgsql;

create trigger users_create_execution_principal
after insert on users
for each row execute function create_human_execution_principal();

create function create_agent_execution_principal() returns trigger as $$
begin
  insert into execution_principals (id, tenant_id, kind, agent_id)
  values ('principal-agent-' || new.id, new.tenant_id, 'agent', new.id);
  return new;
end;
$$ language plpgsql;

create trigger agents_create_execution_principal
after insert on agents
for each row execute function create_agent_execution_principal();

create function create_system_execution_principal() returns trigger as $$
begin
  insert into execution_principals (id, tenant_id, kind, system_key)
  values ('principal-system-' || new.id, new.id, 'system', 'platform');
  return new;
end;
$$ language plpgsql;

create trigger tenants_create_execution_principal
after insert on tenants
for each row execute function create_system_execution_principal();
