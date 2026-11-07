-- 钉钉企业内部应用配置改在管理端“钉钉集成”页填写（2026-11-06）：CorpId、AgentId、AppKey、AppSecret 与
-- 钉钉会话有效期、待绑定凭证有效期、每日代绑上限、接口超时。AppSecret 不存本表：页面保存的值以
-- DSH_CREDENTIAL_MASTER_KEY 加密存入 credential_secrets（credential_ref 指向它），仍来自部署配置
-- DSH_WORK_DINGTALK_* 时 credential_ref 为空、只在内存中使用。部署配置只在页面从未保存过时作为初始配置。
create table dingtalk_app_configurations (
  tenant_id text primary key references tenants(id),
  status text not null check (status in ('configured', 'cleared')),
  source text not null check (source in ('deployment-config', 'admin')),
  corp_id text,
  agent_id text,
  app_key text,
  credential_ref text,
  -- AppSecret 后 4 位，只用于界面识别是哪一份密钥。
  secret_hint text,
  session_ttl_seconds integer not null default 43200 check (session_ttl_seconds between 300 and 2592000),
  binding_ticket_ttl_seconds integer not null default 300 check (binding_ticket_ttl_seconds between 60 and 3600),
  admin_daily_bind_limit integer not null default 50 check (admin_daily_bind_limit between 1 and 10000),
  timeout_ms integer not null default 10000 check (timeout_ms between 1000 and 60000),
  updated_by text,
  updated_at timestamptz not null default now(),
  check (status = 'cleared' or (corp_id is not null and agent_id is not null and app_key is not null))
);
