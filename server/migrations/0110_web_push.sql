-- 手机工作台 Web Push：按设备 endpoint 存订阅；通知偏好按账号跨设备一致。

create table push_subscriptions (
  endpoint text primary key,
  tenant_id text not null references tenants(id),
  user_id text not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index push_subscriptions_by_user
  on push_subscriptions (tenant_id, user_id);

create table notification_preferences (
  tenant_id text not null references tenants(id),
  user_id text not null,
  collab_unread boolean not null default true,
  run_finished boolean not null default true,
  primary key (tenant_id, user_id)
);
