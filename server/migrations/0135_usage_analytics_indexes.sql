-- 使用情况（OBS-S2，PR #172 评审）：按发起人查询运行（按人明细、未使用名单的最近一次活跃）。
create index if not exists runs_by_requester on runs (tenant_id, requested_by, created_at desc);
