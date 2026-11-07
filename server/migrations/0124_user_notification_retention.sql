-- 站内通知方案 NC-S4：保留清扫按产生时间删除 90 天前的通知（方案 NC4），按时间建索引，
-- 避免每日清扫全表扫描。只加索引，不改数据。

create index if not exists user_notifications_retention
  on user_notifications (created_at);
