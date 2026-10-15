-- Give the team-workspace single-owner trigger (0022) its own SQLSTATE so the server
-- recognises the violation by code instead of matching the message text. The function
-- body and message are unchanged; only `using errcode` is added.
-- DW001: team workspace must have exactly one owner.
create or replace function assert_team_workspace_single_owner()
returns trigger language plpgsql as $$
declare
  target_tenant_id text;
  target_workspace_id text;
  target_workspace_type text;
  owner_count integer;
begin
  if tg_op = 'DELETE' then
    target_tenant_id := old.tenant_id;
    target_workspace_id := old.workspace_id;
  else
    target_tenant_id := new.tenant_id;
    target_workspace_id := new.workspace_id;
  end if;

  select workspace_type
    into target_workspace_type
    from workspaces
   where id = target_workspace_id;

  -- Personal spaces stay governed by personal_workspace_membership_guard (0013).
  if target_workspace_type <> 'personal' then
    select count(*)::integer
      into owner_count
      from workspace_members
     where tenant_id = target_tenant_id
       and workspace_id = target_workspace_id
       and member_role = 'owner';

    if owner_count <> 1 then
      raise exception 'team workspace % must have exactly one owner (found %)',
        target_workspace_id, owner_count
        using errcode = 'DW001';
    end if;
  end if;

  -- A cross-workspace or cross-tenant move must leave the old team workspace valid
  -- as well: validate the old (tenant_id, workspace_id) against the same invariant.
  if tg_op = 'UPDATE'
     and (old.workspace_id is distinct from new.workspace_id
          or old.tenant_id is distinct from new.tenant_id) then
    target_tenant_id := old.tenant_id;
    target_workspace_id := old.workspace_id;

    select workspace_type
      into target_workspace_type
      from workspaces
     where id = target_workspace_id;

    if target_workspace_type <> 'personal' then
      select count(*)::integer
        into owner_count
        from workspace_members
       where tenant_id = target_tenant_id
         and workspace_id = target_workspace_id
         and member_role = 'owner';

      if owner_count <> 1 then
        raise exception 'team workspace % must have exactly one owner (found %)',
          target_workspace_id, owner_count
          using errcode = 'DW001';
      end if;
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
