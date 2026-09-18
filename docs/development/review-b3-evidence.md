# B3 个人历史对话：实现与证据

基线：已交付八个补丁；0042/0043 为用户确认后的迁移编号。本次新增 0044 索引，不改旧迁移。

- 现有 PostgresConversationRepository 增加 listSessionsForUser/getSessionForUser，共用 queryUserSessions；与内容/空间查询复用 readableWorkspacePredicate。未改 admin requireSession，未改团队列表与旧 Run API。全局本人历史不等于 TW-10 共享会话目录。
- GET /sessions 支持 scope、名称、游标、limit；先过滤身份、作者、空间，再分页。GET /sessions/:id 是稳定入口，空会话可继续、旧 Run 可恢复。前端 /history 不依赖最近 50 Run；原对话页按 Run ID 重新读取，不仅查 Store。
- RED：同一 HTTP 回归在旧基线上 5 项失败（新 GET 路由不存在，404）；65 Run + 5 Session 的样例证明缺失。
- GREEN：review-b3-history.integration.test.ts 5/5；团队历史与 admin 会话相邻 12/12；共享分页请求生命周期 3/3；服务端/员工端类型检查、定向 ESLint 通过。
- 浏览器预演与 E2E 在 D12 完整页面集成后运行；本提交不将组件/HTTP 测试称为浏览器验收。真实 DSH/OIDC 未运行。
- 索引只是加速；没有删除或迁移 Session/Run。API 默认 scope=personal，历史页面选择 scope=all，旧个人/团队链接保留。
