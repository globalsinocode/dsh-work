-- 站内通知方案（docs/design/notification-center-plan.md）NC-S1：与本人相关事件的通知记录。
--
-- 每行是“告诉某位员工发生了一件与他有关的事”。与产生它的业务变更在同一事务中写入，
-- 按 (tenant_id, recipient_user_id, dedupe_key) 去重，幂等重放不重复登记。只存对象 ID 与
-- 代码值，名称在读取时按接收人当前权限解析，失权后不再返回名称。钉钉等外部推送渠道
-- 以后以本表 id 为来源投递（方案 6.1），不另建事件判断。
--
-- message_mentions 保留（群组“[有人@我]”仍用它），@ 通知是同事务另写的一行；
-- 打开群组标记 @ 已读时同步本表。不回填历史：上线前的事件不补造通知。

create table if not exists user_notifications (
  id text primary key,
  tenant_id text not null references tenants(id),
  recipient_user_id text not null,
  kind text not null check (kind in (
    'mention',
    'task_assigned',
    'task_completed',
    'workspace_member_added'
  )),
  workspace_id text,
  object_type text not null check (object_type in ('message', 'project_task', 'workspace')),
  object_id text not null,
  actor_user_id text,
  safe_metadata jsonb not null default '{}'::jsonb,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (tenant_id, recipient_user_id, dedupe_key),
  foreign key (tenant_id, recipient_user_id) references users(tenant_id, id),
  foreign key (tenant_id, actor_user_id) references users(tenant_id, id),
  foreign key (tenant_id, workspace_id) references workspaces(tenant_id, id)
);

comment on table user_notifications is
  'Notification center (NC-S1): one row per (recipient, business occurrence) that concerns that employee. Written in the SAME transaction as the business change. Readers re-check visibility and resolve names at read time; rows never carry names or bodies.';

comment on column user_notifications.object_id is
  'Safe reference to the jump target (message / project task / workspace id). Never a name.';

comment on column user_notifications.safe_metadata is
  'Code values only (e.g. sessionId for a mention). Never names, message text or review reasons.';

comment on column user_notifications.read_at is
  'Null = unread. Set by the recipient (single / read-all), and for mentions also when the group is marked read.';

create index if not exists user_notifications_feed
  on user_notifications (tenant_id, recipient_user_id, created_at desc, id desc);

create index if not exists user_notifications_unread
  on user_notifications (tenant_id, recipient_user_id)
  where read_at is null;

create index if not exists user_notifications_by_object
  on user_notifications (tenant_id, kind, object_id);
