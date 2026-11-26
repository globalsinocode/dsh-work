-- 错误记录（docs/design/error-tracking-usage-plan.md，OBS-S1）：
-- 员工端、管理端浏览器上报与服务端 5xx、进程异常按指纹归并为问题（error_groups），
-- 每次发生的样本记在 error_occurrences。不保存请求体、对话正文、查询参数与失败提示原文；
-- 消息与堆栈在服务端脱敏后才入库。样本保留 90 天，由专用清理任务分批删除。

create table if not exists error_groups (
  id text primary key,
  tenant_id text not null references tenants(id),
  fingerprint text not null,
  source text not null check (source in ('workbench', 'admin', 'server', 'process')),
  kind text not null check (kind in ('render', 'script', 'promise', 'api', 'notice', 'load', 'stream', 'http', 'uncaught', 'overflow')),
  message text not null check (char_length(message) <= 1024),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  occurrence_count integer not null default 0 check (occurrence_count >= 0),
  last_release text,
  unique (tenant_id, fingerprint),
  unique (tenant_id, id)
);

create index if not exists error_groups_by_last_seen on error_groups (tenant_id, last_seen_at desc);
create index if not exists error_groups_by_first_seen on error_groups (tenant_id, first_seen_at);

create table if not exists error_occurrences (
  id text primary key,
  tenant_id text not null,
  group_id text not null,
  occurred_at timestamptz not null default now(),
  user_id text,
  release text,
  route text check (route is null or char_length(route) <= 512),
  trace_id text check (trace_id is null or char_length(trace_id) <= 128),
  run_id text check (run_id is null or char_length(run_id) <= 128),
  client text check (client is null or char_length(client) <= 80),
  stack text check (stack is null or char_length(stack) <= 8192),
  repeat_count integer not null default 1 check (repeat_count >= 1),
  foreign key (tenant_id, group_id) references error_groups(tenant_id, id) on delete cascade
);

create index if not exists error_occurrences_by_group on error_occurrences (tenant_id, group_id, occurred_at desc);
create index if not exists error_occurrences_by_time on error_occurrences (tenant_id, occurred_at);
create index if not exists error_occurrences_by_trace on error_occurrences (tenant_id, trace_id) where trace_id is not null;
create index if not exists error_occurrences_by_run on error_occurrences (tenant_id, run_id) where run_id is not null;
create index if not exists error_occurrences_dedupe on error_occurrences (tenant_id, group_id, user_id, occurred_at desc);
