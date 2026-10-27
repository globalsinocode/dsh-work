# Skill 广场候选 — 待验证草稿导入说明

本目录下的 `packages/<id>/` 为从固定 commit 拉取的单技能文件树，**不是**已发布到员工 Skill 广场的状态。

## 生成步骤

在仓库根目录执行：

```bash
node server/scripts/expand-skill-plaza-source.mjs
node server/scripts/fetch-skill-plaza-candidates.mjs
node server/scripts/package-skill-plaza-candidates.mjs
node --experimental-strip-types server/scripts/verify-skill-plaza-candidates.mjs
```

或使用 `pnpm --filter @dsh-work/server` 下对应 npm scripts（见 `server/package.json`）。

## 管理端安装

批准后按 [skill-installation-plan.md](../../../design/skill-installation-plan.md) 上传 `dist/skill-plaza-packages/<id>.zip`，保存为**待验证版本**；试运行通过且更新 `PUBLISH-ALLOWLIST.json` 后，再由管理员发布。

## 机器可读状态

- `IMPORT-DRAFTS.json`：fetch 脚本写入的逐包状态
- `VERIFICATION-REPORT.md` / `PUBLISH-ALLOWLIST.json`：verify 脚本输出（默认 `publish: false`）
