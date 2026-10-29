-- 0066 incorrectly derived Agent execution roles from visible_role_ids. Visibility
-- is an audience declaration, not an execution grant. Preserve only grants that
-- have an explicit administrator update audit; all other legacy grants fail closed.

create temporary table migration_0109_agent_role_impacts on commit drop as
select principal.tenant_id,
       principal.agent_id,
       principal.id as principal_id,
       coalesce(jsonb_agg(grants.role_id order by grants.role_id)
         filter (where grants.role_id is not null), '[]'::jsonb) as previous_role_ids,
       case when principal.agent_id = 'agent-dsh-work-assistant'
         then '["role-employee"]'::jsonb else '[]'::jsonb end as replacement_role_ids
  from execution_principals principal
  left join agent_principal_role_grants grants
    on grants.tenant_id = principal.tenant_id and grants.principal_id = principal.id
 where principal.kind = 'agent'
   and (
     principal.agent_id = 'agent-dsh-work-assistant'
     or not exists (
       select 1 from audit_events audit
        where audit.tenant_id = principal.tenant_id
          and audit.action = 'agent.principal.update'
          and audit.object_type = 'agent'
          and audit.object_id = principal.agent_id
          and audit.result = 'success'
     )
   )
 group by principal.tenant_id, principal.agent_id, principal.id
having coalesce(jsonb_agg(grants.role_id order by grants.role_id)
         filter (where grants.role_id is not null), '[]'::jsonb)
       is distinct from
       case when principal.agent_id = 'agent-dsh-work-assistant'
         then '["role-employee"]'::jsonb else '[]'::jsonb end;

-- This body-free audit is the release operator's affected-Agent list. It keeps
-- the pre-migration roles without treating them as authorization evidence.
insert into audit_events (
  id, tenant_id, actor_type, actor_id, action, object_type, object_id,
  result, trace_id, safe_context
)
select 'audit-0109-' || md5(tenant_id || ':' || agent_id),
       tenant_id, 'system', 'migration-0109',
       'agent.principal.migration_reconfiguration_required',
       'agent', agent_id, 'blocked',
       'trace-0109-' || md5(tenant_id || ':' || agent_id),
       jsonb_build_object(
         'previousRoleIds', previous_role_ids,
         'clearedRoleIds', previous_role_ids,
         'replacementRoleIds', replacement_role_ids
       )
  from migration_0109_agent_role_impacts;

delete from agent_principal_role_grants grants
 using execution_principals principal
 where grants.tenant_id = principal.tenant_id
   and grants.principal_id = principal.id
   and principal.kind = 'agent'
   and (
     principal.agent_id = 'agent-dsh-work-assistant'
     or not exists (
       select 1 from audit_events audit
        where audit.tenant_id = principal.tenant_id
          and audit.action = 'agent.principal.update'
          and audit.object_type = 'agent'
          and audit.object_id = principal.agent_id
          and audit.result = 'success'
     )
   );

insert into agent_principal_role_grants (tenant_id, principal_id, role_id)
select principal.tenant_id, principal.id, role.id
  from execution_principals principal
  join roles role
    on role.tenant_id = principal.tenant_id and role.id = 'role-employee'
 where principal.kind = 'agent'
   and principal.agent_id = 'agent-dsh-work-assistant'
on conflict do nothing;
