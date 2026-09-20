-- B-01 统一 Agent 定义（AgentSpec）：限额字段与运行时契约对齐为
-- max_tool_calls / max_output_bytes，并新增 agent_spec JSONB 保存随草稿
-- 固定的规范化定义。不再做历史换算：既有版本行按平台默认值补齐，
-- 语义以新写入的定义为准。
alter table agent_versions drop column max_tokens;
alter table agent_versions
  add column max_tool_calls integer not null default 20
    check (max_tool_calls between 1 and 100),
  add column max_output_bytes integer not null default 65536
    check (max_output_bytes between 1024 and 1048576),
  add column agent_spec jsonb;

comment on column agent_versions.agent_spec is
  '规范化 AgentSpec（apiVersion/metadata/instructions/capabilities/limits 等），草稿写入时展开默认值并固定；既有行未回填为 null';
