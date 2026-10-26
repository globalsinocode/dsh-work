-- 项目空间 S1（docs/design/project-space-plan.md 第 4～6 节）：项目简报、项目任务
-- 及任务引用的文件。表名沿用 workspace / project 前缀，不复用执行层 tasks 表。

-- 项目简报：每次保存新增一个版本，最新版本即当前简报；不覆盖历史版本。
create table workspace_brief_versions (
  id text primary key,
  tenant_id text not null references tenants(id),
  workspace_id text not null,
  version_no integer not null check (version_no > 0),
  content text not null check (length(content) between 1 and 8000),
  due_date date,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, workspace_id, version_no),
  foreign key (tenant_id, workspace_id) references workspaces(tenant_id, id),
  foreign key (tenant_id, created_by) references users(tenant_id, id)
);

-- 项目任务：承接者是一位员工成员或一个 Agent 成员。Agent 任务即任务线程
-- （session_id），状态由线程最近一次 Run 推算，status 列只对员工任务有意义。
create table project_tasks (
  id text primary key,
  tenant_id text not null references tenants(id),
  workspace_id text not null,
  title text not null check (length(title) between 1 and 120),
  description text not null default '' check (length(description) <= 4000),
  created_by text not null,
  assignee_type text not null check (assignee_type in ('employee', 'agent')),
  assignee_user_id text,
  assignee_agent_member_id text,
  session_id text,
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'done')),
  completion_note text check (completion_note is null or length(completion_note) <= 4000),
  completed_by text,
  completed_at timestamptz,
  due_date date,
  removed_at timestamptz,
  removed_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, workspace_id) references workspaces(tenant_id, id),
  foreign key (tenant_id, created_by) references users(tenant_id, id),
  foreign key (tenant_id, assignee_user_id) references users(tenant_id, id),
  foreign key (tenant_id, session_id) references sessions(tenant_id, id),
  constraint project_tasks_assignee_shape check (
    (assignee_type = 'employee' and assignee_user_id is not null and assignee_agent_member_id is null and session_id is null)
    or (assignee_type = 'agent' and assignee_agent_member_id is not null and assignee_user_id is null)
  )
);

-- 一个任务线程只属于一个项目任务。
create unique index project_tasks_session_unique on project_tasks (tenant_id, session_id) where session_id is not null;
create index project_tasks_workspace_idx on project_tasks (tenant_id, workspace_id, created_at desc) where removed_at is null;

-- 任务引用的文件固定到具体文件对象（共享文件的某个版本）。
-- input：执行输入（Agent 任务）；deliverable：员工完成任务时附上的共享文件。
create table project_task_files (
  tenant_id text not null references tenants(id),
  task_id text not null,
  file_object_id text not null,
  purpose text not null check (purpose in ('input', 'deliverable')),
  position integer not null check (position >= 0),
  primary key (tenant_id, task_id, purpose, file_object_id),
  foreign key (tenant_id, task_id) references project_tasks(tenant_id, id),
  foreign key (tenant_id, file_object_id) references file_objects(tenant_id, id)
);

-- 动态：新增简报更新、任务创建与员工任务完成。
alter table workspace_activity_events drop constraint workspace_activity_events_kind_check;
alter table workspace_activity_events add constraint workspace_activity_events_kind_check check (kind in (
  'member_added',
  'member_removed',
  'member_exit',
  'role_changed',
  'owner_transferred',
  'agent_member_added',
  'agent_member_removed',
  'file_uploaded',
  'file_removed',
  'file_version_added',
  'workspace_archived',
  'workspace_restored',
  'brief_updated',
  'project_task_created',
  'project_task_completed'
));
alter table workspace_activity_events drop constraint workspace_activity_events_object_type_check;
alter table workspace_activity_events add constraint workspace_activity_events_object_type_check
  check (object_type in ('member', 'agent_member', 'file', 'workspace', 'brief', 'project_task'));
