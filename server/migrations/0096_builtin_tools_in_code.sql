-- 内置工具代码化：内置工具不再是可管理的数据。
-- 系统未正式上线，直接删除工具治理数据模型，不保留存量兼容。

-- 1. 工具审批记录改为直接记录工具名称，不再关联 tool_versions。
do $$
declare constraint_name text;
begin
  for constraint_name in
    select conname from pg_constraint
     where conrelid = 'tool_audit_logs'::regclass and contype = 'f'
       and confrelid = 'tool_versions'::regclass
  loop
    execute format('alter table tool_audit_logs drop constraint %I', constraint_name);
  end loop;
end $$;

update tool_audit_logs ta
   set tool_version_id = coalesce(t.dsh_tool_name, t.id)
  from tool_versions tv
  join tools t on t.tenant_id = tv.tenant_id and t.id = tv.tool_id
 where ta.tenant_id = tv.tenant_id and ta.tool_version_id = tv.id;

alter table tool_audit_logs rename column tool_version_id to tool_name;

-- 2. Agent 版本不再固定工具引用与绑定；联网搜索改为版本上的开关。
alter table agent_versions drop column tool_refs;
alter table agent_versions drop column binding_refs;
alter table agent_versions add column web_search_enabled boolean not null default false;

-- 3. 工作空间不再授权工具；Agent 与 Skill 授权不变。
delete from workspace_capability_grants where capability_type = 'tool';
delete from workspace_grant_sources where capability_type = 'tool';
alter table workspace_capability_grants drop constraint if exists workspace_capability_grants_capability_type_check;
alter table workspace_capability_grants add constraint workspace_capability_grants_capability_type_check
  check (capability_type in ('agent', 'skill'));
alter table workspace_grant_sources drop constraint if exists workspace_grant_sources_capability_type_check;
alter table workspace_grant_sources add constraint workspace_grant_sources_capability_type_check
  check (capability_type in ('agent', 'skill'));

-- 4. 删除工具治理表与 DSH 内置工具连接器；connectors 只保留 MCP。
drop table agent_version_tools;
drop table tool_binding_revisions;
drop table tool_versions cascade;
drop table tools cascade;
delete from connector_health_checks where connector_id = 'connector-dsh-workspace';
delete from connectors where id = 'connector-dsh-workspace';

-- 5. Runtime 配置的紧急停用清单。
alter table runtime_configurations add column disabled_tools jsonb not null default '[]'::jsonb;
alter table runtime_configurations add constraint runtime_configurations_disabled_tools_shape
  check (jsonb_typeof(disabled_tools) = 'array');
