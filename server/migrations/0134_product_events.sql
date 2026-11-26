-- 使用情况（docs/design/error-tracking-usage-plan.md，OBS-S2，OB8）：页面访问。
-- 只记已登录员工切换到了哪个页面（路由名）、哪一端、是否在钉钉内打开；不记网址、查询参数与页面内容。
-- 同一员工同一端同一页面 30 分钟内只记一次；保留 180 天，由错误记录的清理任务一并分批删除。

create table if not exists product_events (
  id bigserial primary key,
  tenant_id text not null references tenants(id),
  user_id text not null,
  app text not null check (app in ('workbench', 'admin')),
  page text not null check (char_length(page) between 1 and 120),
  in_dingtalk boolean not null default false,
  occurred_at timestamptz not null default now(),
  foreign key (tenant_id, user_id) references users(tenant_id, id)
);

create index if not exists product_events_by_time on product_events (tenant_id, occurred_at);
create index if not exists product_events_by_user on product_events (tenant_id, user_id, app, page, occurred_at desc);
