-- A terminal MCP Attempt is not safe to retry until DSH has closed its session
-- and persisted the final invocation audit. Existing attempts remain unfinalized
-- and therefore fail closed; no historical log is inferred to be complete.
alter table run_attempts
  add column mcp_audit_finalized_at timestamptz;
