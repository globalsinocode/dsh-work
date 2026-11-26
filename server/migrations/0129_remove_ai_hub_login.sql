-- 删除 AI Hub 登录（docs/design/ai-hub-login-removal-plan.md，AH2、AH6）。
--
-- 登录方式只剩独立账号密码与钉钉免登。生产库已确认没有 AI Hub 用户；开发或测试库若仍有，
-- 迁移失败并提示，不静默删除或改写账号。整个迁移在一个事务中执行，失败即回滚。

-- 1. 清理与检查：残留的 AI Hub 会话直接删除；AI Hub 用户必须先人工处理。
delete from authentication_sessions where authentication_provider = 'ai-hub-oidc';

do $$
declare
  remaining integer;
begin
  select count(*) into remaining from users where identity_provider <> 'local';
  if remaining > 0 then
    raise exception '仍有 % 个 AI Hub 用户：AI Hub 登录已删除，请先处理这些账号（只可能出现在开发或测试库）', remaining
      using hint = 'select id, display_name, business_user, status from users where identity_provider <> ''local''';
  end if;
end $$;

-- 2. 只为 AI Hub 服务的表。
drop table oidc_login_transactions;
drop table application_admin_bootstrap_claims;
drop table identity_directory_sync_state;

-- 3. 会话：先删令牌列（会连带删除引用它们的 authentication_session_credentials），再以同名重建。
alter table authentication_sessions
  drop column access_token_encrypted,
  drop column refresh_token_encrypted,
  drop column token_expires_at,
  alter column authentication_provider drop default;

alter table authentication_sessions drop constraint if exists authentication_session_credentials;
alter table authentication_sessions add constraint authentication_session_credentials check (
  (authentication_provider = 'local-password' and binding_id is null)
  or (authentication_provider = 'dingtalk' and binding_id is not null)
);

alter table authentication_sessions drop constraint authentication_sessions_provider_check;
alter table authentication_sessions add constraint authentication_sessions_provider_check
  check (authentication_provider in ('local-password', 'dingtalk'));

-- 4. 用户：删除 AI Hub 专用索引与列，身份来源只允许 local。
drop index users_ai_hub_login_account_idx;
drop index users_external_identity_unique;
drop index users_business_directory;
create index users_business_directory
  on users (tenant_id, status, display_name, id)
  where business_user;

alter table users
  drop column external_user_id,
  drop column identity_updated_at,
  drop column directory_synced_at;

-- 0016 的 identity_provider 列内检查名称由数据库自动生成：按实际定义查找后删除，再以固定名称重建。
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'users'::regclass
       and c.contype = 'c'
       and pg_get_constraintdef(c.oid) ilike '%identity_provider%'
  loop
    execute format('alter table users drop constraint %I', constraint_name);
  end loop;
end $$;

alter table users add constraint users_identity_provider_check check (identity_provider = 'local');
