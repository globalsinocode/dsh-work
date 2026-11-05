-- 钉钉接入方案（docs/design/dingtalk-integration-plan.md）DT-S1：账号绑定与 dingtalk 会话来源（4.2、4.3、第 5 节）。
--
-- 外部账号绑定按“外部渠道”通用设计（DT5），本期只有 channel = 'dingtalk'。“未绑定”即没有有效记录；
-- 状态只有 valid / invalid（DT29）。两侧在有效记录中各自唯一。
create table external_account_bindings (
  id text primary key,
  tenant_id text not null references tenants(id),
  channel text not null check (channel in ('dingtalk')),
  user_id text not null,
  external_user_id text not null check (length(external_user_id) between 1 and 128),
  external_union_id text,
  -- 绑定时钉钉返回的姓名与部门，只用于界面显示与核对，不作为身份依据。
  external_display_name text,
  external_department text,
  bound_by text not null check (bound_by in ('self', 'admin')),
  bound_by_admin_id text,
  status text not null check (status in ('valid', 'invalid')),
  bound_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoke_reason text,
  -- 管理员解绑时可锁定自行绑定（失效记录上的标记，不新增状态）。
  self_rebind_locked boolean not null default false,
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, user_id) references users(tenant_id, id),
  check ((bound_by = 'admin') = (bound_by_admin_id is not null)),
  check ((status = 'valid') = (revoked_at is null)),
  check (status = 'invalid' or not self_rebind_locked)
);
create unique index external_account_bindings_valid_user
  on external_account_bindings (tenant_id, channel, user_id) where status = 'valid';
create unique index external_account_bindings_valid_external
  on external_account_bindings (tenant_id, channel, external_user_id) where status = 'valid';
create index external_account_bindings_user on external_account_bindings (tenant_id, user_id, bound_at desc);

-- 服务端保存的短时单次凭证：钉钉内待绑定凭证（self-bind）与管理员代绑确认凭证（admin-confirm）。
-- 只存哈希；客户端只能回传凭证，不能指定钉钉 userid。
create table external_binding_tickets (
  ticket_hash text primary key,
  tenant_id text not null references tenants(id),
  channel text not null check (channel in ('dingtalk')),
  purpose text not null check (purpose in ('self-bind', 'admin-confirm')),
  external_user_id text not null,
  external_union_id text,
  external_display_name text,
  external_department text,
  corp_id text not null,
  request_origin text,
  target_user_id text,
  actor_id text,
  -- 代绑确认凭证：钉钉姓名与平台姓名不一致时须再次勾选“我已核实是本人”；手机号只存脱敏号码与哈希。
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check ((purpose = 'self-bind') = (request_origin is not null)),
  check ((purpose = 'admin-confirm') = (target_user_id is not null and actor_id is not null))
);
create index external_binding_tickets_expiry on external_binding_tickets (expires_at);

-- 0077 的 authentication_provider 列内检查名称由数据库自动生成，这里按实际名称删除后以固定名称重建；
-- 只匹配列内取值检查，不误删按来源约束凭据列的 authentication_session_credentials。
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'authentication_sessions'::regclass
       and c.contype = 'c'
       and c.conname <> 'authentication_session_credentials'
       and pg_get_constraintdef(c.oid) ilike '%authentication_provider%'
  loop
    execute format('alter table authentication_sessions drop constraint %I', constraint_name);
  end loop;
end $$;

alter table authentication_sessions
  add column binding_id text references external_account_bindings(id),
  add constraint authentication_sessions_provider_check
    check (authentication_provider in ('ai-hub-oidc', 'local-password', 'dingtalk'));

alter table authentication_sessions drop constraint authentication_session_credentials;
alter table authentication_sessions add constraint authentication_session_credentials check (
  (authentication_provider = 'ai-hub-oidc' and access_token_encrypted is not null and token_expires_at is not null and binding_id is null)
  or (authentication_provider = 'local-password' and access_token_encrypted is null and refresh_token_encrypted is null and token_expires_at is null and binding_id is null)
  or (authentication_provider = 'dingtalk' and access_token_encrypted is null and refresh_token_encrypted is null and token_expires_at is null and binding_id is not null)
);
create index authentication_sessions_binding on authentication_sessions (binding_id) where binding_id is not null and revoked_at is null;
