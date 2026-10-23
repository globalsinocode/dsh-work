-- 员工端双模式 S5e（docs/design/project-space-plan.md 12.6，D24 / D29）：协作模式对话列表按对话
-- 对象（单聊的 AI 同事 / 群组）保存本人的已读位置，与按空间的通知已读和静音
-- （workspace_notification_states）分开。

create table if not exists conversation_read_states (
  tenant_id text not null references tenants(id),
  user_id text not null,
  target_type text not null check (target_type in ('agent', 'group')),
  target_id text not null,
  last_read_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id, target_type, target_id),
  foreign key (tenant_id, user_id) references users(tenant_id, id)
);

comment on table conversation_read_states is
  'Per user per conversation target (agent = personal chats aggregated by agent, group = team workspace) read position for the collaboration-mode conversation list. Unread = messages from others created after last_read_at.';

-- 上线前已有的对话视为已读：避免历史消息在上线时全部显示为未读。之后新增的对话对象没有记录，
-- 单聊从头计、群组从本人加入时间计。
insert into conversation_read_states (tenant_id, user_id, target_type, target_id, last_read_at)
select distinct s.tenant_id, s.created_by, 'agent', av.agent_id, now()
  from sessions s
  join workspaces w on w.tenant_id = s.tenant_id and w.id = s.workspace_id
  join agent_versions av on av.tenant_id = s.tenant_id and av.id = s.agent_version_id
 where s.audience = 'workbench' and w.workspace_type = 'personal' and w.created_by = s.created_by
on conflict do nothing;

insert into conversation_read_states (tenant_id, user_id, target_type, target_id, last_read_at)
select m.tenant_id, m.user_id, 'group', m.workspace_id, now()
  from workspace_members m
  join workspaces w on w.tenant_id = m.tenant_id and w.id = m.workspace_id
 where w.workspace_type = 'team'
on conflict do nothing;
