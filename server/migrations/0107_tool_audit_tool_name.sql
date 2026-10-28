-- 内置工具代码化（0104）之后，工具审计按「工具名」记录：一次调用可能根本没有
-- tool_version 行，操作服务写入的是 tool_name。而 0001 建表时只有 tool_version_id
-- 且非空、带外键，导致每次工具审计都报
-- `column "tool_name" of relation "tool_audit_logs" does not exist`。
-- 这里补列、放宽旧列，并按历史 tool_version 尽力回填可读名字；旧行保持可查。
alter table tool_audit_logs add column if not exists tool_name text;
alter table tool_audit_logs alter column tool_version_id drop not null;

update tool_audit_logs ta
   set tool_name = t.key
  from tool_versions tv
  join tools t on t.tenant_id = tv.tenant_id and t.id = tv.tool_id
 where ta.tenant_id = tv.tenant_id
   and ta.tool_version_id = tv.id
   and ta.tool_name is null;

-- 新写入必须带工具名；旧行在回填后同样满足，无法回填的（工具版本已删）保持可读的兜底。
alter table tool_audit_logs drop constraint if exists tool_audit_logs_tool_name_shape;
alter table tool_audit_logs add constraint tool_audit_logs_tool_name_shape
  check (tool_name is not null or tool_version_id is not null);

create index if not exists tool_audit_logs_tool_name_idx
  on tool_audit_logs (tenant_id, tool_name, occurred_at desc);
