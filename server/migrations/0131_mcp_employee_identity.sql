-- 外部业务应用接入方案 EA-S1（docs/design/external-app-integration-plan.md 5.1）：
-- MCP Connector 的“发送员工身份”开关，默认关闭；只能为 Bearer 认证且凭据独占的 Connector 开启（服务层校验）。
alter table mcp_connector_profiles
  add column if not exists employee_identity_enabled boolean not null default false;

-- 每个 Attempt 启动时向各 Connector 实际下发的调用上下文：只有发送了调用上下文的 Connector 有记录。
-- 调用审计据此记录每次调用是否带调用上下文，不另存员工标识。
create table if not exists mcp_attempt_call_contexts (
  tenant_id text not null references tenants(id),
  attempt_id text not null,
  connector_id text not null,
  visibility text not null check (visibility in ('personal', 'shared')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, attempt_id, connector_id),
  foreign key (tenant_id, attempt_id) references run_attempts(tenant_id, id),
  foreign key (tenant_id, connector_id) references connectors(tenant_id, id)
);

-- null：该次调用没有调用上下文（开关关闭、发布验证、管理端运行或凭据共用）。
alter table mcp_invocation_audits
  add column if not exists call_context text check (call_context in ('personal', 'shared'));
