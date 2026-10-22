-- 员工端双模式 S5a（docs/design/project-space-plan.md 第 12 节，D19）：
-- 界面模式按账号保存为用户偏好，跨设备一致；没有记录即缺省的 A 工作模式。

create table if not exists user_preferences (
  tenant_id text not null,
  user_id text not null,
  ui_mode text not null default 'work' check (ui_mode in ('work', 'collab')),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id),
  foreign key (tenant_id, user_id) references users(tenant_id, id)
);

comment on table user_preferences is
  'Per-user workbench preferences. A row exists only once the user has saved a preference; absent means every default applies.';

comment on column user_preferences.ui_mode is
  'Employee workbench mode: work = A 工作模式 (default), collab = B 协作模式. Only changes the interface; data, rules and permissions are the same in both modes.';
