-- 员工端双模式 S5c（docs/design/project-space-plan.md 12.6）：协作模式对话列表按对话对象取
-- 最后一条消息预览，按会话取最新消息需要 (session_id, created_at) 索引。

create index if not exists messages_by_session_recent
  on messages (tenant_id, session_id, created_at desc, id desc);
