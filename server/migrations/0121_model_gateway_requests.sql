-- 模型网关请求记录（模型路由方案 4.6、4.7；数据防护方案 5.2、DLP-S1）。
-- 每个经网关的模型请求一条：用于用量计量（含缓存读写 token）与 Attempt 失败分类。
-- 只记录状态码、来源与厂商错误码，不保存请求或回复正文、令牌与厂商密钥。
create table model_gateway_requests (
  id text primary key,
  tenant_id text not null references tenants(id),
  run_id text not null,
  attempt_id text not null,
  route_id text not null,
  provider_key text not null,
  -- 请求中声明的模型；与路由不符被拒绝时也如实记录。
  model_key text not null,
  endpoint text not null check (endpoint in ('chat', 'search')),
  -- gateway：网关自身拒绝；upstream：厂商返回；transport：连接失败或超时。
  origin text not null check (origin in ('gateway', 'upstream', 'transport')),
  outcome text not null check (outcome in ('succeeded', 'failed', 'aborted')),
  http_status integer,
  -- 网关拒绝时为平台错误码；厂商错误时为厂商返回的错误码或类型（截断）。
  error_code text,
  input_tokens integer,
  output_tokens integer,
  -- 厂商未返回缓存用量时为 null，不记为 0（模型路由方案 4.6）。
  cache_read_tokens integer,
  cache_write_tokens integer,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  check (input_tokens is null or input_tokens >= 0),
  check (output_tokens is null or output_tokens >= 0),
  check (cache_read_tokens is null or cache_read_tokens >= 0),
  check (cache_write_tokens is null or cache_write_tokens >= 0)
);

create index model_gateway_requests_attempt on model_gateway_requests (tenant_id, attempt_id, finished_at);
