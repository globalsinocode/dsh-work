# B5 逻辑移除与保留：实现与证据

- 保留软删除（archived），统一称“移除对话”，响应明确 removedFromHistory/physicalDeletion。移除幂等，未更改旧 archived 记录、未增加清理任务或物理 DELETE。
- 新 /content-policy 返回明确的逻辑保留模式；个人文件来源标记原对话已移除，已存成果独立保留。用户中心加载同一保留规则。账号停用复用 IdentitySessionRepository 和 A2，不引入第二套账户/任务生命周期。
- 相邻安全修复：旧 archiveSession 只看作者与空间活跃，已移除成员仍可写。现先取 Workspace 锁并检查当前访问，再锁 Session；与 Run 创建的锁序一致。
- RED：旧代码 3 条失败（无策略路由、缺少语义字段、失权团队作者仍 200）；另 2 条（并发/目录停用）已通过。GREEN：5/5。admin、团队会话与 m5-revocation 相邻 41/41。服务端/员工端类型、定向 lint 通过。
- 账号同步测试使用合成目录事实和真实 PostgreSQL，不是实时 AI Hub/OIDC 验收。目录停用后认证 Session 撤销、访问拒绝，作者/资源不转移；真实 DSH/OIDC 未运行。
- 无新迁移。保留期限未替企业编造：null 明确为待批准策略，当前程序不自动物理删除。正式部署仍需企业确认备份/保留/审计要求。
