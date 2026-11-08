-- 输入预检（数据防护方案 5.6.1、5.9，DLP-S2）。
-- 被拦截的消息标记为未发送给模型，之后构建会话历史时排除（D10）。
alter table messages add column not_sent_to_model boolean not null default false;

-- 每次拦截一条。只记录入口与次数，不保存原值、原值哈希或上下文（D8）。
create table data_protection_input_blocks (
  id text primary key,
  tenant_id text not null references tenants(id),
  user_id text not null,
  entry text not null check (entry in ('conversation', 'task-execution', 'automation-save', 'automation-trigger')),
  session_id text,
  secret_count integer not null check (secret_count > 0),
  created_at timestamptz not null default now()
);

create index data_protection_input_blocks_time on data_protection_input_blocks (tenant_id, created_at);
