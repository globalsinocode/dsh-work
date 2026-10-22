# 项目工作规范

按任务影响选择文档：涉及服务职责或 Agent 执行链路时读[架构总览](docs/development/overview.md)，涉及模块接口时读[内部端口与契约](docs/development/internal-ports.md)，选择本地运行或验证命令时读[开发与测试](docs/development/development.md)。纯文案和局部样式修改无需预读全部文档。

新增或调整 Agent 定义、能力依赖、发布与执行行为时，遵守[Agent 设计规范](docs/development/agent-design-standard.md)，按[通用 Agent 全生命周期模板](docs/development/agent-lifecycle-template.md)记录工作定义、扩展决策、发布与验收，并参考[当前实现差异清单](docs/development/agent-design-gap-analysis.md)区分现行约束、待实施要求与可选扩展；不得把目标设计当作已支持能力。MCP、持久化等待、记忆、委派和无 Session 入口仅在模板触发条件成立后启动，不作为所有 Agent 的默认组件。

在已授权范围内完成实现、相关验证与失败修复；只有缺少关键决策、需要扩大范围或触及明确审批边界时暂停。

## 本地开发规范

写代码、规格或实施计划时阅读 [dev-standards](docs/development/local-skills/dev-standards/SKILL.md)。该目录只约束本地开发，不是 Skill 广场候选，不打包进广场、不通过管理端导入。每次改动在 [修改记录](docs/development/修改记录.md) 最上方追加一条，写明时间、为什么、做了什么、涉及文件。分支与发版仍以下一节为准。

## 分支与合入约定

**方向**：所有代码修改只在 `dev` 上进行。`main` 只指向 `dev` 历史上已经可以上线的那个提交，发版时快进过去，不另建 release 分支。

1. **提交前先对齐 `dev`**（不允许在落后状态直接提交）：

   ```bash
   git switch dev
   git fetch origin
   git merge --ff-only origin/dev
   ```

   不能快进说明本地与远端分叉：改为 `git merge origin/dev`，冲突在本地解决完再提交。不提交带冲突标记的文件。

2. **只有 `main` 含有 `dev` 没有的提交时，才把 `main` 合并进 `dev` 一次**：

   ```bash
   git fetch origin
   git merge-base --is-ancestor origin/main HEAD || git merge origin/main
   ```

   正常快进发版之后，`main` 一直是 `dev` 的祖先，这条检查应当直接通过，不必每次提交都合并 `main`。真的要合并时，冲突在本地解决，跑类型检查与相关单测后再继续。不在 `main` 上直接改功能。

3. **发版时把 `main` 快进到 `dev`**：

   ```bash
   git switch main
   git merge --ff-only origin/main
   git merge --ff-only dev
   ```

   快进前在 `dev` 上跑完类型检查、相关单测与必要的 E2E。发布以 `main` 上的提交打 tag。快进不产生新提交，发版后不用把 `main` 再合回 `dev`。`dev` 顶端就是要上线的内容；未完成的改动不要留在顶端。

4. **保持 git 视图清晰**：

   - 一次提交只做一件事，提交信息写清「为什么」，不混入无关改动；
   - 发版提交单独一条：`chore(release): 将 releaseVersion 升到 YYYY.MM.DD-NN`，先落在 `dev`，再随快进进入 `main`；
   - 同一改动不要做成两份等价提交（cherry-pick 只用于修复历史遗留分叉，不作为常规流程）；
   - 临时分支合并进 `dev` 后删除，长期只保留 `dev` 与 `main`。共享的 `dev` / `main` 不要 rebase、不要 force push。

5. **紧急修复**：`dev` 顶端可以上线时，修复直接落在 `dev`，再快进 `main`。已上线版本要修、而 `dev` 上已有不能上线的提交时，从当前 `main` 拉一个短修复分支，修完后快进 `main` 并打 tag，再合并回 `dev` 一次，然后删除该分支。

## 本轮安全修复边界

2026-09 批次 0/1 以 [修复基线](docs/development/review-batch01.md) 为准。团队批次的 AC-23“个人空间保持现状”只约束该批次产品范围，不允许豁免共同的身份、文件来源或执行授权检查。保留个人空间的数据模型与既有受权使用，不借安全修复增加第二套 Agent Loop。

## 浏览器 E2E 工作流

员工端主导航当前固定为“新对话、Skill 广场、AI 同事、团队空间、自动任务”五个入口。“历史对话”和“我的文件”保留路由、数据能力及上下文入口，但不显示在主导航；修改壳层导航时同步更新 `e2e/TEST-CATALOG.md` 与 `e2e/personal-workbench.spec.ts`。

涉及关键用户旅程、跨页面交互、身份权限或高风险回归的前端功能，采用 **Spec → Code → Verify → Test → Green**；纯文案、局部样式或已有组件单测足以覆盖的修改不强制新增 E2E。

1. **Spec（定义验收）**：实现前先在 `e2e/TEST-CATALOG.md` 记录关键用户旅程；文件不存在时创建。每条至少写明优先级、用户角色、运行层级、前置数据、操作步骤、可观察结果及对应 spec 文件，验收标准使用业务语言，不预设尚未成型的 DOM 选择器。
2. **Code（实现功能）**：复用现有应用壳层、组件、Design Token、API 与 DSH 执行链路；不要为了测试引入生产旁路、隐藏开关或第二套 Agent 执行逻辑。
3. **Verify（浏览器预演）**：页面成型后，在与目标层级匹配且数据可识别的隔离环境中，用浏览器自动化完整走一遍旅程，检查真实交互、布局、可访问名称、加载/空/错误状态和响应式表现。预演用于发现 UX 与可测试性问题，不等同于 Playwright 已通过；若复用了现有服务，必须先确认其认证模式、数据源和 Runtime 与本次目标一致。
4. **Test（固化测试）**：预演通过后再编写或更新 Playwright。优先使用 `getByRole`、`getByLabel`、稳定文本等用户可感知定位，仅在缺少稳定语义时增加 `data-testid`；使用条件断言等待，不使用任意固定延时。测试默认彼此隔离，不跨用例共享可变页面或业务状态；多角色场景使用独立 browser context / `storageState`，并显式准备和清理测试数据。
5. **Green（分层跑绿）**：功能完成后运行相关 spec；公共导航、认证、共享 fixture 或大范围重构变化时运行全部 `pnpm test:e2e`；发布前运行完整浏览器套件。修复本次改动引起的失败，并如实记录未运行、环境阻塞或仍需真实环境验收的部分。

E2E 证据按层级区分，不相互替代：

- **P0 浏览器冒烟**：由测试专用冒烟服务（`scripts/testing/p0-smoke-server.ts`）提供测试身份和确定性内存数据，纳入 CI，证明页面可启动和核心导航/交互未断；不能证明 PostgreSQL、真实 DSH、OIDC 或生产权限。
- **P1 集成用户旅程**：使用专用可丢弃 PostgreSQL、明确的测试身份及受控 Runtime/Worker，覆盖写入、读取、失败和权限边界；不得连接开发业务库或生产库。
- **P2 真实验收**：真实 DSH 场景必须经过既有 Run/Attempt、Runtime Adapter 与 DSH 链路；真实 OIDC、多账号收权、企业连接器和生产环境行为按发布/验收流程单独执行并留证。不得用 P0 冒烟或 Mock 的绿灯宣称真实链路通过。

保留 CI 中快速、确定性的 Playwright 冒烟，不照搬“E2E 全部只在本地运行”。耗时、依赖真实身份/模型或易受外部系统波动影响的套件，应拆为明确标记的发布前或受控环境任务，而不是降低断言、静默重试或绕过认证。

## Agent 执行统一使用 DSH

- 员工对话、管理端安装助手和其他系统 Agent 均通过既有 Run/Attempt、Runtime Adapter 与 DeepSeek Harness（DSH）链路执行。
- 禁止新增第二套 Agent 执行逻辑：不得在前端、业务后端或独立服务中绕过 DSH，直接调用模型 API 实现 Agent 对话、工具调用循环或多步推理；不得引入并行的 Agent 执行框架。
- 平台负责身份、权限、业务状态、持久化、调度和受控工具；DSH 负责单次 Attempt 内的 Agent Loop。业务任务重试、恢复和工具事务不应演变成另一套模型执行循环。
- 对话安装 Skill 必须复用 DSH 驱动安装助手，下载、校验、保存版本等操作由平台工具完成。DSH 能力不足时完善现有适配链路或 DSH，不能另建执行引擎补位。
- DSH 不可用时明确报告不可用，禁止自动降级为直接调用模型的 Agent 路线。测试替身仅用于测试，不得成为生产备用执行引擎。

详细职责及评审要求以架构总览的“Agent 执行引擎统一”章节为准；新增方案、代码与文档必须遵守该约束。
