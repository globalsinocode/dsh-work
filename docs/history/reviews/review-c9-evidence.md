# C9 能力级故障隔离

基线为上一轮四补丁 + admin 会话修复，不包含不可获取的 TW-10/AG-03 源码。无数据库迁移。

红灯：真实启动 server/src/main.ts，指定可丢弃 PostgreSQL、显式 prototype 测试身份、不存在的 DSH 目录及无效 Python 镜像。旧代码在监听前退出，历史下载/核心就绪用例失败。DB/身份错误负向用例原本通过。

绿灯：启动/下载/503/恢复队列 3 项全部通过；启动与运行故障/A2 相邻集成 8 项通过；能力端口/ACP 受控 Worker/当前授权/HTTP 错误测试共 53 项通过。tsc --noEmit 与 ESLint 通过（以补丁包日志为准）。

实现保留现有 Runtime Adapter、权限回调、取消、调度与不可变 Attempt，不改 adapter setup 或任何 purpose 分支。新增 negative port 没有 Worker、模型、回答或成功事件；Python 失败不影响无 Python 依赖的任务。DB/身份初始化仍阻断监听，运行期间 DB 不可用返回非就绪。恢复排队任务记录 RUNTIME_UNAVAILABLE，不在 disabled/draining 队列空转。

健康契约已更新。执行配置修复后重启再预检；发布脚本严格预检未移除。没有运行真实 OIDC、DSH、Docker/Python 容器、AG-03 定时任务或目标服务器演练；prototype HTTP 测试只证明合成身份下的工程边界，不是生产认证验收。
