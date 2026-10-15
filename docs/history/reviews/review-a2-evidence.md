# A2：个人执行前与在途授权修复

基线：3015d241，依赖 A1。新增当前执行授权测试、PostgreSQL 回归、个人 SSE 与受控 ACP Worker 用例，接入服务器 `test:review:*` 和 CI。

修复前：使用未修复的 RunOrchestrationService，在数据库领取队列后停用用户；同一专项用例失败，Runtime 调用次数实际为 1，预期为 0。

修复后：3/3 PostgreSQL 专项通过；当前授权/DSH Adapter/Tool Policy 单测与受控 ACP Worker 共 51/51 通过；相邻编排、撤权、故障和 SSE 共 43/43 通过；服务器 TypeScript 与变更文件 ESLint 通过。环境为 Node 22.19.0、PostgreSQL 17.11 一次性库。

实现：所有生产任务在出队与恢复后按当前身份、固定 Agent/Skill、数据范围、会话归属和 A1 固定文件复核；个人空间不再豁免。生产 Runtime 注入同一授权方法；已有本地 Tool Bridge 增加仅供策略调用的授权探针，DSH 每次工具调用前复核，平台工具返回与最终回答交付前复核。运行中有不重叠的 2 秒生命周期检查；单次 Runtime 授权检查 5 秒超时，终态不回退。个人 SSE 在交付下一批前检查当前工作台/空间权限。撤权与检查故障分别记录 AUTHORIZATION_REVOKED / AUTHORIZATION_CHECK_UNAVAILABLE，用户取消与服务关闭保留原语义。

兼容：原有隔离编排测试的可选领域端口契约未新增环境绕过开关；生产 main.ts 始终注入真实授权，并在 Runtime 边界强制调用。同版本与同输入快照不改写；无数据库迁移。旧撤权测试夹具补入缺失的 input/skills/data_scopes，而非放宽生产清单校验。

未验收：真实 DSH Profile 执行新版 tools/pre-execute 探针、真实身份平台撤权传播、目标主机容器资源回收、备份恢复。不能收回已发送给模型或用户的数据；目标是停止后续读取、工具调用和交付。禁止把受控 ACP Worker 结果称为真实 DSH 业务验收。
