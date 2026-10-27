# Agency 专家全量包（dsh-work）

将 [dsh-agency-agents](https://github.com/MichengAI/dsh-agency-agents) **中文名册 331 位**专家转换为 `dsh-work.ai/v2` Agent 草稿包，供管理端 ZIP 导入。不是 DSH 插件，不包含 `summon_expert` / 专家团。

## 路径

| 内容 | 位置 |
| --- | --- |
| 单个专家包 | `docs/development/fixtures/agency-agents/<id>/` |
| 索引 | [`SOURCE.json`](SOURCE.json)（`expertCount: 331`） |
| 共享片段 | [`_shared/`](_shared/) |
| 上游拉取缓存（可删可重建） | `_cache/raw/` |
| 导入 ZIP | `dist/agency-agent-packages/<id>.zip` |
| 跨设备安装说明 | [`../../agency-agents-install-handoff.md`](../../agency-agents-install-handoff.md) |
| 能力缺口 | [`../../agency-agents-pilot-gaps.md`](../../agency-agents-pilot-gaps.md) |

## 命令

```bash
# 从 GitHub 固定 commit 重新生成（需网络）
pnpm convert:agency-agents

# 打成 ZIP
pnpm package:agency-agents

# 校验全部包可解析
pnpm test:agency-agent-fixtures
```

## 包结构

每个 `<id>` 目录含：`agent.yaml`、`SOUL.md`、`AGENTS.md`、`evals/cases.yaml`。不声明 `spec.capabilities`；工具由平台默认装配。

上游钉扎见 `SOURCE.json` 的 `commit` 字段。
