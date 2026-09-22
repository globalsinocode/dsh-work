-- MCP Connectors are tenant-wide capabilities. Healthy Connectors with a
-- synchronized capability snapshot are available to every Agent, so the old
-- per-Agent grant table has no remaining runtime or management responsibility.
drop table if exists agent_mcp_grants;
