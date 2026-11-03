-- 同事一对一私聊（docs/SDD/规格文档/26-11-03 人与人聊天.md）。
-- 不写入 sessions / messages，不产生 Run。PC 对话列表仍只读 conversation-targets。

create table direct_conversations (
  id text primary key,
  tenant_id text not null references tenants(id),
  user_low text not null,
  user_high text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null,
  check (user_low < user_high),
  unique (tenant_id, user_low, user_high),
  unique (tenant_id, id),
  foreign key (tenant_id, user_low) references users(tenant_id, id),
  foreign key (tenant_id, user_high) references users(tenant_id, id),
  foreign key (tenant_id, created_by) references users(tenant_id, id)
);

create index direct_conversations_by_activity
  on direct_conversations (tenant_id, last_message_at desc, id desc);

comment on table direct_conversations is
  'One direct conversation per employee pair. Not a workspace session and never an Agent run.';

create table direct_conversation_participants (
  tenant_id text not null references tenants(id),
  conversation_id text not null,
  user_id text not null,
  hidden_at timestamptz,
  primary key (tenant_id, conversation_id, user_id),
  foreign key (tenant_id, conversation_id) references direct_conversations(tenant_id, id),
  foreign key (tenant_id, user_id) references users(tenant_id, id)
);

comment on table direct_conversation_participants is
  'Per-participant list visibility. hidden_at hides the row only for that user until the other person sends again.';

create table direct_messages (
  id text primary key,
  tenant_id text not null references tenants(id),
  conversation_id text not null,
  sender_user_id text not null,
  content text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, conversation_id) references direct_conversations(tenant_id, id),
  foreign key (tenant_id, sender_user_id) references users(tenant_id, id)
);

create index direct_messages_by_conversation
  on direct_messages (tenant_id, conversation_id, created_at desc, id desc);

comment on table direct_messages is
  'Append-only direct-message text. No role, run, or agent version.';

alter table conversation_read_states drop constraint if exists conversation_read_states_target_type_check;
alter table conversation_read_states
  add constraint conversation_read_states_target_type_check
  check (target_type in ('agent', 'group', 'peer'));

comment on table conversation_read_states is
  'Per user per conversation target. agent = personal chats by agent, group = team workspace, peer = the other user in a direct conversation. Unread counts messages from others after last_read_at.';
