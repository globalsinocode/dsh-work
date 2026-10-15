# P2-2：Skill 域错误类型化

## 范围与状态

仅在 Skill 模块显式抛出 `SkillError(status, code, message)`，由既有路由结构化错误分支识别；不依赖中文文案。
新增 helper 不导入 HTTP Router，不增加依赖，也不捕获所有异常后强制变成 4xx。

| 场景 | 状态 / code |
| --- | --- |
| 请求的 Skill 不存在 | 404 / skill_not_found |
| 回滚或查询的 Skill Version 不存在 | 404 / skill_version_not_found |
| 已发布无草稿，不能测试 | 409 / skill_draft_required |
| 不可停用、状态/草稿漂移、不可文本修改包 | 409 / skill_state_conflict 或 skill_package_immutable |
| 缺少测试、证据失效、Attempt 变化、场景覆盖不足 | 409 / skill_test_required、skill_test_snapshot_changed、skill_test_attempt_changed、skill_test_coverage_incomplete 等 |
| prompt 过短/空白/类型错误 | 422 / skill_test_prompt_invalid |
| 输入 id、字段类型、枚举等无效 | 422 / skill_input_invalid |
| 管理身份拒绝 | 403 / permission_denied（复用原授权错误；SQL 和授权要求不变） |
| 存储/试运行服务未接线 | 503 / skill_service_unavailable |
| 已存元数据损坏、写入结果违反不变量 | 500 / skill_internal_error，仅向客户端返回通用摘要 |
| 未预期 DB/文件系统异常 | 原异常向路由传播，保持 5xx，不转成用户错误 |

`testSkill`、`strictTestContext`、异步测试与进度、setStatus、rollback、updateSkill/配置校验均明确分类。
依赖/版本检查与所有业务通过条件不变；仅补齐原来会触发 TypeError/SQL 参数错误的 JSON 字段检查。
进度链路在安装服务内只类型化“试运行缺失/类型不匹配/版本变化”；未扩大到链接导入或其他非 Skill 模块。
已有 scenario-v1、attempt-v2、安全检查、发布门槛和 DSH 运行方式不变。
路由补充 typed 404 和 typed 500（当前可读基线的白名单没有 404），typed 500 不回传内部 message。

## 红绿证据

先在 P2-1 提交上运行同一份 15 项 PostgreSQL/真实 HTTP 回归：2 通过，13 失败。
无草稿真实返回 500；missing Skill 和短 prompt 在该基线可能被中文正则碰巧映射成 404/422，但 code 仍为泛化值、Service 本身无 status/code；红用例检查了这一区别，不声称它们全是 500。

实现后同一 15 项通过，另补 1 项缺少严格执行器的 503 HTTP 回归，以及 6 项文案独立、内部 500 隐藏、循环依赖单测：总计 22/22。
相邻 m4-skill-management、admin-skill-installation、review-8a、review-8b、review-c7-link 集成共 37 通过、1 条真实 DSH 用例跳过。
服务器类型检查、变更文件 ESLint、contracts 静态检查通过。原始运行日志包括原安装套件的已有终态转换告警，未降低断言或隐藏日志。

交付包原始证据：`p2-2-red.tap`、`p2-2-green-final.tap`、`p2-2-adjacent.tap`、`p2-2-typecheck-final.log`、`p2-2-lint.log`、`p2-2-contracts.log`。

## 接线与复跑

`pnpm test:review:p2:skill:unit` 与 `pnpm test:review:p2:skill:integration` 均在根脚本、server/package.json 和 CI 接线；新 server 脚本带 `--env-file-if-exists=../.env`。
集成必须设置 `DSH_WORK_TEST_DATABASE_URL` 为可丢弃测试库，使用项目已有 helper 建库、迁移和销毁。
本地使用 Node 22.19.0 + PostgreSQL 17.11 + 锁定离线依赖运行相同脚本串。
OpenAPI 更新仅覆盖 Skill 路由错误响应，API payload 与 envelope 不变；部分原泛化 code 改为稳定 Skill code，客户端应依据 status/code，不靠 message 正则。

## 未验收

无数据库迁移、新依赖、授权 SQL 修改或 DSH 旁路。未重跑真实 DSH、authentik/OIDC 或生产；用户先前完成的 P2 不作为本次变更验证证据。用户本地 TW-10/AG-03 合并树仍需其本地回归。
