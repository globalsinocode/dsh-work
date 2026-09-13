# 管理助手 Skill 安装实现与验收

交互已确认。管理助手中的 Skill 安装已接入 PostgreSQL、既有 Run/Attempt 调度器、Runtime Adapter 和 DSH；Agent 管理与运维对话尚未接入。对话来源与本地 ZIP 只在来源获取阶段不同，取得包字节后统一复用包解析、兼容性检查、依赖计划、文件夹存储和原子确认逻辑，并按“结构化计划 → 一次确认 → 原子草稿安装 → 严格试运行 → 管理员发布”执行。

脚本能力遵循 [Skill Python 脚本执行方案](skill-python-execution-plan.md)：平台可以保存受支持的 `.py` 源文件，但只有配置摘要锁定的 `DSH_WORK_PYTHON_IMAGE` 后安装计划才兼容；执行固定走无网络、只读根文件系统、资源受限的临时容器，不存在宿主机 Python 回退。

## 使用方式

在管理助手发送自然语言、已有来源或受支持命令，等待 DSH 调用平台工具检查包，查看根 Skill、同源依赖图、文件、工具、脚本要求、兼容性和计划摘要，再点击「确认安装计划」。确认会在一个事务中生成全部 0.1.0 草稿及依赖关系；不按名称覆盖现有 Skill，也不自动发布或更新 Agent 引用。根 Skill 经真实 DSH 严格试运行后，依赖图作为同一验证单元由管理员发布。

也可以在「新增 Skill」页上传本地 ZIP。浏览器将原始文件交给平台，平台解析后返回同样的结构化安装计划；管理员确认计划摘要后生成同样的 0.1.0 草稿。ZIP 上传不需要模型理解来源，因此不创建虚假的 Run/Attempt，也不绕过后续的统一安装与发布约束。

支持的输入：

- 公共 HTTPS ZIP 或单个 SKILL.md 链接；默认允许 GitHub、API、codeload、raw、objects 与 release-assets 域名。其他域名由 `DSH_WORK_SKILL_SOURCE_HOSTS` 精确加入白名单，仍不能访问私网。
- `https://github.com/owner/repo/tree/ref/skill-directory`，或仓库链接。仓库解析为固定提交后获取制品；多个 Skill 时必须提供目录或指定名称。
- `npx skills add owner/repo --skill name`，支持 `skills@latest`、`skills@x.y.z` 和 `--skill=name`；粘贴文本中保留的 `skills\@latest` 也会按同一格式解析。平台仅解析此安装器和参数，通过 GitHub 适配器获取内容，不运行 npm 包或 Shell。
- `curl -L https://.../skill.zip`，支持 `-L/-f/-s/-S` 及列出的组合参数。不会执行粘贴的命令。
- `帮我安装 owner/repo 里的 skill-name` 等明确自然语言；平台只接受唯一 GitHub `owner/repo` 和可选 Skill 名称，不让模型生成或替换来源。

不支持私有凭据、带鉴权/任意查询参数的直接来源、任意安装器、管道、重定向写盘、命令组合或变量展开。无来源时由 DSH 引导补充，不生成 Skill。来源域名与每次重定向均校验，DNS 结果固定到实际连接，拒绝私网和保留地址；IPv6 下载目前关闭。

## 包与版本

- `SKILL.md` 使用 YAML frontmatter，必须声明 name、description 和正文。允许可选 version；缺少上游版本不会伪造。拒绝重复 YAML 键和别名展开。
- 包支持纯指令、UTF-8 文本资源和 `.py` 源文件：md、txt、json、yaml/yml、csv、toml、py、LICENSE。Shell、二进制制品、运行时动态安装依赖和未适配工具不会被静默忽略，而是拒绝解析或形成不兼容计划。
- `allowed-tools` 已适配 read/glob/grep 的固定平台版本；纯指令包可以零工具。Python 包声明平台内置 `python_execute@1.0.0`，只有固定沙箱镜像可用时兼容。
- 正文中明确要求调用另一个 Skill 时，平台解析同一制品中的目标 Skill，递归生成依赖图；缺失项和循环依赖阻止确认。单次计划最多包含 32 个 Skill。
- 下载上限 20 MB，整个 ZIP 解压上限 32 MB/2000 项，所选 Skill 上限 64 文件/1 MB。验证 UTF-8、路径、重复/冲突、ZIP 目录与本地文件名、CRC、大小、压缩格式；所选 Skill 目录不允许符号链接或特殊文件。仓库先按元数据 name 选择目标，再检查目标的工具与依赖兼容性；无关 Skill 的不兼容声明不阻断安装。运行时同样按单个 Skill 限制 64 文件/1 MB，多个合规 Skill 可组合使用。
- Skill 内容统一保存为 `${DSH_WORK_DATA_ROOT}/skills/packages/<name>/<sha256>/` 下的不可变文件夹，包含 `SKILL.md`、参考资料和脚本。PostgreSQL 只保存相对目录引用、文件路径/大小/摘要、来源、计划、版本关系和业务状态，不保存文件正文或脚本源码。
- 安装记录、Skill Version 和 Runtime Manifest 都只携带同一份文件夹引用及校验索引。员工执行和试运行先收到 Skill 名称、说明与版本目录，调用 `activate_skill` 后由 Runtime Adapter 校验摘要并将目录只读暂存到 Attempt 工作区。
- 原有文本创建接口仍可使用，但保存时会生成标准 `SKILL.md` 文件夹；已安装包不允许通过文本编辑 API 原地改写。服务启动迁移会把旧版本、旧安装计划和历史 Attempt Manifest 中的正文迁出数据库；历史 Attempt 的原摘要保存在 `legacy_manifest_sha256`，迁移后的 Manifest 使用新摘要。

## 状态、权限及运行

管理对话使用 sessions.audience=admin，与员工会话隔离，不绑定员工空间或 Agent。API 只返回当前管理员自己的历史和记录。员工端 Session、任务、取消/重试和 SSE 入口不能进入管理运行。

每轮向 DSH 传入同一管理员会话最近 12 条消息，正文合计最多 24000 字符，历史不构成新的操作授权。管理员可回复“选择 名称”“选上一个仓库中的 名称”或“--skill 名称”，继续使用本会话最近提供的来源；新链接覆盖旧来源，普通闲聊不会自动复用安装来源。重试保留当轮上下文快照。

模型路由或 Manifest 编译在 Attempt 创建前失败时，将已创建 Run 收敛为 failed 并返回原始错误，不留下无 Attempt 的 queued 记录。

平台工具通过每个 Attempt 的受限 Unix socket 返回包预览，只处理平台已解析并固定的用户来源。模型不能传入其他 URL，不能确认安装。工具返回、取消、重试、事件和模型计量沿用 DSH 链路；没有直接调用模型的备用执行路径。未配置数据库/DSH 时明确报告不可用。

浏览器独立确认接口检查管理员当前权限、运行成功状态及完整计划 SHA-256，在同一数据库事务内保存根 Skill、全部依赖版本、依赖边、安装结果和审计。重复确认返回同一结果；不兼容计划、取消状态和过期摘要不能确认。刷新和断线后通过服务端快照恢复历史、状态和待确认卡片，前端不根据助手文字判定安装成功。

文件夹先以临时目录完整写入并校验，再通过 macOS 同一文件系统内的原子重命名转正。数据库事务只提交已经存在且摘要匹配的引用；内容寻址目录允许失败事务留下无引用目录，后续可按引用集合安全清理。生产备份和恢复必须把整个 `DSH_WORK_DATA_ROOT` 与 PostgreSQL 作为同一个恢复点管理。

严格试运行不再以“DSH 成功并产生一条回复”为通过条件。当前锁定的根 Skill 和全部递归依赖都必须留下 `activate_skill` 激活证据；含 Python 的 Skill 还必须留下沙箱退出码为 0 的执行证据。发布根 Skill 时，同一安装图中的依赖草稿在一个事务中同步发布，正式 Agent 随后按固定版本递归解析目录。

## 验证入口

- `pnpm --filter @dsh-work/server db:migrate:skill-files`：执行数据库结构迁移，将旧 Skill 文件、脚本和历史运行快照正文迁到 `${DSH_WORK_DATA_ROOT}/skills`，并在退出前确认数据库正文计数归零。服务正常启动时也会幂等执行同一迁移。
- `pnpm test:skill-install`：来源解析、包格式、路径/依赖/压缩限制。
- `pnpm test:skill-install:integration`：专用可丢弃 PostgreSQL，真实 ACP Adapter 搭配测试 Worker，覆盖安装事务、重复确认、跨端隔离、取消、重试及权限。
- 同一集成测试设置 `DSH_WORK_SKILL_REAL_DSH=1` 时，启动已锁定的真实 DSH，获取公共 Skill 并验证工具调用/结果回传；另验证实际 read 工具读出固定 Skill 资源标记。需要配置 `DSH_WORK_TEST_DATABASE_URL` 和既有 DSH 凭据，测试库自动清理。
- 前端交互测试覆盖真实 API 预览、摘要确认、网络失败时保留输入与幂等键、权限撤销、取消及历史恢复。

## 本次验证结果

- `pnpm ci:check` 已通过，包括服务端与双前端类型检查、Skill 包及运行时单测、双前端组件测试、API/安全/身份测试、静态契约、敏感凭据扫描、UI 契约、lint 和完整构建。
- 专用 PostgreSQL 安装集成测试通过 7 项，覆盖 ZIP 二进制 HTTP 上传、统一解析和兼容性计划、文件夹持久化、错误摘要拒绝、并发幂等确认、草稿创建及管理写权限；真实 DSH 专项用例按默认配置跳过。安装集成测试已加入 GitHub CI。
- 真实 DSH 获取 `web-design-guidelines` 并调用平台工具形成预览，确认草稿安装在可丢弃测试库完成。HTTPS、curl 和 npx 来源实测取得同一内容摘要；仓库固定提交为 `063bee94c3f4df8453406c830b0a7df0f2860278`。
- 真实 DSH 通过受控 read 工具读出包内固定资源标记，工具调用数为 1。
- 本地浏览器完成 npx 来源检查、查看真实确认卡、取消、刷新恢复历史。浏览器样例已取消，未向本地 Skill 中心新增样包。
- 补充迁移 0029 修复已应用早期预览迁移的本地库约束，同时保留员工会话必须关联空间的要求。
- 本机数据库已应用迁移 0033，允许无 Run 的 ZIP 安装记录并用 channel 约束来源；更新后的服务健康检查显示 PostgreSQL 正常、DSH 已连接。

上述为本地验证记录，不代表已推送或部署。
