# Skill 场景试运行（8b）

本增量复用现有 Run/Attempt、Runtime Adapter 和 DSH；不增加模型调用链、执行器或员工页面。未提供场景的客户端继续使用原完整严格试运行。真实模型、脚本计算与业务成果仍需环境验收。

## 请求

现有 `POST /api/admin/v1/skills/test-runs`（异步）与 `POST /api/admin/v1/skills/test`（同步）接受可选 `scenario`。示例中的 Skill ID 和版本必须替换为当前草稿及锁定依赖的真实引用：

```json
{
  "skillId": "skill-example",
  "prompt": "根据本次固定样例返回严格 JSON，total 为计算结果。",
  "scenario": {
    "id": "text-case",
    "requiredSkills": ["skill-example@0.1.0"],
    "requiredPythonEntries": [],
    "assertions": [
      {"kind": "reply_json_equals", "path": ["total"], "expected": 12}
    ]
  }
}
```

Python 场景通过 `requiredPythonEntries: [{"skill":"skill-calculation@0.1.0","entry":"scripts/calc.py"}]` 指定入口。入口必须存在于本次锁定目录；对应 Skill 激活自动成为必需项。根 Skill 始终必需，不因 requiredSkills 传空而跳过。

支持 `reply_contains` 的字面包含判断和 `reply_json_equals` 的严格 JSON 标量判断；数字不与字符串等同，代码块或附带解释不是严格 JSON。禁止自定义代码、正则表达式和不在锁定目录中的脚本。断言最多 32 个、路径最多 8 段，能力与 Python 入口各最多 64 个。场景只约束验证，不扩展 Tool Allowlist、模型数据出口或执行权限。

## 不变性、证据与发布

场景在启动时规范化并保存为不可变 Manifest 的 `test_scenario`；重试完整复制 Manifest。查询进度时不接受新的场景定义。激活、声明脚本入口与提交回答都只取当前 Attempt；错误业务断言会让运行成功但验证失败。

无断言的通过仅标记为“执行验证”。有断言也只说明指定样例的断言通过，不等于已证明业务整体正确。首版不支持二进制成果内容断言或任意脚本校验器；有此需求仍需人工/真实环境验收。

场景通过记录使用 `scenario-v1`，与旧 `attempt-v2` 完整严格证据分开。发布时若没有有效的完整严格测试，则聚合同一根版本、同一配置和完整依赖内容摘要下的场景证据，覆盖所有锁定 Skill，以及每个包含 Python 的 Skill 至少一个声明入口。某一个文本场景通过不会顺带发布未验证的 Python 依赖。这里证明能力覆盖，不声称每个脚本或所有业务分支都已穷尽。

同名场景采用最新保存的测试结果；最新失败不借用较早通过。发布事务重新核对 Run 当前 Attempt、配置绑定、依赖版本和实际证据。草稿或依赖变化要求重测。已有完整严格证据仍按原规则使用，不因增加场景功能而失效。

## 兼容与验证

仅增加 `0043_skill_scenario_evidence.sql` 的新约束；旧记录不改写。旧代码发布路径不接受 `scenario-v1`，回滚后可能要求重新做完整严格测试，但不会把部分场景当成全量验收。新增迁移若与更晚主线编号冲突，应在应用前调整本新增文件序号，不覆盖任何已应用迁移。

`pnpm test:review:8b:unit`、`pnpm test:review:8b:integration` 已接入根脚本与 CI。集成测试使用可丢弃 PostgreSQL、明确合成身份与合成试运行证据；原 Skill 安装套件另外覆盖受控 ACP Worker。真实 DSH、Python 容器与实际样例未运行。
