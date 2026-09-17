-- AG-03 轻量自动任务：任务配置与最小触发记录。
-- 设计依据 docs/design/automation-implementation-plan.md §4：
--   - 执行状态不存第二份 running/succeeded/failed，经 run_id 读 Run；
--   - accepted 记录与 Session/Run 同事务生成，skipped/missed 不创建 Run；
--   - 重叠判定在任务行锁内查询受理记录完成，不依赖活动状态唯一索引。

create table agent_automations (
  id text primary key,
  tenant_id text not null references tenants(id),
  owner_user_id text not null,
  name text not null check (char_length(name) between 1 and 120),
  agent_version_id text not null,
  workspace_id text not null,
  -- schedule 为唯一时区权威存储：{kind:'manual'|'daily'|'weekly', timeOfDay?, weekdays?, timezone}
  schedule jsonb not null,
  schedule_revision integer not null default 1 check (schedule_revision > 0),
  -- 本规则下一次未处理槽位（UTC）；manual 任务为 null。
  next_slot_utc timestamptz,
  input_template jsonb not null,
  -- 启用时批准的授权上限快照：{roleIds: string[], dataScopes: string[]}
  scope_ceiling jsonb not null default '{}'::jsonb,
  -- 最近一次本人确认通过的规范化执行配置摘要；未确认为空串。
  confirmed_config_revision text not null default '',
  revision integer not null default 1 check (revision > 0),
  status text not null default 'draft' check (status in ('draft', 'enabled', 'paused', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, owner_user_id) references users(tenant_id, id),
  foreign key (tenant_id, agent_version_id) references agent_versions(tenant_id, id),
  foreign key (tenant_id, workspace_id) references workspaces(tenant_id, id)
);

create index agent_automations_by_owner
  on agent_automations (tenant_id, owner_user_id, created_at desc);

-- 触发扫描按 enabled + 到期槽位取任务。
create index agent_automations_due
  on agent_automations (tenant_id, next_slot_utc)
  where status = 'enabled' and next_slot_utc is not null;

create table automation_executions (
  id text primary key,
  tenant_id text not null references tenants(id),
  automation_id text not null,
  -- 定时：sha256(automation_id | schedule_revision | planned_slot_utc)
  -- 手动：sha256(automation_id | 'manual' | 请求幂等键)
  trigger_id text not null,
  kind text not null check (kind in ('scheduled', 'manual', 'missed')),
  planned_slot_utc timestamptz,
  missed_from_utc timestamptz,
  missed_to_utc timestamptz,
  task_revision integer not null,
  schedule_revision integer not null,
  -- 手动请求规范化指纹：同 trigger_id 异请求拒绝。
  request_fingerprint text,
  -- 受理时冻结的执行配置：版本/身份/Workspace/授权上限/输入引用。
  execution_config jsonb not null default '{}'::jsonb,
  session_id text,
  run_id text,
  admission_status text not null check (admission_status in ('accepted', 'skipped', 'interrupted')),
  reason_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, automation_id, trigger_id),
  foreign key (tenant_id, automation_id) references agent_automations(tenant_id, id),
  foreign key (tenant_id, session_id) references sessions(tenant_id, id),
  foreign key (tenant_id, run_id) references runs(tenant_id, id),
  check (
    (kind = 'missed' and missed_from_utc is not null and missed_to_utc is not null)
    or (kind in ('scheduled', 'manual') and planned_slot_utc is not null)
  ),
  check (
    (admission_status = 'accepted' and session_id is not null and run_id is not null)
    or (admission_status in ('skipped', 'interrupted'))
  )
);

-- 非空 Session/Run 关联唯一：同一执行不能换绑，不同执行不能共享 Run。
create unique index automation_executions_session_unique
  on automation_executions (tenant_id, session_id) where session_id is not null;
create unique index automation_executions_run_unique
  on automation_executions (tenant_id, run_id) where run_id is not null;

create index automation_executions_by_automation
  on automation_executions (tenant_id, automation_id, created_at desc);
