-- per-agent MCP 与 globasino `all` 并存：默认改为 none（新建草稿不自动挂全部连接器），
-- 仍允许 mode=all（试运行封存与存量版本）。不得把 all 从契约中删除。
alter table agent_versions
  alter column mcp_scope set default '{"mode":"none","connectorIds":[]}'::jsonb;

alter table agent_versions drop constraint if exists agent_versions_mcp_scope_shape;
alter table agent_versions
  add constraint agent_versions_mcp_scope_shape check (
    jsonb_typeof(mcp_scope) = 'object'
    and mcp_scope->>'mode' in ('all', 'selected', 'none')
    and jsonb_typeof(mcp_scope->'connectorIds') = 'array'
  );
