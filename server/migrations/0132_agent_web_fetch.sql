-- 读取网页（docs/design/web-fetch-plan.md，WF3）：Agent 版本的“读取网页”开关。
-- 与联网搜索、项目任务管理同一机制，随版本发布、可回滚；默认关闭，已有版本不开启。
alter table agent_versions add column if not exists web_fetch_enabled boolean not null default false;
