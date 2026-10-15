# C7：确定性链接导入与草稿发布边界

## 实现边界

`parseSkillLink` 接受单个无凭据/查询参数的获准 HTTPS 地址及可选 Skill 名称，不接受命令、自然语言或客户端指定 channel/resolvedRef。`prepareLink` 调用同一 `acquireSkillSource`（GitHub 固定提交、域名/逐跳重定向校验、DNS 公网检查并固定实际连接），再复用 `prepareBundle` / 文件夹存储 / `installPlan`；没有 Session、Run、Worker 或模型调用。HTTP 断开与总超时传播 AbortSignal，来源获取后和事务内再次检查管理员资格。

保存前固定包、依赖、摘要、resolved URL/ref；确认仅消费保存的内容，不重新下载。`confirmDirect` 在事务中复核当前管理员、本人计划、原摘要、兼容性和工具政策，再原子保存草稿；重复确认只使用同一个结果。`confirmZip` 保持 ZIP-only 服务契约，旧 HTTP 路径兼容 ZIP 和 link，channel 只读数据库。新增 GET 用于刷新当前阻塞原因，DELETE 只取消 pending 计划，已安装返回 409，不删除版本。

## 安装可用与执行可用分开

仅 link 计划允许 Python 沙箱/声明的 Python 包暂未就绪时以 needs_review 保存源码草稿；并非 resolved/compatible。未知或已禁用工具、不允许的写工具、未发布工具版本、缺失 Skill、循环依赖、Shell/特殊文件等仍阻止安装。注册工具的连接器暂不健康可以保存草稿，执行仍走原 require-healthy 检查。

安装响应中的 `canPublish=false` 描述“本次导入不执行发布”，不覆盖去重复用的已发布版本状态；`canSaveDraft` 和 `publicationBlockers` 在服务端计算。DSH 检查不可用或未接线均阻断发布，工具/Python 状态明确显示，不以存在镜像配置冒充可用。

`PostgresSkillService.publishDraft` 在锁定根草稿后检查发布闭包中是否有 link 来源草稿（包含安装账本记载的去重复用旧草稿，不只检查 manifest 标记）；有则必须通过注入的当前 DSH/Python 可用检查，并校验当前配置的 Python 依赖名称，之后仍需精确 Attempt/配置/依赖证据和场景覆盖。避免借助 ZIP 父包间接发布离线的 link 依赖。主入口只调用现有 Runtime 端口的能力检查和健康投影，不调用模型或建立备用引擎。修复环境后按 C9 重启预检，再完成试运行和明确发布；保存草稿不自动变为可用。

## 迁移和兼容

仅新增 `0045_direct_link_skill_installation.sql`，扩展 channel CHECK 为 assistant/zip/link；assistant 有 Run、zip/link 无 Run 的约束保留。没有重命名已应用 0042/0043/0044，没有移动数据、覆盖旧版本或物理清理。旧前端可以忽略增量响应字段，新 UI 在 ZIP 旁提供链接入口，保留管理助手作为可选入口。部署先迁移/后端、再前端；回退旧应用时隐藏链接新入口并保留新行，不能用旧发布实现宣称同样的安全保证。

C7 未改员工导航、个人文件、团队共享会话、自动化目的分支、admin requireSession 或 Adapter。

## 可重复证据

固定 Node 22.19.0、PostgreSQL 17.11 和可丢弃合成测试数据库。`review-c7-link.integration.test.ts` 核心前三项在旧基线为 3 失败：缺少 prepareLink/confirmDirect，HTTP 返回 404。最终专属 14 项 PostgreSQL/HTTP 用例通过，来源/包政策 4 项单元通过。前端两条新增旅程在旧组件因没有链接入口失败；新组件 10 项（含原 5 条 ZIP 回归）通过。详见交付 evidence/c7-red.tap、c7-green.tap、c7-unit.tap、c7-frontend-red.log、c7-frontend-green.log。

合成下载器用于字节固定、版本和事务验证，不访问真实外网；发布用例显式写入 SYNTHETIC 的 Attempt 证据验证领域判据，不声称运行 DSH。另有现有域名/重定向次数和公网地址拒绝测试，但不是生产 DNS/防火墙演练。

覆盖：无需 Run 的离线保存、Python 待验证、未知来源/凭据拒绝、跨用户和只读角色拒绝、下载中取消/停用回滚、摘要冲突、并发幂等、先保存后拒绝取消、真实注册工具连接器不健康、预览后工具停用、无测试不能发布、已有测试但运行时故障仍不可发布、依赖闭包不能旁路、相同内容去重、新版本不覆盖活动版本、channel 数据库约束。

新命令 `test:review:c7:unit`、`test:review:c7:integration` 接入服务器/根脚本及 CI。前端通过现有组件套件接入。完整套件执行结果与退出码另见交付 VALIDATION.json；不存在用远程 CI 或顶层 pnpm 门禁冒充本地通过。

## 未验证

浏览器被 Chromium 管理策略以 ERR_BLOCKED_BY_ADMINISTRATOR 阻断；未解除策略或降低断言，预演/新增 Playwright 旅程保持未完成。真实 DSH、OIDC、企业下载代理/DNS、Python 镜像、目标主机及生产发布均未运行，必须单独验收。
