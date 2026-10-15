# Admin 会话受众隔离修复

基线：上一轮四补丁的结果树 `0fe08c5bc01c2c168fdbc5c302fb5456ba5c6479`。当前连接器仍返回 3015d241；没有取得用户本地 TW-10/AG-03 合并源码。

改动：requireSession 的 admin 入口先返回独立的本人/受众/状态/有效身份查询，不关联 Workspace。workbench 查询体逐字不变；上层管理员角色检查保留。返回值按受众区分 nullable Workspace 与 Agent。

红灯：旧四补丁基线在停用管理员用例为 5 通过/1 失败。按用户报告仅向旧共用查询注入 workspace INNER JOIN，空空间 admin 用例失败；这是假设性故障注入，不冒充取得了 TW-10 源码。修复后保留该 JOIN 的测试 6/6 通过，然后撤去注入，最终补丁不改 workbench SQL。

绿灯：专项 + admin-skill-installation + review-a2 集成共 20 通过，0 失败，1 个真实 DSH 专项跳过。服务器 tsc --noEmit 通过。测试使用合成数据与可丢弃 PostgreSQL 17.11。

接线：server/package.json、根脚本 test:review:batch02:integration 和 CI 显式执行。迁移：无。保留所有 TW-10 工作空间查询与 AG-03 purpose 分支；在用户新主线上的完整回归、真实 DSH/身份联调未运行。
