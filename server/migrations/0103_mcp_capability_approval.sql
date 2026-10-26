-- MCP 能力变更确认：capability_snapshot 为最近一次发现的完整清单，
-- approved_snapshot 为生效清单；新增或 Schema 变化的 Tool 须管理员确认后才生效。
alter table mcp_connector_profiles
  add column approved_snapshot jsonb not null default '[]'::jsonb;

update mcp_connector_profiles
   set approved_snapshot = capability_snapshot,
       approved_digest = capability_digest,
       approval_status = 'approved'
 where capability_digest is not null;
