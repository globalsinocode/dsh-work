-- 模型用量改用模型网关计量（模型路由方案 4.6、MR-S3；模型用量页改版）。
--
-- 运行结束时按网关逐次请求记录汇总用量：对话与联网搜索各写一行（endpoint），记录实际模型、
-- 请求次数（含重试）、失败次数与缓存读写 token。没有网关记录时（网关上线前的运行、测试替身）
-- 沿用 DSH 会话日志或按文本长度估算，measurement 说明来源；estimated 与之保持一致，供旧读者使用。
--
-- 缓存字段为 null 表示厂商未返回（不记为 0，避免把“未知”统计成“未命中”）。
-- 输入、输出 token 保持非空：网关上没有任何请求返回用量时记 0（被中止的流式请求会少计）。

alter table model_usage_events
  add column if not exists endpoint text not null default 'chat'
    check (endpoint in ('chat', 'search')),
  add column if not exists measurement text not null default 'estimated'
    check (measurement in ('gateway', 'session-log', 'estimated')),
  add column if not exists cache_read_tokens bigint
    check (cache_read_tokens is null or cache_read_tokens >= 0),
  add column if not exists cache_write_tokens bigint
    check (cache_write_tokens is null or cache_write_tokens >= 0),
  add column if not exists request_count integer
    check (request_count is null or request_count >= 0),
  add column if not exists failed_request_count integer
    check (failed_request_count is null or failed_request_count >= 0);

-- 既有记录：非估算的都来自 DSH 会话日志。
update model_usage_events set measurement = 'session-log' where not estimated;

-- 取消的运行也记录已在网关上发生的消耗。
alter table model_usage_events drop constraint if exists model_usage_events_status_check;
alter table model_usage_events add constraint model_usage_events_status_check
  check (status in ('success', 'failed', 'blocked', 'cancelled'));

-- 每个 Attempt 每种请求类型至多一行（对话一行、联网搜索一行）。
drop index if exists model_usage_by_attempt;
create unique index if not exists model_usage_by_attempt_endpoint
  on model_usage_events (tenant_id, attempt_id, endpoint);

comment on index model_usage_by_attempt_endpoint is
  'At most one usage fact per attempt and endpoint (chat, search). The writer''s deterministic ids (usage-<attemptId>, usage-<attemptId>-search) plus on conflict (id) do nothing stop replays; this index rejects a repeated attempt under a different id. Aggregates that count executions use count(distinct attempt_id).';

-- 运营事件视图（0012）：模型调用每次执行一条（只取对话行），取消的执行映射为审计允许的结果。
-- 按时间查询沿用 0001 的 model_usage_by_time 索引。
create or replace view operational_events as
select
  ae.id,
  ae.tenant_id,
  ae.occurred_at,
  case
    when ae.object_type = 'authorization' then 'security'
    else 'management'
  end as category,
  ae.action,
  ae.object_type,
  ae.object_id,
  ae.actor_type,
  ae.actor_id,
  ae.result,
  ae.trace_id,
  case when ae.object_type = 'run' then ae.object_id else null end as run_id,
  null::text as attempt_id,
  ae.safe_context
from audit_events ae

union all

select
  mu.id,
  mu.tenant_id,
  mu.occurred_at,
  'model' as category,
  'model.invoke' as action,
  'model' as object_type,
  mu.provider || '/' || mu.model as object_id,
  'user' as actor_type,
  r.requested_by as actor_id,
  -- 审计结果只允许 success/failed/blocked；取消的执行与运行事件口径一致记为 success，原状态放在上下文里。
  case when mu.status = 'cancelled' then 'success' else mu.status end as result,
  mu.trace_id,
  mu.run_id,
  mu.attempt_id,
  jsonb_build_object(
    'provider', mu.provider,
    'model', mu.model,
    'inputTokens', mu.input_tokens,
    'outputTokens', mu.output_tokens,
    'latencyMs', mu.latency_ms,
    'costAmount', mu.cost_amount,
    'costCurrency', mu.cost_currency,
    'estimated', mu.estimated,
    'status', mu.status,
    'requestCount', mu.request_count
  ) as safe_context
from model_usage_events mu
join runs r on r.tenant_id = mu.tenant_id and r.id = mu.run_id
-- 每次执行一条模型调用事件：联网搜索行不重复出现。
where mu.endpoint = 'chat'

union all

select
  ta.id,
  ta.tenant_id,
  ta.occurred_at,
  'tool' as category,
  'tool.permission.resolve' as action,
  'tool' as object_type,
  ta.tool_name as object_id,
  'user' as actor_type,
  ta.actor_user_id as actor_id,
  ta.result,
  ta.trace_id,
  ta.run_id,
  ta.attempt_id,
  ta.parameter_summary as safe_context
from tool_audit_logs ta

union all

select
  re.id,
  re.tenant_id,
  re.occurred_at,
  'run' as category,
  re.event_type as action,
  'run' as object_type,
  re.run_id as object_id,
  case when re.event_type in ('run.failed', 'run.completed', 'run.cancelled') then 'system' else 'user' end as actor_type,
  case when re.event_type in ('run.failed', 'run.completed', 'run.cancelled') then 'system' else r.requested_by end as actor_id,
  case
    when re.event_type = 'run.failed' then 'failed'
    when re.event_type = 'approval.required' then 'blocked'
    else 'success'
  end as result,
  re.trace_id,
  re.run_id,
  re.attempt_id,
  re.safe_metadata as safe_context
from run_events re
join runs r on r.tenant_id = re.tenant_id and r.id = re.run_id

union all

select
  av.id,
  av.tenant_id,
  av.created_at,
  'artifact' as category,
  'artifact.version.created' as action,
  'artifact' as object_type,
  av.artifact_id as object_id,
  'user' as actor_type,
  a.created_by as actor_id,
  'success' as result,
  coalesce(last_event.trace_id, 'trace-artifact-' || av.id) as trace_id,
  av.source_run_id as run_id,
  last_event.attempt_id,
  jsonb_build_object(
    'version', av.version_no,
    'fileObjectId', av.file_object_id,
    'artifactName', a.name,
    'artifactType', a.artifact_type
  ) as safe_context
from artifact_versions av
join artifacts a on a.tenant_id = av.tenant_id and a.id = av.artifact_id
left join lateral (
  select re.trace_id, re.attempt_id
    from run_events re
   where re.tenant_id = av.tenant_id and re.run_id = av.source_run_id
   order by re.sequence desc
   limit 1
) last_event on true;
