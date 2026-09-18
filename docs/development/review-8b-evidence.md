# 8b 场景验收证据

基线为本轮 C10 提交之后。没有修改批次3页面，没有取得用户本地 TW-10/AG-03 合并源代码。

红灯：在 8a 的原 evaluateAttemptEvidence 上运行前两个新测试：文本分支因未激活可选 Python 依赖失败；完整执行痕迹但 total=13（期望12）却通过。两个新断言均失败。日志 `8b-red.tap`。

绿灯：已注册的 test:review:8b:unit 20/20 通过；test:review:8b:integration 7/7 通过。覆盖精确 Attempt、根/依赖、指定脚本入口、JSON 断言、默认严格策略、不可变 Manifest、C9 可选 Python 降级边界；数据库覆盖场景通过不误发布全依赖、互补覆盖成功、最新同名失败、依赖漂移、独立证据策略约束和实际 HTTP 入参/权限接线。HTTP 使用显式合成身份，证据回调不执行模型或 Python，不代表真实 DSH 验收。

相邻：上一轮 review 单测65、集成14均通过；本轮 batch02 单测11、集成12通过；原安装11通过/1真实DSH跳过、Skill生命周期1、身份集成5、撤权29、故障2均通过。计数有交叉，不应相加当唯一测试数量。服务器 typecheck、静态契约、ESLint通过。命令与完整日志随补丁交付。

实现与兼容见 skill-scenario-trials.md。真实 DSH、OIDC、Python 容器、二进制业务成果验证和完整浏览器 E2E 未运行。
