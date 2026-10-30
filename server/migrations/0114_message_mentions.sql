-- 项目空间方案 D38：群聊（B）与共享讨论（A）中 @ 同事的站内提醒。
--
-- 每行是“一条消息 @ 了一位同事”。与消息同一事务写入，只登记发送时仍是现任成员的同事
-- （不含发送者本人）；主键按“消息 + 接收人”去重，幂等重放不重复登记。读取时重查成员身份，
-- 失权后不再显示。read_at 是本人对这条提醒的已读时间，与对话对象已读位置
-- （conversation_read_states）和按空间的通知状态（workspace_notification_states）分开，
-- 静音不影响 @ 提醒。钉钉工作通知（钉钉方案 DT-S4）以后从这张表投递。

create table if not exists message_mentions (
  tenant_id text not null references tenants(id),
  message_id text not null references messages(id),
  mentioned_user_id text not null,
  workspace_id text not null,
  session_id text not null,
  sender_user_id text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  primary key (tenant_id, message_id, mentioned_user_id),
  foreign key (tenant_id, mentioned_user_id) references users(tenant_id, id),
  foreign key (tenant_id, sender_user_id) references users(tenant_id, id),
  foreign key (tenant_id, workspace_id) references workspaces(tenant_id, id),
  foreign key (tenant_id, session_id) references sessions(tenant_id, id)
);

comment on table message_mentions is
  'D38 @ member reminder: one row per (message, mentioned colleague). Written in the same transaction as the message, only for colleagues who are current members at send time (never the sender). Readers re-check membership, so a removed member no longer sees reminders.';

comment on column message_mentions.read_at is
  'Null = unread reminder. Opening the group (B) marks the workspace''s reminders read; opening the discussion (A) marks that session''s reminders read. Independent of conversation_read_states and workspace mute.';

create index if not exists message_mentions_unread
  on message_mentions (tenant_id, mentioned_user_id, workspace_id, session_id)
  where read_at is null;

create index if not exists message_mentions_by_message
  on message_mentions (tenant_id, message_id);
