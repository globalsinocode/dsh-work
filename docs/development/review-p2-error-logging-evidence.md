# P2-3：HTTP 错误出口的最小化脱敏日志

## 实现位置与格式

`Router.handle()` 分类后调用 `http-error-log.ts::logHttpFailure()`，再写原 error envelope。
通过 console.error 向 stderr 输出一行 JSON（Node stdout 不会自动复制该行，部署应采集 stderr）。字段仅为：
`event=http.request.failed`、`traceId`、`method`、`path`、`status`、`code`、`message`、`responseStarted`。

- caught exception 的 traceId 与返回 envelope 完全相同；classifyHttpError 本身保持纯函数，不重复打印。
- path 使用注册路由模板（如 `/api/admin/v1/skills/:skillId/test`），不含请求参数值、query、Host、cookie 或请求体。
- 没匹配路由的 404 使用 `[unmatched]`，保留原响应 traceId；不会打印任意未知路径。
- 显式返回的错误 HttpResult 仅投影 error.code/message/已有有效 traceId，不打印其他返回内容；原响应没有 traceId 时仅生成服务端关联号，不擅自改写既有 API payload。
- headers 已发出后发生错误也写日志；status 表示分类后的错误状态，responseStarted=true 指明不能把它当作已经发出的 HTTP 状态。保留原流终止行为，不在 SSE 后追加 JSON。
- 不记录成功请求。logger 故障不能取代原错误或使响应悬挂，也不回退打印原 request/Error。

## 消息安全

对 Error 仅读取 message，不序列化 Error、cause、stack、request、headers 或 body。未预期非 Error 抛出值只记通用说明。
SyntaxError 用固定安全说明，防止 JSON.parse 在 message 内回显请求体和动态路径。
普通 message 仅保留第一行、去控制字符/ANSI、限制输出到 1024 字符；JSON片段、标记的 body/payload、认证/cookie头、URL、令牌/口令赋值经剔除或脱敏，再复用既有 redactSensitiveText。
不修改共享脱敏器，不影响 Runtime/审计/模型日志协议；不增加依赖，默认不记录任何堆栈。
本次只覆盖 Router 处理出口，不冒充进程级 unhandledRejection、OIDC callback 内自行吞掉的异常或其他服务全部日志治理。

## 红绿证据

先保留同一最终测试文件，仅恢复 P2-2 的 Router 运行：1 通过、9 失败（没有日志行）。恢复修复 Router 后，10/10 通过。
覆盖 500、409、421、JSON 422、未知404、显式错误 HttpResult、headersSent 流终止、非 Error 抛出、敏感串/嵌套 Error 附加字段、控制字符、长度上限与 logger 故障。

初次测试发现 fetch/undici 会对 421 自动重发到新连接：一个客户端 fetch 可能是两个服务端请求。单请求日志数断言改用 node:http 直连，仍严格要求每请求只记录一次，不降低断言；最终红绿日志使用同一测试文件。

原始证据随交付包：`p2-3-red-final.tap`、`p2-3-green-final.tap`。初期调试日志也保留。
服务器类型检查及变更文件 ESLint 通过；最终全轮及相邻回归清单以交付包 VALIDATION.json/原始日志为准。

## 接线与复跑

`pnpm test:review:p2:logging` 已在 server、根脚本和 CI 接线，新 server 命令含 `--env-file-if-exists=../.env`。
`pnpm test:review:p2` 聚合本轮三项，Skill 集成需要专用可丢弃 PostgreSQL。
无需迁移（0046 仍空闲）、新依赖或前端改动。合并 router.ts 时保留主线其它路由及鉴权逻辑；只叠加同一错误分类出口和模板日志投影。

## 未验收

本轮只做合成 HTTP 和隔离 PostgreSQL 工程验证。用户此前真实 P2 的成功不作为本修复后的验收；没有重跑真实 authentik/OIDC、DSH b150a55、模型或生产。实际日志采集、轮转、告警阈值应在目标部署确认；本次不加入新日志平台或自动轮转依赖。


## 相邻契约测试的既有陈旧断言

最终检查发现 api-contract 原断言把 GET /sessions 列为已经删除，期待404；批次3早已注册无数据库时返回503的入口。
恢复本轮以前的 Router 后同样失败（13项中12通过1失败，见 `api-contract-baseline-existing-failure.tap`），证明不是日志改动造成的状态变化。
仅调整该测试：其余已删除路由继续严格404，新增独立用例明确检查 GET /sessions 的503、稳定code、traceId、suggestion且没有伪造data。没有修改 workbench 路由或业务行为。
