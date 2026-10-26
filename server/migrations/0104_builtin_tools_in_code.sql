-- 内置工具可以代码化注册（tonycc），但不得删除 tools / tool_versions /
-- tool_binding_revisions 与 Agent 版本上的 tool_refs / binding_refs
-- （三方合并能力决策：保留 Connector/Binding 治理与审计）。
-- 本迁移只增加版本级联网搜索开关，以及 Runtime 紧急停用清单。

alter table agent_versions add column if not exists web_search_enabled boolean not null default false;

alter table runtime_configurations add column if not exists disabled_tools jsonb not null default '[]'::jsonb;
alter table runtime_configurations drop constraint if exists runtime_configurations_disabled_tools_shape;
alter table runtime_configurations add constraint runtime_configurations_disabled_tools_shape
  check (jsonb_typeof(disabled_tools) = 'array');
