-- MCP 按 Agent 选择：废弃 all，只保留 selected / none，默认 none。
-- 系统未正式上线，存量 all 直接改为 none（含已发布版本，临时关闭不可变触发器）。
alter table agent_versions disable trigger agent_versions_immutable;
update agent_versions
   set mcp_scope = '{"mode":"none","connectorIds":[]}'::jsonb
 where mcp_scope->>'mode' = 'all';
alter table agent_versions enable trigger agent_versions_immutable;

alter table agent_versions
  alter column mcp_scope set default '{"mode":"none","connectorIds":[]}'::jsonb;

alter table agent_versions drop constraint agent_versions_mcp_scope_shape;
alter table agent_versions
  add constraint agent_versions_mcp_scope_shape check (
    jsonb_typeof(mcp_scope) = 'object'
    and mcp_scope->>'mode' in ('selected', 'none')
    and jsonb_typeof(mcp_scope->'connectorIds') = 'array'
  );
