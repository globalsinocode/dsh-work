-- 内置工具代码化之后，工作空间授权只保留 Agent 与 Skill（0104 保留了 tools /
-- tool_versions / tool_binding_revisions 表用于审计与 Connector 治理，但没有同步
-- 「工作空间不再授权工具」这一步）。结果 0022 的回填把历史工具授权留在
-- workspace_capability_grants / workspace_grant_sources 里，管理端对账清单会列出
-- 已经不再存在的 tool 来源，且这类来源无法被对账改写，反过来卡住 Agent 成员移出。
-- 这里按 0096 的口径清理并收紧约束；工具表本身保持原样（合并决策：保留治理与审计）。
delete from workspace_capability_grants where capability_type = 'tool';
delete from workspace_grant_sources where capability_type = 'tool';

alter table workspace_capability_grants drop constraint if exists workspace_capability_grants_capability_type_check;
alter table workspace_capability_grants add constraint workspace_capability_grants_capability_type_check
  check (capability_type in ('agent', 'skill'));

alter table workspace_grant_sources drop constraint if exists workspace_grant_sources_capability_type_check;
alter table workspace_grant_sources add constraint workspace_grant_sources_capability_type_check
  check (capability_type in ('agent', 'skill'));
