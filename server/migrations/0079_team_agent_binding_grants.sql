-- Default tools are pinned in binding_refs even when tool_refs is empty.
-- Preserve each existing Agent-member source, including older published versions
-- still usable by pinned Sessions. Do not infer ownership from legacy/manual grants.
-- Workspace mutations use this same lock first; serialize with disable/remove/revoke.
select id from workspaces where workspace_type = 'team' order by id for update;

with added_sources as (
  insert into workspace_grant_sources (
    id, tenant_id, workspace_id, capability_type, capability_version_id,
    source_type, source_ref_id, status, created_by
  )
  select distinct
    'wgs-binding-' || md5(jsonb_build_array(wam.tenant_id, wam.workspace_id, wam.id, tv.id)::text),
    wam.tenant_id, wam.workspace_id, 'tool', tv.id,
    'agent_member', wam.id, 'active', wam.added_by
  from workspace_agent_members wam
  join workspaces w on w.tenant_id = wam.tenant_id and w.id = wam.workspace_id
    and w.workspace_type = 'team'
  join workspace_grant_sources source on source.tenant_id = wam.tenant_id
    and source.workspace_id = wam.workspace_id and source.source_ref_id = wam.id
    and source.source_type = 'agent_member' and source.capability_type = 'agent'
    and source.status = 'active'
  join workspace_capability_grants granted on granted.tenant_id = source.tenant_id
    and granted.workspace_id = source.workspace_id and granted.capability_type = 'agent'
    and granted.capability_version_id = source.capability_version_id
  join agent_versions av on av.tenant_id = wam.tenant_id and av.agent_id = wam.agent_id
    and av.id = source.capability_version_id and av.status = 'published'
  cross join lateral jsonb_array_elements(av.binding_refs) binding
  join tool_versions tv on tv.tenant_id = av.tenant_id
    and tv.tool_id || '@' || tv.version = binding->>'tool'
  where wam.status = 'available'
  -- A revoked source is deliberately retained, never resurrected by this backfill.
  on conflict do nothing
  returning tenant_id, workspace_id, capability_version_id
), added_grants as (
  insert into workspace_capability_grants (tenant_id, workspace_id, capability_type, capability_version_id)
  select distinct tenant_id, workspace_id, 'tool', capability_version_id from added_sources
  on conflict do nothing
)
update workspaces w set team_auth_revision = team_auth_revision + 1
where exists (
  select 1 from added_sources source
  where source.tenant_id = w.tenant_id and source.workspace_id = w.id
);
