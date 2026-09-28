-- Agent-owned narrowing of tenant MCP availability. The published version
-- keeps the policy; each Attempt separately pins the connections it received.
alter table agent_versions
  add column mcp_scope jsonb not null default '{"mode":"all","connectorIds":[]}'::jsonb;

alter table agent_versions
  add constraint agent_versions_mcp_scope_shape check (
    jsonb_typeof(mcp_scope) = 'object'
    and mcp_scope->>'mode' in ('all', 'selected', 'none')
    and jsonb_typeof(mcp_scope->'connectorIds') = 'array'
  );
