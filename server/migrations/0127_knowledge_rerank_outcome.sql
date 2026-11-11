-- 企业知识库优化方案 O5（docs/design/weknora-knowledge-optimization-plan.md）。
--
-- WeKnora 重排序降级（模型不可用、调用失败）时检索照常返回，平台此前不记录，管理员无从得知。
-- 记录最近一次检索响应中的重排序结果（meta.rerank.outcome）与时间，供管理端健康状态显示。
alter table external_knowledge_connections
  add column if not exists last_rerank_outcome text
    check (last_rerank_outcome is null or last_rerank_outcome ~ '^[a-z0-9_]{1,40}$'),
  add column if not exists last_rerank_at timestamptz;
