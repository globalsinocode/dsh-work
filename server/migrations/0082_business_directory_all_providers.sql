-- 2026-10-19 企业员工已从 AI Hub 目录原地迁为本地账号（identity_provider='local'，
-- business_user 保留）。团队空间的成员候选与添加校验必须继续包含他们，因此目录索引
-- 不能再只覆盖 AI Hub 行。
--
-- 重建保持原索引名与列顺序：候选查询按 (display_name, id) 排序分页。
drop index if exists users_business_directory;

create index users_business_directory
  on users (tenant_id, status, display_name, id)
  where business_user;
