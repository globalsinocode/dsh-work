# Skill 创建专家与 Skill 可见范围

设计见 [Skill 创建专家方案](../../docs/design/skill-creator-plan.md)，原型见方案页首链接。规则落地前仍以[功能规则第 5 节](../../docs/development/feature-rules.md#5-skill-安装与发布)为准。标注“待建”的 spec 文件随对应实施切片创建。

## Skill 可见范围（SC4）

### SKC-VIS-01 管理员限定 Skill 可见角色后，只有这些角色的员工能在 Skill 广场选用

**优先级：** P1 · **角色：** 平台管理员、两位不同角色的员工 · **运行层级：** 专用可丢弃 PostgreSQL、受控测试身份、真实 HTTP 接口与浏览器<br>
**前置数据：** 一个已发布、可见范围为全员的 Skill；员工甲属于“销售部”，员工乙不属于；一个固定引用该 Skill、两位员工都能使用的 Agent<br>
**spec：** `server/src/infrastructure/postgres/skill-visibility.integration.test.ts`、`e2e/personal-integration/skill-visibility.spec.ts`（待建）

1. 未设置可见范围时，两位员工的 Skill 广场都能看到该 Skill（保持现有行为）。
2. 管理员在 Skill 详情把可见范围改为“销售部”，填写原因后保存；审计记录这次修改。
3. 员工甲刷新 Skill 广场仍能看到并选用；员工乙看不到，直接按该 Skill 发起对话被拒绝并提示没有使用权限。
4. 员工甲选用该 Skill 发起对话后，管理员把员工甲移出“销售部”：员工甲在该会话再次发送时，执行前复核拒绝并说明原因。
5. 员工乙使用固定引用该 Skill 的 Agent 正常运行（Agent 固定引用不受 Skill 可见范围限制）。
6. 管理员把可见范围改回全员：员工乙重新能看到该 Skill。

**验收：** Skill 广场、会话选择与执行前复核三处口径一致；Agent 固定引用不受限；存量 Skill 默认全员，不需要迁移数据。

## Skill 创建专家

### SKC-01 员工经推荐进入 Skill 创建专家，生成草稿并自己提交审核

**优先级：** P1 · **角色：** 员工 · **运行层级：** 一次性 PostgreSQL、合成 Runtime（不调用模型）、真实 HTTP 接口与浏览器<br>
**前置数据：** 已发布并开启“可创建 Skill”的 Skill 创建专家；合成 Runtime 对含 `P1-创建Skill` 的 prompt 在工作区写出一个合法 Skill 目录并调用 `skill_draft_save`，对含 `P1-推荐同事-Skill创建` 的 prompt 推荐该专家<br>
**spec：** `e2e/personal-integration/skill-creator.spec.ts`、`apps/workbench-web/src/components/conversation/conversation-components.test.ts`

1. 员工向 dsh-work 助手说想把常用做法做成 Skill，回复下出现推荐 Skill 创建专家的卡片；点“去聊天”进入与专家的新对话，问题已预填、未发送。（合成 Runtime 以 `P1-推荐同事-Skill创建` 经推荐服务登记推荐；真实 DSH 中助手是否据专家的说明与示例问题推荐，在 `SKC-P2` 验收。推荐机制本身由 `REC-01` 覆盖。）
2. 发送后回复下方出现草稿卡片：名称、说明、文件清单（脚本单独标注）、包校验结论、可展开的 SKILL.md 预览与“提交审核”；不声称平台验证过试跑。A 工作模式与 B 单聊一致。
3. 点“提交审核”：卡片变为“待审核”，出现“撤回提交”；刷新后状态不变。
4. 点“撤回提交”：卡片回到草稿状态，可再次提交。
5. 从 Skill 广场点“创建 Skill”，进入与 Skill 创建专家的新对话，没有预填。（由 `SKC-04` 覆盖。）
6. 已有 5 条待审核提交时再提交，提示已达上限，提交不成功。（由 `SKC-03` 的集成测试覆盖。）

**验收：** 提交只能由员工在卡片上发起；状态在刷新后保持；上限生效。P0 冒烟不覆盖本条（冒烟服务不执行对话）。

### SKC-04 Skill 广场的“创建 Skill”进入 Skill 创建专家

**优先级：** P0 · **角色：** 员工 · **运行层级：** P0 冒烟服务（测试身份、内存数据）<br>
**前置数据：** 冒烟数据中一个开启“可创建 Skill”、员工角色可见的 Skill 创建专家；默认停用（不改变其他用例“只有一位 AI 同事”的前提），用例先经管理端接口启用<br>
**spec：** `e2e/personal-workbench.spec.ts`、`e2e/collab-mode.spec.ts`、`apps/workbench-web/src/views/catalog-views.test.ts`；`canCreateSkills` 取值见 `server/src/infrastructure/postgres/skill-submission.integration.test.ts`

1. A 工作模式打开 Skill 广场，分类筛选旁有“创建 Skill”。
2. 点击后进入新对话，已选中 Skill 创建专家，显示其欢迎语，输入框为空。
3. B 协作模式从头像菜单打开 Skill 广场，点“创建 Skill”进入与 Skill 创建专家的单聊，输入框为空。
4. 员工可用的 AI 同事中没有开启“可创建 Skill”的，或 AI 同事读取失败时，不显示入口，Skill 列表照常（组件单测）。

**验收：** 入口按“可创建 Skill”开关找到 Agent，不写死标识；两种模式各进入对应的新对话；不预填问题。

### SKC-02 管理员审核员工提交：看内容与试运行证据，通过时选择可见范围或填写原因拒绝

**优先级：** P1 · **角色：** 平台管理员、提交员工 · **运行层级：** 一次性 PostgreSQL、真实审核与发布门禁、合成严格试运行证据（不调用模型）、真实 HTTP 接口与浏览器<br>
**前置数据：** 两条待审核提交：一条含脚本（试运行写入激活与 Python 退出码 0 证据），一条纯指令（试运行停在运行中）<br>
**spec：** `e2e/skill-submission-review.integration.spec.ts`（`pnpm test:e2e:skill-review`）、`server/src/infrastructure/postgres/skill-submission-review.integration.test.ts`、`apps/admin-web/src/components/SkillSubmissionReviewPanel.test.ts`；P0 列表与内容查看见 `e2e/mvp-smoke.spec.ts`

1. 管理员打开 Skill 管理的“待审核”，看到两条提交，显示提交人、来源“对话创建”、是否含脚本、试运行状态与提交时间。
2. 打开含脚本的提交：可分别查看 SKILL.md 与脚本源码；未试运行时“通过并发布”不可用并说明原因。点“开始试运行”（以本人身份运行），通过后显示试运行结果。
3. 点“通过并发布”，选择“指定角色”但不勾选任何角色时不能确认；勾选一个角色后确认，提交变为已通过，Skill 出现在 Skill 列表且已发布，可见范围为所选角色；提交员工的草稿卡片显示已发布（集成测试核对）。
4. 对试运行未完成的提交，“通过并发布”不可用并说明原因；点“拒绝”，原因为空时不能确认；填写原因后确认，提交员工的草稿卡片显示拒绝原因。
5. 非管理员访问审核接口返回无权限（集成测试）。

**验收：** 未通过严格试运行不能发布；拒绝必须有原因；发布复用现有发布门禁与审计；通过前提交存下的 Skill 不进入 Skill 列表、不能从 Skill 详情直接发布；撤回或拒绝释放待发布版本。审核结论显示在提交员工的草稿卡片上，并发站内通知（只写已发布或未通过，见 NC-S3）。

### SKC-03 草稿工具的装配范围、校验与归属

**优先级：** P1 · **角色：** 员工、平台管理员 · **运行层级：** 专用可丢弃 PostgreSQL、受控测试身份<br>
**前置数据：** 开启与未开启“可创建 Skill”的 Agent 各一；一个团队空间<br>
**spec：** `server/src/modules/runtime/builtin-tools.test.ts`、`server/src/modules/runtime/runtime-adapter.test.ts`、`server/src/modules/skill/skill-submission-workspace.test.ts`、`server/src/infrastructure/postgres/skill-submission.integration.test.ts`

1. 开启开关的 Agent 在个人空间员工对话中装配 `list_available_skills` 与 `skill_draft_save`；未开启、团队空间、定时与主动任务、发布试运行、系统与管理运行不装配；Skill 声明这两个工具时安装校验报不兼容。
2. `list_available_skills` 只返回发起员工可选用的已发布 Skill 与平台内置 Skill。
3. `skill_draft_save` 按现有包规则校验：缺少 frontmatter、不支持的文件类型、超出文件数或大小、声明未安装的 Python 依赖时返回不兼容原因，草稿不能提交；与已有 Skill 或平台内置 Skill 重名时拒绝。
4. 每次保存生成新的不可变版本；提交记录归属发起员工，来源为“对话创建”，记录发起员工与执行的 Agent。
5. 其他员工不能提交、撤回或查看该草稿；被拒绝后在原会话再次保存生成新版本，可重新提交。

**验收：** 装配范围与校验和现有 Skill 安装一致，不开宽松通道；归属与来源可追溯到 Run/Attempt。

### SKC-05 新环境预置未发布的 Skill 创建专家草稿，由管理员选角色、验证后发布

**优先级：** P1 · **角色：** 平台管理员、员工 · **运行层级：** 专用可丢弃 PostgreSQL、服务启动预置<br>
**前置数据：** 已迁移、尚无开启“可创建 Skill”的 Agent 的数据库；平台管理员账号<br>
**spec：** `server/src/infrastructure/postgres/skill-creator-preset.integration.test.ts`

1. 服务启动后，Agent 列表出现“Skill 创建专家”，状态为未发布草稿：说明、欢迎语、示例问题、SOUL.md 与方案 5.1 一致，开启“可创建 Skill”，其余能力关闭，MCP 不使用；可见角色与岗位角色为空；自定义测试问题为方案 5.2 的五条。
2. 发布前员工看不到它：AI 同事列表中没有它（Skill 广场“创建 Skill”入口与推荐都取自这一列表，入口行为由 `SKC-04` 覆盖）。
3. 管理员在“角色与权限”选定可见角色与岗位角色后，验证前检查全部通过；之后的验证、判定与发布沿用 Agent 发布流程，真实环境由 `SKC-P2` 留证。
4. 再次启动服务不会重复预置；数据库中已有开启“可创建 Skill”的 Agent（不论是否发布、是否停用）时不预置；同标识但未开启该开关的 Agent 不被改动。
5. 上次只建成草稿、未写入测试问题时，下次启动补写；没有本地平台管理员时不预置并记录警告；多实例同时启动只建成一个草稿。

**验收：** 预置只产生未发布草稿，发布仍须经过该环境的真实验证与人工判定；不重复、不覆盖管理员已有的专家。

### SKC-P2 真实 DSH 下从需求到发布

**优先级：** P2 · **角色：** 员工、平台管理员 · **运行层级：** 真实 DSH Run/Attempt、Runtime Adapter、执行容器<br>
**前置数据：** 已发布的 Skill 创建专家（由 `SKC-05` 预置的草稿发布）；Skill 广场中至少一个已发布 Skill<br>
**spec：** 手工执行并留证

1. 纯指令需求（如固定格式的会议纪要）：专家先查重、问清需求，生成不含脚本的草稿，员工提交后管理员通过并发布，员工在 Skill 广场选用后运行正常。
2. 需要脚本的需求（如合并多个 Excel 计算汇总）：专家在执行容器中用示例输入试跑脚本，并确认不给输入文件时脚本也能完成自检，都通过后才保存草稿（草稿目录写在工作区根目录如 `drafts/` 下）；管理员在审核详情发起严格试运行（试运行不提供业务输入，脚本以自检通过），通过后发布。
3. 需求与已有 Skill 相符：专家引导去用现有 Skill，不新建。
4. 员工要求写入越权或外传数据的指令：专家拒绝写入并说明原因。
5. 员工对 dsh-work 助手说想创建 Skill：助手推荐 Skill 创建专家（不自己展开写 Skill），去聊天后问题已预填。

**验收：** 留存 Run/Attempt、草稿版本与审核记录；记录专家是否先查重、是否过度使用脚本的人工结论。P1 绿灯不能替代本层。
