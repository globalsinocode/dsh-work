# 管理助手 Skill 安装实现与验收

交互已确认。管理助手中的 Skill 安装已接入 PostgreSQL、既有 Run/Attempt 调度器、Runtime Adapter 和 DSH；Agent 管理与运维对话尚未接入，ZIP 页仍为明确标记的交互预览。本次范围是对话安装，不代表整个 Skill 安装产品方案的所有批次已完成。

后续脚本能力见 [Skill Python 脚本执行方案](skill-python-execution-plan.md)（设计完成、待实施）。当前仍拒绝 Python 脚本，不因方案新增而改变现有支持范围。

## 使用方式

在管理助手发送已有来源，等待 DSH 调用平台工具检查包，查看真实名称、说明、文件、摘要和只读工具权限，再点击「确认安装」。安装生成平台 0.1.0 草稿；不按名称覆盖现有 Skill，也不自动发布或更新 Agent 引用。Skill 中心的包版本经真实 DSH 试运行后展示结果，管理员确认结果再发布。

支持的输入：

- 公共 HTTPS ZIP 或单个 SKILL.md 链接；默认允许 GitHub、API、codeload、raw、objects 与 release-assets 域名。其他域名由 `DSH_WORK_SKILL_SOURCE_HOSTS` 精确加入白名单，仍不能访问私网。
- `https://github.com/owner/repo/tree/ref/skill-directory`，或仓库链接。仓库解析为固定提交后获取制品；多个 Skill 时必须提供目录或指定名称。
- `npx skills add owner/repo --skill name`，支持 `skills@latest`、`skills@x.y.z` 和 `--skill=name`；粘贴文本中保留的 `skills\@latest` 也会按同一格式解析。平台仅解析此安装器和参数，通过 GitHub 适配器获取内容，不运行 npm 包或 Shell。
- `curl -L https://.../skill.zip`，支持 `-L/-f/-s/-S` 及列出的组合参数。不会执行粘贴的命令。

不支持私有凭据、带鉴权/任意查询参数的直接来源、任意安装器、管道、重定向写盘、命令组合或变量展开。无来源时由 DSH 引导补充，不生成 Skill。来源域名与每次重定向均校验，DNS 结果固定到实际连接，拒绝私网和保留地址；IPv6 下载目前关闭。

## 包与版本

- `SKILL.md` 使用 YAML frontmatter，必须声明 name、description 和正文。允许可选 version；缺少上游版本不会伪造。拒绝重复 YAML 键和别名展开。
- 首批为纯指令及 UTF-8 文本资源包：md、txt、json、yaml/yml、csv、toml、LICENSE。脚本、二进制资源、外部依赖和未适配工具明确拒绝。
- `allowed-tools` 仅适配 read/glob/grep 的固定平台版本；纯指令包可以零工具。含资源包展示并申请只读 read 工具。工具状态在预览及确认时检查。
- 下载上限 20 MB，整个 ZIP 解压上限 32 MB/2000 项，所选 Skill 上限 64 文件/1 MB。验证 UTF-8、路径、重复/冲突、ZIP 目录与本地文件名、CRC、大小、压缩格式；所选 Skill 目录不允许符号链接或特殊文件。仓库先按元数据 name 选择目标，再检查目标的工具与依赖兼容性；无关 Skill 的不兼容声明不阻断安装。运行时同样按单个 Skill 限制 64 文件/1 MB，多个合规 Skill 可组合使用。
- 包内容、文件摘要、来源与提交随安装记录保存；版本 manifest 保存不可变完整资源。员工执行和试运行都从固定版本获取资源，挂载在当前 Attempt 的 `skills/<隔离后的 Skill 目录>/`（路径与提示中的资源目录一致），只读访问并校验内容摘要。
- 已安装包不允许通过旧文本编辑 API 原地改写。旧文本 Skill 的兼容与历史发布逻辑保留；ZIP 实装、指定已有 Skill 升级以及旧文本 API 整体退出不在本次对话安装范围。

## 状态、权限及运行

管理对话使用 sessions.audience=admin，与员工会话隔离，不绑定员工空间或 Agent。API 只返回当前管理员自己的历史和记录。员工端 Session、任务、取消/重试和 SSE 入口不能进入管理运行。

每轮向 DSH 传入同一管理员会话最近 12 条消息，正文合计最多 24000 字符，历史不构成新的操作授权。管理员可回复“选择 名称”“选上一个仓库中的 名称”或“--skill 名称”，继续使用本会话最近提供的来源；新链接覆盖旧来源，普通闲聊不会自动复用安装来源。重试保留当轮上下文快照。

模型路由或 Manifest 编译在 Attempt 创建前失败时，将已创建 Run 收敛为 failed 并返回原始错误，不留下无 Attempt 的 queued 记录。

平台工具通过每个 Attempt 的受限 Unix socket 返回包预览，只处理平台已解析并固定的用户来源。模型不能传入其他 URL，不能确认安装。工具返回、取消、重试、事件和模型计量沿用 DSH 链路；没有直接调用模型的备用执行路径。未配置数据库/DSH 时明确报告不可用。

浏览器独立确认接口检查管理员当前权限、运行成功状态及预览 SHA-256，在同一数据库事务内保存 Skill、版本、安装结果和审计。重复确认返回同一结果；取消后不能确认；旧 Attempt 不能写入新 Attempt 的预览。重试保留 Run，新增不可变 Attempt。刷新和断线后通过服务端快照恢复历史、状态和待确认卡片，前端轮询运行状态，不根据助手文字判定安装成功。

## 验证入口

- `pnpm test:skill-install`：来源解析、包格式、路径/依赖/压缩限制。
- `pnpm test:skill-install:integration`：专用可丢弃 PostgreSQL，真实 ACP Adapter 搭配测试 Worker，覆盖安装事务、重复确认、跨端隔离、取消、重试及权限。
- 同一集成测试设置 `DSH_WORK_SKILL_REAL_DSH=1` 时，启动已锁定的真实 DSH，获取公共 Skill 并验证工具调用/结果回传；另验证实际 read 工具读出固定 Skill 资源标记。需要配置 `DSH_WORK_TEST_DATABASE_URL` 和既有 DSH 凭据，测试库自动清理。
- 前端交互测试覆盖真实 API 预览、摘要确认、网络失败时保留输入与幂等键、权限撤销、取消及历史恢复。

## 本次验证结果

- `pnpm ci:check` 通过，包括类型检查、运行适配器与工具策略、来源/包单测、双前端测试、API/安全/身份测试、UI 契约、lint 和构建。
- 专用 PostgreSQL 安装集成测试通过；员工运行编排与原有 Skill 生命周期回归通过。安装集成测试已加入 GitHub CI。
- 真实 DSH 获取 `web-design-guidelines` 并调用平台工具形成预览，确认草稿安装在可丢弃测试库完成。HTTPS、curl 和 npx 来源实测取得同一内容摘要；仓库固定提交为 `063bee94c3f4df8453406c830b0a7df0f2860278`。
- 真实 DSH 通过受控 read 工具读出包内固定资源标记，工具调用数为 1。
- 本地浏览器完成 npx 来源检查、查看真实确认卡、取消、刷新恢复历史。浏览器样例已取消，未向本地 Skill 中心新增样包。
- 补充迁移 0029 修复已应用早期预览迁移的本地库约束，同时保留员工会话必须关联空间的要求。

上述为本地验证记录，不代表已推送或部署。
