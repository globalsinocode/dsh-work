-- Agent execution grants are owned by the Agent Principal, not its human
-- governance owner. The existing version declarations remain upper bounds.
create table agent_principal_role_grants (
  tenant_id text not null,
  principal_id text not null,
  role_id text not null,
  granted_at timestamptz not null default now(),
  primary key (tenant_id, principal_id, role_id),
  foreign key (tenant_id, principal_id) references execution_principals(tenant_id, id) on delete cascade,
  foreign key (tenant_id, role_id) references roles(tenant_id, id)
);

create table agent_principal_scope_grants (
  tenant_id text not null,
  principal_id text not null,
  scope_value text not null check (length(scope_value) between 1 and 128),
  granted_at timestamptz not null default now(),
  primary key (tenant_id, principal_id, scope_value),
  foreign key (tenant_id, principal_id) references execution_principals(tenant_id, id) on delete cascade
);

-- Preserve only the currently active (or unpublished draft) executable ceiling
-- for existing Agents. Historical versions must not expand their identity.
insert into agent_principal_role_grants (tenant_id, principal_id, role_id)
select distinct ep.tenant_id, ep.id, r.id
  from execution_principals ep
  join agents a on a.tenant_id = ep.tenant_id and a.id = ep.agent_id
  join agent_versions av on av.tenant_id = a.tenant_id
    and av.id = coalesce(a.active_version_id, a.draft_version_id)
  cross join lateral jsonb_array_elements_text(av.visible_role_ids) requested(role_id)
  join roles r on r.tenant_id = ep.tenant_id and r.id = requested.role_id
 where ep.kind = 'agent';

insert into agent_principal_scope_grants (tenant_id, principal_id, scope_value)
select distinct ep.tenant_id, ep.id, requested.scope_value
  from execution_principals ep
  join agents a on a.tenant_id = ep.tenant_id and a.id = ep.agent_id
  join agent_versions av on av.tenant_id = a.tenant_id
    and av.id = coalesce(a.active_version_id, a.draft_version_id)
  cross join lateral jsonb_array_elements_text(av.data_scopes) requested(scope_value)
 where ep.kind = 'agent';

create function bump_agent_principal_grant_version() returns trigger as $$
declare principal_ref text;
declare tenant_ref text;
begin
  principal_ref := coalesce(new.principal_id, old.principal_id);
  tenant_ref := coalesce(new.tenant_id, old.tenant_id);
  update execution_principals
     set authorization_version = authorization_version + 1, updated_at = now()
   where tenant_id = tenant_ref and id = principal_ref and kind = 'agent';
  if not found then raise exception 'Grant subject must be an Agent Principal' using errcode = '23514'; end if;
  return coalesce(new, old);
end;
$$ language plpgsql;

create trigger agent_role_grant_version after insert or update or delete on agent_principal_role_grants
for each row execute function bump_agent_principal_grant_version();
create trigger agent_scope_grant_version after insert or update or delete on agent_principal_scope_grants
for each row execute function bump_agent_principal_grant_version();
