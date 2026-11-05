-- 钉钉接入方案 DT-S1 管理端（4.2 方式二、“解绑与失效”、8.1）：代绑与解绑的站内通知、集成连接检查、
-- 每日离职检查。

-- 新增三类站内通知（站内通知方案第 6 节同步）。它们只关乎员工本人的账号，不可在偏好中关闭：
--   dingtalk_bound_by_admin   管理员已为你绑定钉钉账号
--   dingtalk_binding_revoked  你的钉钉绑定已被管理员解除或改绑到其他员工
--   dingtalk_bind_reminder    管理员提醒你在钉钉中打开 dsh-work 登录一次完成绑定
-- 对象类型 dingtalk_binding：object_id 为绑定 ID（提醒为接收人自己的用户 ID）；钉钉姓名在读取时取自绑定记录。
alter table user_notifications drop constraint user_notifications_kind_check;
alter table user_notifications add constraint user_notifications_kind_check check (kind in (
  'mention',
  'task_assigned',
  'task_completed',
  'workspace_member_added',
  'task_schedule_stopped',
  'automation_failed',
  'skill_review_result',
  'dingtalk_bound_by_admin',
  'dingtalk_binding_revoked',
  'dingtalk_bind_reminder'
));

alter table user_notifications drop constraint user_notifications_object_type_check;
alter table user_notifications add constraint user_notifications_object_type_check check (
  object_type in ('message', 'project_task', 'workspace', 'automation', 'skill_submission', 'dingtalk_binding')
);

-- “钉钉集成”页的连接检查结果（不含凭据）。
create table external_channel_status (
  tenant_id text not null references tenants(id),
  channel text not null check (channel in ('dingtalk')),
  checked_at timestamptz,
  status text check (status in ('ok', 'configuration_error', 'unavailable')),
  -- 各项接口权限的检查结果：{ "credentials": "ok" | "denied" | "unknown", ... }
  capabilities jsonb not null default '{}'::jsonb,
  message text,
  checked_by text,
  primary key (tenant_id, channel)
);

-- 每日离职检查（4.2“解绑与失效”）。只有明确“用户不存在”才判为离职；超过有效绑定 10% 时整批暂停，
-- 待管理员确认后执行；失败数与错误码分布用于“离职检查异常”提醒。
create table dingtalk_departure_checks (
  id text primary key,
  tenant_id text not null references tenants(id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null check (status in ('running', 'completed', 'paused', 'confirmed', 'dismissed', 'configuration_error', 'failed')),
  checked_count integer not null default 0,
  departed_count integer not null default 0,
  failed_count integer not null default 0,
  bound_count integer not null default 0,
  error_codes jsonb not null default '{}'::jsonb,
  -- 暂停时待确认失效的绑定 ID；确认或忽略后保留作记录。
  pending_binding_ids text[] not null default '{}',
  decided_by text,
  decided_at timestamptz
);
create index dingtalk_departure_checks_recent on dingtalk_departure_checks (tenant_id, started_at desc);
-- 同一时刻只允许一个进行中的检查。
create unique index dingtalk_departure_checks_single_running on dingtalk_departure_checks (tenant_id) where status = 'running';
