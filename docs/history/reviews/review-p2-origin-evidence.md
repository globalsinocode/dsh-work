# P2-1：请求入口 421 错误分类

## 范围与实现

仅调整 `server/src/http/router.ts` 的已知结构化错误状态白名单及 421 suggestion。
`resolveRequestOrigin`、`requestOrigin`、Host/转发头白名单、CSRF、OIDC 以及 DSH 执行逻辑不变。
HTTP 回归直接走 `registerOidcRoutes → OidcAuthService.beginLogin` 的真实入口校验，拒绝发生在数据库与 Provider 调用之前；不使用真实 OIDC/模型。

## 红绿证据

在批次 0–4 恢复后的基线（文件树 `785a44dfa8e32fb06ae2db96340a14d0516a3f8a`）先添加同一测试运行：
- `review-p2-origin.test.ts`：1 通过，3 失败。
- admin/workbench 非允许后端入口返回 500，而非期望的 421。
- 非法 forwarded protocol 返回 422（被中文正则误判），而非期望的 421。
- 原 CSRF 拒绝仍为 403。

修复后：同一 4 项全部通过，包含 `unknown_request_origin`/`invalid_request_origin`、非空 suggestion、traceId 及禁止重定向的断言。
与 `router-error-experience.test.ts`、`identity.test.ts`、`bootstrap-scope.test.ts` 合并运行共 30 项通过，0 失败；服务器 TypeScript noEmit 检查通过。
原始日志随交付包保存：`p2-1-red.tap`、`p2-1-green-adjacent.tap`、`p2-1-typecheck.log`。

## 接线与复跑

`pnpm test:review:p2:origin` 已接入根脚本、server/package.json 与 CI。
新 server 命令保留 `--env-file-if-exists=../.env`；不改写既有测试命令，合并冲突时保留本地主线的 env-file 旗标。
本地执行使用离线锁定依赖与 Node 22.19.0 的同一命令串，不宣称远端 CI/顶层 pnpm ci:check 已运行。

## 兼容与验收边界

无新依赖、无迁移；错误 envelope 字段不变，仅修正状态和 suggestion。
坏 Origin header 的 CSRF 403 与未知请求入口的 421 不混为一谈。
用户已报告其真实 P2 链路通过；本修复没有重跑真实 authentik/OIDC、DSH、模型或生产部署。TW-10/AG-03 本地合并树不在此基线中，未宣称验证。
