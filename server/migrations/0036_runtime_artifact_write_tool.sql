-- Allow the governed employee assistant to create task-local text artifacts.

insert into tools (
  id, tenant_id, key, name, source, status, connector_id, system, description,
  dsh_tool_name, mode, timeout_seconds, allowed_role_ids, data_scopes,
  approval_policy, last_checked_at
) values (
  'write', 'tenant-dsh-work', 'dsh-write', '生成成果文件', 'platform', 'available',
  'connector-dsh-workspace', 'DSH Runtime',
  '仅在当前 Run 的 output 目录生成 Markdown、纯文本或 CSV 成果；任务成功后由平台收集并发布。',
  'write', 'write', 30, '["role-employee", "role-platform-admin"]',
  '["workspace:authorized"]', 'none', now()
)
on conflict (id) do update set
  name = excluded.name,
  status = excluded.status,
  connector_id = excluded.connector_id,
  system = excluded.system,
  description = excluded.description,
  dsh_tool_name = excluded.dsh_tool_name,
  mode = excluded.mode,
  timeout_seconds = excluded.timeout_seconds,
  allowed_role_ids = excluded.allowed_role_ids,
  data_scopes = excluded.data_scopes,
  approval_policy = excluded.approval_policy,
  last_checked_at = excluded.last_checked_at,
  updated_at = now();

insert into tool_versions (
  id, tenant_id, tool_id, version, input_schema, output_schema, risk_level, status
) values (
  'tool-version-write-1', 'tenant-dsh-work', 'write', '1.0.0',
  '{"type":"object","required":["file_path","content"],"properties":{"file_path":{"type":"string","description":"output 目录下的 .md、.txt 或 .csv 相对路径"},"content":{"type":"string"}}}',
  '{"type":"object","properties":{"path":{"type":"string"},"bytes":{"type":"integer"}}}',
  'low', 'published'
)
on conflict (id) do nothing;

-- Published Agent versions remain immutable: create a new default-assistant
-- version instead of modifying the existing locked version in place.
do $$
declare
  source_version agent_versions%rowtype;
  next_patch integer;
  next_version text;
begin
  select av.* into source_version
    from agents a
    join agent_versions av on av.tenant_id = a.tenant_id and av.id = a.active_version_id
   where a.tenant_id = 'tenant-dsh-work' and a.id = 'agent-dsh-work-assistant';

  if source_version.id is not null and not (source_version.tool_refs ? 'write@1.0.0') then
    next_patch := split_part(source_version.version, '.', 3)::integer + 1;
    next_version := split_part(source_version.version, '.', 1) || '.'
      || split_part(source_version.version, '.', 2) || '.' || next_patch;
    while exists (
      select 1 from agent_versions
       where tenant_id = 'tenant-dsh-work'
         and agent_id = 'agent-dsh-work-assistant'
         and version = next_version
    ) loop
      next_patch := next_patch + 1;
      next_version := split_part(source_version.version, '.', 1) || '.'
        || split_part(source_version.version, '.', 2) || '.' || next_patch;
    end loop;

    insert into agent_versions (
      id, tenant_id, agent_id, version, name, description, welcome_message,
      example_prompts, system_prompt, visible_role_ids, data_scopes, max_tokens,
      timeout_seconds, skill_refs, tool_refs, status, created_by, published_by,
      published_at, source_version, change_summary
    ) values (
      'agent-version-dsh-work-assistant-output-1', source_version.tenant_id,
      source_version.agent_id, next_version, source_version.name,
      source_version.description, source_version.welcome_message,
      source_version.example_prompts, source_version.system_prompt,
      source_version.visible_role_ids, source_version.data_scopes,
      source_version.max_tokens, source_version.timeout_seconds,
      source_version.skill_refs, source_version.tool_refs || '["write@1.0.0"]'::jsonb,
      'published', source_version.created_by,
      coalesce(source_version.published_by, source_version.created_by, 'U00008'),
      now(), source_version.version, '增加受控任务成果文件生成能力'
    );

    update agents
       set active_version_id = 'agent-version-dsh-work-assistant-output-1', updated_at = now()
     where tenant_id = 'tenant-dsh-work' and id = 'agent-dsh-work-assistant';

    insert into agent_release_records (
      id, tenant_id, agent_id, agent_version_id, action, actor_id, note
    ) values (
      'agent-release-dsh-work-assistant-output-1', 'tenant-dsh-work',
      'agent-dsh-work-assistant', 'agent-version-dsh-work-assistant-output-1',
      'published', coalesce(source_version.published_by, source_version.created_by, 'U00008'),
      '增加受控任务成果文件生成能力。'
    ) on conflict (id) do nothing;
  end if;
end;
$$;

-- Pin existing available team Agent members to the new active version while
-- retaining old-version sources for already-created Sessions.
update workspace_agent_members wam
   set agent_version_id = a.active_version_id, updated_at = now()
  from agents a
 where wam.tenant_id = 'tenant-dsh-work'
   and wam.agent_id = 'agent-dsh-work-assistant'
   and wam.status = 'available'
   and a.tenant_id = wam.tenant_id
   and a.id = wam.agent_id
   and wam.agent_version_id <> a.active_version_id;

insert into workspace_grant_sources (
  id, tenant_id, workspace_id, capability_type, capability_version_id,
  source_type, source_ref_id, status, created_by
)
select 'wgs-output-agent-' || md5(wam.id), wam.tenant_id, wam.workspace_id,
       'agent', wam.agent_version_id, 'agent_member', wam.id, 'active', wam.added_by
  from workspace_agent_members wam
 where wam.tenant_id = 'tenant-dsh-work'
   and wam.agent_id = 'agent-dsh-work-assistant'
   and wam.status = 'available'
on conflict do nothing;

insert into workspace_grant_sources (
  id, tenant_id, workspace_id, capability_type, capability_version_id,
  source_type, source_ref_id, status, created_by
)
select 'wgs-output-tool-' || md5(wam.id), wam.tenant_id, wam.workspace_id,
       'tool', 'tool-version-write-1', 'agent_member', wam.id, 'active', wam.added_by
  from workspace_agent_members wam
 where wam.tenant_id = 'tenant-dsh-work'
   and wam.agent_id = 'agent-dsh-work-assistant'
   and wam.status = 'available'
on conflict do nothing;

insert into workspace_capability_grants (
  tenant_id, workspace_id, capability_type, capability_version_id
)
select tenant_id, workspace_id, capability_type, capability_version_id
  from workspace_grant_sources
 where tenant_id = 'tenant-dsh-work'
   and id like 'wgs-output-%'
   and status = 'active'
on conflict do nothing;

update workspaces w
   set team_auth_revision = team_auth_revision + 1
 where w.tenant_id = 'tenant-dsh-work'
   and w.workspace_type = 'team'
   and exists (
     select 1 from workspace_agent_members wam
      where wam.tenant_id = w.tenant_id and wam.workspace_id = w.id
        and wam.agent_id = 'agent-dsh-work-assistant' and wam.status = 'available'
   );
