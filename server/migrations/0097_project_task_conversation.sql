-- 项目空间 S3（docs/design/project-space-plan.md 第 10 节）：统一任务与任务对话。
-- 员工任务与 Agent 任务一样在创建时就有任务对话（团队会话）；员工任务的状态推进、
-- 完成与改派写入任务事件，在任务对话中作为系统记录展示（不进入 Agent 的对话历史）。

-- 员工任务也绑定任务对话：承接者形状不再约束 session_id。
alter table project_tasks drop constraint project_tasks_assignee_shape;
alter table project_tasks add constraint project_tasks_assignee_shape check (
  (assignee_type = 'employee' and assignee_user_id is not null and assignee_agent_member_id is null)
  or (assignee_type = 'agent' and assignee_agent_member_id is not null and assignee_user_id is null)
);

-- 任务事件：员工任务的状态变更、完成与同类改派。Agent 的执行记录由 runs 推算，不在此登记。
create table project_task_events (
  id text primary key,
  tenant_id text not null references tenants(id),
  task_id text not null,
  -- 事件发生时任务所在的任务对话；改派到新对话后，旧对话的事件不随之迁移。
  session_id text,
  kind text not null check (kind in ('status_changed', 'completed', 'reassigned')),
  actor_user_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, task_id) references project_tasks(tenant_id, id),
  foreign key (tenant_id, session_id) references sessions(tenant_id, id),
  foreign key (tenant_id, actor_user_id) references users(tenant_id, id)
);

create index project_task_events_task_idx on project_task_events (tenant_id, task_id, created_at);
