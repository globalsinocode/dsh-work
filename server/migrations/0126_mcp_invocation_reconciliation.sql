-- MCP 调用结果未知时，由管理员核对权威状态后登记结论；原始 result 保留，不改写审计事实。
alter table mcp_invocation_audits
  add column resolved_result text check (resolved_result in ('success', 'failed')),
  add column resolved_by text,
  add column resolved_at timestamptz,
  add column resolution_note text;
